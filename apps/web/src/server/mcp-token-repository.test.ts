import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-mcp-token-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const auth = await import("./auth");
  const tokens = await import("./mcp-token-repository");
  const { closeDatabaseForRestore, getDatabase } = await import("./database");
  try {
    const admin = await auth.createInitialAdmin({
      displayName: "MCP Administrator",
      username: "mcp-admin",
      password: "mcp-admin-password",
    });
    const writer = await auth.createManagedAppUser(admin, {
      displayName: "MCP Writer",
      username: "mcp-writer",
      password: "mcp-writer-password",
      role: "user",
    });
    const viewer = await auth.createManagedAppUser(admin, {
      displayName: "MCP Viewer",
      username: "mcp-viewer",
      password: "mcp-viewer-password",
      role: "viewer",
    });
    const created = await tokens.createMcpToken(admin, { name: " Primary MCP token ", scopes: ["dayline:read", "dayline:write"] });
    assert(created.name === "Primary MCP token", "created MCP token retains its trimmed user-visible name");
    assert(created.secret.startsWith("dln_"), "created MCP token uses the opaque Dayline prefix");
    assert(Buffer.from(created.secret.slice("dln_".length), "base64url").length === 32, "created MCP token contains 32 random bytes");
    assert(created.scopes.includes("dayline:read") && created.scopes.includes("dayline:write"), "created MCP token retains requested stable scopes");

    const database = await getDatabase();
    const stored = await database.query<{ token_hash: string; name: string; display_hint: string }>(
      "SELECT token_hash, name, display_hint FROM mcp_api_tokens WHERE id = $1", [created.id],
    );
    assert(stored.rows[0]?.token_hash.length === 64, "only a SHA-256 token hash is stored");
    assert(stored.rows[0]?.name === created.name, "token name is persisted with its metadata");
    assert(!stored.rows[0]?.token_hash.includes(created.secret) && !stored.rows[0]?.display_hint.includes(created.secret), "raw token is absent from token storage");
    const createAudit = await database.query<{ metadata: string; user_agent: string | null }>(
      "SELECT metadata::text AS metadata, user_agent FROM app_audit_events WHERE action = 'mcp-token.create' ORDER BY created_at DESC LIMIT 1",
    );
    assert(!createAudit.rows[0]?.metadata.includes(created.secret), "MCP token audit metadata never stores the raw secret");
    assert(createAudit.rows[0]?.metadata.includes(created.name), "MCP token audit records safe token metadata, including its name");
    assert(createAudit.rows[0]?.user_agent === null, "MCP token lifecycle audit does not copy request headers");

    const listed = await tokens.listMcpTokens(admin);
    assert(listed.some((token) => token.id === created.id && token.name === created.name), "owners can list their named MCP tokens");
    assert(!Object.hasOwn(listed.find((token) => token.id === created.id)!, "secret"), "token lists never expose the raw secret");
    assert((await tokens.listMcpTokens(writer)).length === 0, "MCP token lists are self-only");
    let foreignRevokeRejected = false;
    try {
      await tokens.revokeMcpToken(writer, created.id);
    } catch (error) {
      foreignRevokeRejected = error instanceof tokens.McpTokenError && error.status === 404;
    }
    assert(foreignRevokeRejected, "users cannot revoke another user's MCP token");

    const authenticated = await tokens.authenticateMcpToken(created.secret, { requiredScope: "dayline:write", ipAddress: "198.51.100.11" });
    assert(authenticated.userId === admin.id && authenticated.scopes.includes("dayline:write"), "active tokens authenticate their owner and scopes");
    const used = await database.query<{ last_used_at: string | null }>("SELECT last_used_at FROM mcp_api_tokens WHERE id = $1", [created.id]);
    assert(Boolean(used.rows[0]?.last_used_at), "successful token authentication updates last used time");

    const fixedMinute = new Date("2031-04-05T12:34:20.000Z");
    const expiredBucketMinute = new Date("2031-04-04T12:33:00.000Z");
    await database.query(
      `INSERT INTO mcp_token_rate_buckets (token_id, minute_started_at, request_count)
       VALUES ($1, $2, 7)`,
      [created.id, expiredBucketMinute.toISOString()],
    );
    await database.query(
      `INSERT INTO mcp_invalid_token_ip_buckets (ip_address, minute_started_at, request_count)
       VALUES ($1, $2, 7)`,
      ["198.51.100.99", expiredBucketMinute.toISOString()],
    );
    const rateResults = await Promise.all(Array.from({ length: 8 }, () => (
      tokens.consumeMcpTokenRateLimit(created.id, 2, fixedMinute, database)
    )));
    assert(rateResults.filter((entry) => entry.allowed).length === 2, "per-token fixed-minute limiting is atomic under concurrent requests");
    assert(rateResults.some((entry) => !entry.allowed && entry.retryAt === "2031-04-05T12:35:00.000Z" && entry.retryAfterSeconds === 40), "rate limits return retry metadata");
    const validBucketCleanup = await database.query<{ old_count: number; current_count: number }>(
      `SELECT count(*) FILTER (WHERE minute_started_at = $2::timestamptz)::integer AS old_count,
              count(*) FILTER (WHERE minute_started_at = date_trunc('minute', $3::timestamptz))::integer AS current_count
         FROM mcp_token_rate_buckets
        WHERE token_id = $1`,
      [created.id, expiredBucketMinute.toISOString(), fixedMinute.toISOString()],
    );
    assert(validBucketCleanup.rows[0]?.old_count === 0 && validBucketCleanup.rows[0]?.current_count === 1, "expired token buckets are removed without affecting the current atomic bucket");
    await tokens.consumeInvalidMcpTokenIpRateLimit("198.51.100.99", 2, fixedMinute, database);
    const invalidBucketCleanup = await database.query<{ old_count: number; current_count: number }>(
      `SELECT count(*) FILTER (WHERE minute_started_at = $2::timestamptz)::integer AS old_count,
              count(*) FILTER (WHERE minute_started_at = date_trunc('minute', $3::timestamptz))::integer AS current_count
         FROM mcp_invalid_token_ip_buckets
        WHERE ip_address = $1`,
      ["198.51.100.99", expiredBucketMinute.toISOString(), fixedMinute.toISOString()],
    );
    assert(invalidBucketCleanup.rows[0]?.old_count === 0 && invalidBucketCleanup.rows[0]?.current_count === 1, "expired invalid-token/IP buckets are removed without affecting the current bucket");
    const retainedTokenAndAudit = await database.query<{ token_count: number; audit_count: number }>(
      `SELECT (SELECT count(*)::integer FROM mcp_api_tokens WHERE id = $1) AS token_count,
              (SELECT count(*)::integer FROM app_audit_events WHERE action = 'mcp-token.create') AS audit_count`,
      [created.id],
    );
    assert(retainedTokenAndAudit.rows[0]?.token_count === 1 && (retainedTokenAndAudit.rows[0]?.audit_count ?? 0) > 0, "bucket cleanup never deletes tokens or audit records");

    let blankNameRejected = false;
    try {
      await tokens.createMcpToken(admin, { name: "   " });
    } catch (error) {
      blankNameRejected = error instanceof tokens.McpTokenError && error.status === 400;
    }
    assert(blankNameRejected, "token creation requires a non-blank user-visible name");
    const internalDefaultName = await tokens.createMcpToken(admin);
    assert(internalDefaultName.name === tokens.DEFAULT_MCP_TOKEN_NAME, "internal token callers receive a safe default name");

    let writeWithoutReadRejected = false;
    try {
      await tokens.createMcpToken(writer, { name: "Invalid write token", scopes: ["dayline:write"] });
    } catch (error) {
      writeWithoutReadRejected = error instanceof tokens.McpTokenError && error.status === 400;
    }
    assert(writeWithoutReadRejected, "read scope is mandatory for every MCP token");
    let viewerWriteRejected = false;
    try {
      await tokens.createMcpToken(viewer, { name: "Viewer write token", scopes: ["dayline:read", "dayline:write"] });
    } catch (error) {
      viewerWriteRejected = error instanceof tokens.McpTokenError && error.status === 403;
    }
    assert(viewerWriteRejected, "viewer accounts cannot receive write scope");
    const viewerToken = await tokens.createMcpToken(viewer, { name: "Viewer read token" });
    assert((await tokens.authenticateMcpToken(viewerToken.secret, { requiredScope: "dayline:read" })).userId === viewer.id, "viewer read tokens remain valid");
    const demotedUser = await auth.createManagedAppUser(admin, {
      displayName: "Demoted MCP User",
      username: "mcp-demoted",
      password: "mcp-demoted-password",
      role: "user",
    });
    const preDemotionWriteToken = await tokens.createMcpToken(demotedUser, { name: "Demotion test token", scopes: ["dayline:read", "dayline:write"] });
    await auth.updateManagedAppUser(admin, demotedUser.id, { role: "viewer" });
    let demotedWriteRejected = false;
    try {
      await tokens.authenticateMcpToken(preDemotionWriteToken.secret, { requiredScope: "dayline:write" });
    } catch (error) {
      demotedWriteRejected = error instanceof tokens.McpTokenError && error.status === 403;
    }
    assert(demotedWriteRejected, "a role change to viewer cannot retain MCP write capability");

    const expiring = await tokens.createMcpToken(writer, { name: "Expiring token", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await database.query("UPDATE mcp_api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [expiring.id]);
    await assertInvalidToken(tokens.authenticateMcpToken(expiring.secret, { ipAddress: "198.51.100.12" }), tokens, "expired tokens are rejected");
    await auth.updateManagedAppUser(admin, writer.id, { disabled: true });
    const disabledToken = await tokens.createMcpToken(admin, { name: "Disabled account token" });
    await database.query("UPDATE mcp_api_tokens SET user_id = $1 WHERE id = $2", [writer.id, disabledToken.id]);
    await assertInvalidToken(tokens.authenticateMcpToken(disabledToken.secret, { ipAddress: "198.51.100.13" }), tokens, "disabled-user tokens are rejected");

    const revoked = await tokens.revokeMcpToken(admin, created.id);
    assert(Boolean(revoked.revokedAt) && revoked.name === created.name, "owners can revoke their own named MCP tokens");
    await assertInvalidToken(tokens.authenticateMcpToken(created.secret, { ipAddress: "198.51.100.14" }), tokens, "revoked tokens are rejected");
    const revokeAudit = await database.query<{ metadata: string }>(
      "SELECT metadata::text AS metadata FROM app_audit_events WHERE action = 'mcp-token.revoke' ORDER BY created_at DESC LIMIT 1",
    );
    assert(!revokeAudit.rows[0]?.metadata.includes(created.secret), "revoke audit metadata never stores the raw secret");

    await assertInvalidToken(tokens.authenticateMcpToken("dln_invalid", { ipAddress: "203.0.113.5", invalidTokenRateLimit: 2 }), tokens, "unknown tokens are rejected");
    await assertInvalidToken(tokens.authenticateMcpToken("dln_invalid", { ipAddress: "203.0.113.5", invalidTokenRateLimit: 2 }), tokens, "invalid token attempts are tracked per IP");
    let invalidRateLimited = false;
    try {
      await tokens.authenticateMcpToken("dln_invalid", { ipAddress: "203.0.113.5", invalidTokenRateLimit: 2 });
    } catch (error) {
      invalidRateLimited = error instanceof tokens.McpTokenError && error.status === 429 && !error.rateLimit?.allowed;
    }
    assert(invalidRateLimited, "invalid-token/IP limiting is durable and reports rate metadata");
    const invalidBucket = await database.query<{ request_count: number }>(
      "SELECT request_count FROM mcp_invalid_token_ip_buckets WHERE ip_address = $1", ["203.0.113.5"],
    );
    assert(invalidBucket.rows[0]?.request_count === 2, "invalid-token/IP bucket does not exceed its fixed-minute limit");

    console.log("MCP token lifecycle, security, audit, and durable rate-limit tests passed");
  } finally {
    await closeDatabaseForRestore().catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
}

async function assertInvalidToken(
  operation: Promise<unknown>,
  tokens: typeof import("./mcp-token-repository"),
  message: string,
): Promise<void> {
  let rejected = false;
  try {
    await operation;
  } catch (error) {
    rejected = error instanceof tokens.McpTokenError && error.status === 401;
  }
  assert(rejected, message);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
