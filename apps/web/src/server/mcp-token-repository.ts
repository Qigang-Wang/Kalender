import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AuthError, recordAuditEvent, type AppUser } from "./auth";
import { getDatabase, type DatabaseExecutor } from "./database";

export const mcpTokenScopes = ["dayline:read", "dayline:write"] as const;
export type McpTokenScope = (typeof mcpTokenScopes)[number];
export const MCP_TOKEN_PREFIX = "dln_";
export const DEFAULT_MCP_TOKEN_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_INVALID_MCP_TOKEN_REQUESTS_PER_MINUTE = 20;
export const DEFAULT_MCP_TOKEN_NAME = "MCP 客户端";
export const MCP_TOKEN_RATE_BUCKET_RETENTION_HOURS = 24;

export interface McpApiToken {
  readonly id: string;
  readonly name: string;
  readonly displayHint: string;
  readonly scopes: readonly McpTokenScope[];
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
}

export interface CreatedMcpApiToken extends McpApiToken {
  /** The opaque credential is returned only by createMcpToken and is never persisted. */
  readonly secret: string;
}

export interface AuthenticatedMcpToken {
  readonly tokenId: string;
  readonly userId: string;
  readonly role: AppUser["role"];
  readonly scopes: readonly McpTokenScope[];
  readonly rateLimit: McpTokenRateLimitResult;
}

export interface McpTokenRateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly count: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly retryAt: string;
}

export class McpTokenError extends Error {
  constructor(message: string, readonly status = 400, readonly rateLimit?: McpTokenRateLimitResult) {
    super(message);
    this.name = "McpTokenError";
  }
}

interface McpTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly display_hint: string;
  readonly scopes: string[];
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
  readonly created_at: string;
  readonly role?: AppUser["role"];
  readonly disabled_at?: string | null;
}

interface RateBucketRow {
  readonly request_count: number | string;
  readonly minute_started_at: string;
}

interface TransactionalDatabaseExecutor extends DatabaseExecutor {
  transaction<T>(callback: (transaction: DatabaseExecutor) => Promise<T>): Promise<T>;
}

export async function createMcpToken(actor: AppUser, input: {
  readonly name?: string;
  readonly scopes?: readonly McpTokenScope[];
  readonly expiresAt?: string;
} = {}): Promise<CreatedMcpApiToken> {
  const name = normalizeName(input.name);
  const scopes = normalizeScopes(input.scopes);
  if (actor.role === "viewer" && scopes.includes("dayline:write")) {
    throw new McpTokenError("只读用户不能创建写入权限令牌", 403);
  }
  const expiresAt = parseExpiry(input.expiresAt);
  const secret = generateMcpTokenSecret();
  const database = await getDatabase();
  const result = await database.query<McpTokenRow>(
    `INSERT INTO mcp_api_tokens (id, user_id, token_hash, name, display_hint, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::timestamptz)
     RETURNING id, user_id, name, display_hint, scopes, expires_at, revoked_at, last_used_at, created_at`,
    [randomUUID(), actor.id, hashMcpToken(secret), name, displayHint(secret), scopes, expiresAt],
  );
  const token = rowToMcpToken(result.rows[0]!);
  await recordAuditEvent({
    actorUserId: actor.id,
    targetUserId: actor.id,
    action: "mcp-token.create",
    metadata: { tokenId: token.id, name: token.name, scopes: token.scopes, expiresAt: token.expiresAt ?? null },
  }, database);
  return { ...token, secret };
}

export async function listMcpTokens(actor: AppUser): Promise<readonly McpApiToken[]> {
  const database = await getDatabase();
  const result = await database.query<McpTokenRow>(
    `SELECT id, user_id, name, display_hint, scopes, expires_at, revoked_at, last_used_at, created_at
       FROM mcp_api_tokens
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [actor.id],
  );
  return result.rows.map(rowToMcpToken);
}

export async function revokeMcpToken(actor: AppUser, tokenId: string): Promise<McpApiToken> {
  if (!tokenId.trim()) throw new McpTokenError("MCP API 令牌不存在", 404);
  const database = await getDatabase();
  const result = await database.query<McpTokenRow>(
    `UPDATE mcp_api_tokens
        SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, name, display_hint, scopes, expires_at, revoked_at, last_used_at, created_at`,
    [tokenId, actor.id],
  );
  const row = result.rows[0];
  if (!row) throw new McpTokenError("MCP API 令牌不存在", 404);
  const token = rowToMcpToken(row);
  await recordAuditEvent({
    actorUserId: actor.id,
    targetUserId: actor.id,
    action: "mcp-token.revoke",
    metadata: { tokenId: token.id },
  }, database);
  return token;
}

/**
 * Protocol adapters call this with the supplied bearer token. It validates token
 * lifecycle and account state, enforces a durable per-token minute bucket, and
 * updates last-used only after an authorized request is accepted.
 */
export async function authenticateMcpToken(secret: string, input: {
  readonly requiredScope?: McpTokenScope;
  readonly ipAddress?: string;
  readonly rateLimit?: number;
  readonly invalidTokenRateLimit?: number;
  readonly now?: Date;
} = {}): Promise<AuthenticatedMcpToken> {
  const database = await getDatabase();
  const now = input.now ?? new Date();
  const result = await database.query<McpTokenRow>(
    `SELECT token.id, token.user_id, token.name, token.display_hint, token.scopes, token.expires_at,
            token.revoked_at, token.last_used_at, token.created_at, user_account.role, user_account.disabled_at
       FROM mcp_api_tokens token
       JOIN app_users user_account ON user_account.id = token.user_id
      WHERE token.token_hash = $1
      LIMIT 1`,
    [hashMcpToken(secret)],
  );
  const row = result.rows[0];
  if (!row || !isActiveTokenRow(row, now)) {
    const rateLimit = await consumeInvalidMcpTokenIpRateLimit(input.ipAddress, input.invalidTokenRateLimit, now, database);
    if (!rateLimit.allowed) throw new McpTokenError("无效 MCP API 令牌请求过多", 429, rateLimit);
    throw new McpTokenError("MCP API 令牌无效或已过期", 401);
  }
  const scopes = asScopes(row.scopes);
  if (input.requiredScope && !scopes.includes(input.requiredScope)) {
    throw new McpTokenError("MCP API 令牌缺少所需权限", 403);
  }
  if (input.requiredScope === "dayline:write" && row.role === "viewer") {
    throw new McpTokenError("只读用户不能使用 MCP API 写入权限", 403);
  }
  const rateLimit = await consumeMcpTokenRateLimit(row.id, input.rateLimit, now, database);
  if (!rateLimit.allowed) throw new McpTokenError("MCP API 令牌请求过多", 429, rateLimit);
  await database.query(
    "UPDATE mcp_api_tokens SET last_used_at = now(), updated_at = now() WHERE id = $1",
    [row.id],
  );
  return { tokenId: row.id, userId: row.user_id, role: row.role!, scopes, rateLimit };
}

export async function consumeMcpTokenRateLimit(
  tokenId: string,
  limit = DEFAULT_MCP_TOKEN_REQUESTS_PER_MINUTE,
  now = new Date(),
  databaseInput?: TransactionalDatabaseExecutor,
): Promise<McpTokenRateLimitResult> {
  const database = databaseInput ?? await getDatabase();
  return consumeMinuteBucket(database, "mcp_token_rate_buckets", "token_id", tokenId, limit, now);
}

export async function consumeInvalidMcpTokenIpRateLimit(
  ipAddress: string | undefined,
  limit = DEFAULT_INVALID_MCP_TOKEN_REQUESTS_PER_MINUTE,
  now = new Date(),
  databaseInput?: TransactionalDatabaseExecutor,
): Promise<McpTokenRateLimitResult> {
  const database = databaseInput ?? await getDatabase();
  return consumeMinuteBucket(database, "mcp_invalid_token_ip_buckets", "ip_address", normalizedIpAddress(ipAddress), limit, now);
}

function generateMcpTokenSecret(): string {
  return `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hashMcpToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function displayHint(secret: string): string {
  return `${MCP_TOKEN_PREFIX}…${secret.slice(-4)}`;
}

function normalizeName(value: string | undefined): string {
  if (value === undefined) return DEFAULT_MCP_TOKEN_NAME;
  const name = value.trim();
  if (!name) throw new McpTokenError("MCP API 令牌名称不能为空", 400);
  if (name.length > 80) throw new McpTokenError("MCP API 令牌名称不能超过 80 个字符", 400);
  return name;
}

function normalizeScopes(scopesInput: readonly McpTokenScope[] | undefined): McpTokenScope[] {
  const scopes = [...new Set<McpTokenScope>(scopesInput ?? ["dayline:read"])];
  if (!scopes.includes("dayline:read") || scopes.some((scope) => !mcpTokenScopes.includes(scope))) {
    throw new McpTokenError("MCP API 令牌权限无效", 400);
  }
  return mcpTokenScopes.filter((scope) => scopes.includes(scope));
}

function asScopes(scopes: readonly string[]): readonly McpTokenScope[] {
  return mcpTokenScopes.filter((scope) => scopes.includes(scope));
}

function parseExpiry(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new McpTokenError("MCP API 令牌过期时间必须晚于当前时间", 400);
  }
  return expiry.toISOString();
}

function rowToMcpToken(row: McpTokenRow): McpApiToken {
  return {
    id: row.id,
    name: row.name,
    displayHint: row.display_hint,
    scopes: asScopes(row.scopes),
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
  };
}

function isActiveTokenRow(row: McpTokenRow, now: Date): boolean {
  return !row.revoked_at
    && !row.disabled_at
    && (!row.expires_at || new Date(row.expires_at).getTime() > now.getTime());
}

async function consumeMinuteBucket(
  database: TransactionalDatabaseExecutor,
  table: "mcp_token_rate_buckets" | "mcp_invalid_token_ip_buckets",
  key: "token_id" | "ip_address",
  value: string,
  limitInput: number,
  now: Date,
): Promise<McpTokenRateLimitResult> {
  const limit = normalizeRateLimit(limitInput);
  const timestamp = validNow(now);
  return database.transaction(async (transaction) => {
    await deleteExpiredMinuteBuckets(transaction, table, timestamp);
    return consumeCurrentMinuteBucket(transaction, table, key, value, limit, timestamp);
  });
}

async function consumeCurrentMinuteBucket(
  database: DatabaseExecutor,
  table: "mcp_token_rate_buckets" | "mcp_invalid_token_ip_buckets",
  key: "token_id" | "ip_address",
  value: string,
  limit: number,
  timestamp: Date,
): Promise<McpTokenRateLimitResult> {
  const inserted = await database.query<RateBucketRow>(
    `INSERT INTO ${table} (${key}, minute_started_at, request_count)
     VALUES ($1, date_trunc('minute', $2::timestamptz), 1)
     ON CONFLICT (${key}, minute_started_at) DO UPDATE
       SET request_count = ${table}.request_count + 1
       WHERE ${table}.request_count < $3
     RETURNING request_count, minute_started_at`,
    [value, timestamp.toISOString(), limit],
  );
  if (inserted.rows[0]) return rateLimitResult(Number(inserted.rows[0].request_count), limit, timestamp);
  const current = await database.query<RateBucketRow>(
    `SELECT request_count, minute_started_at
       FROM ${table}
      WHERE ${key} = $1 AND minute_started_at = date_trunc('minute', $2::timestamptz)`,
    [value, timestamp.toISOString()],
  );
  return rateLimitResult(Number(current.rows[0]?.request_count ?? limit), limit, timestamp, false);
}

async function deleteExpiredMinuteBuckets(
  database: DatabaseExecutor,
  table: "mcp_token_rate_buckets" | "mcp_invalid_token_ip_buckets",
  now: Date,
): Promise<void> {
  await database.query(
    `DELETE FROM ${table}
      WHERE minute_started_at < date_trunc('minute', $1::timestamptz) - ($2::integer * interval '1 hour')`,
    [now.toISOString(), MCP_TOKEN_RATE_BUCKET_RETENTION_HOURS],
  );
}

function rateLimitResult(count: number, limit: number, now: Date, allowed = count <= limit): McpTokenRateLimitResult {
  const retryAt = new Date(now.getTime());
  retryAt.setUTCSeconds(0, 0);
  retryAt.setUTCMinutes(retryAt.getUTCMinutes() + 1);
  return {
    allowed,
    limit,
    count,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)),
    retryAt: retryAt.toISOString(),
  };
}

function normalizeRateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new McpTokenError("MCP API 令牌速率限制无效", 400);
  }
  return limit;
}

function validNow(now: Date): Date {
  if (Number.isNaN(now.getTime())) throw new McpTokenError("MCP API 令牌请求时间无效", 400);
  return now;
}

function normalizedIpAddress(ipAddress: string | undefined): string {
  const value = ipAddress?.trim() || "unknown";
  return value.slice(0, 128);
}
