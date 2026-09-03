import { createHash, randomUUID } from "node:crypto";

import type { AppUser } from "./auth";
import { getDatabase } from "./database";

declare global {
  var kalenderMcpWriteCleanupTimer: ReturnType<typeof setInterval> | undefined;
}

export class McpWriteSafetyError extends Error {
  constructor(readonly code: "idempotency_conflict" | "operation_in_progress" | "operation_outcome_unknown" | "version_conflict", message: string) {
    super(message);
    this.name = "McpWriteSafetyError";
  }
}

export interface McpWriteOptions {
  readonly idempotencyKey?: unknown;
  readonly preview?: unknown;
  readonly expectedUpdatedAt?: unknown;
  readonly requireIdempotency?: boolean;
}

interface ActionEventRow {
  readonly id: string;
  readonly action: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly input: unknown;
  readonly result: unknown;
  readonly error_message: string | null;
}

export const MCP_WRITE_RESULT_RETENTION_HOURS = 24;
export const MCP_WRITE_RUNNING_TIMEOUT_MINUTES = 10;
const MCP_WRITE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const UNKNOWN_OUTCOME_MARKER = "MCP operation outcome unknown after timeout";

export async function executeMcpWrite<T, Preview = T>(
  actor: AppUser,
  operation: string,
  input: Readonly<Record<string, unknown>>,
  options: McpWriteOptions,
  perform: () => Promise<T>,
  preview?: () => Promise<Preview> | Preview,
): Promise<T | Preview> {
  if (options.preview === true) return (preview ?? perform)();
  if (options.idempotencyKey === undefined && !options.requireIdempotency) return perform();
  const idempotencyKey = requiredIdempotencyKey(options.idempotencyKey);
  const normalizedInput = stableJson(normalizeInput(input));
  const fingerprint = createInputFingerprint(normalizedInput);
  const database = await getDatabase();
  ensureMcpWriteCleanupTimer();
  await cleanupMcpWriteEvents(database);
  const eventId = randomUUID();
  const inserted = await database.query<{ id: string }>(
    `INSERT INTO ai_action_events (
       id, actor_user_id, action, status, risk, idempotency_key, input
     ) VALUES ($1,$2,$3,'running','local-write',$4,$5::jsonb)
     ON CONFLICT (actor_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING RETURNING id`,
    [eventId, actor.id, operation, idempotencyKey, JSON.stringify(fingerprint)],
  );
  if (!inserted.rows[0]) {
    const existing = await database.query<ActionEventRow>(
      `SELECT id, action, status, input, result, error_message
         FROM ai_action_events
        WHERE actor_user_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [actor.id, idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row || row.action !== operation || !inputMatchesFingerprint(row.input, normalizedInput)) {
      throw new McpWriteSafetyError("idempotency_conflict", "幂等键已用于不同的操作或输入");
    }
    if (row.status === "running") throw new McpWriteSafetyError("operation_in_progress", "相同操作仍在执行中");
    if (row.status === "succeeded") return row.result as T;
    if (row.error_message === UNKNOWN_OUTCOME_MARKER) {
      throw new McpWriteSafetyError("operation_outcome_unknown", "此前操作可能已经完成，请核对业务对象后使用新的幂等键");
    }
    throw new McpWriteSafetyError("idempotency_conflict", "此前使用该幂等键的操作未成功完成");
  }
  try {
    const result = await perform();
    await database.query(
      "UPDATE ai_action_events SET status = 'succeeded', result = $2::jsonb, finished_at = now() WHERE id = $1",
      [eventId, JSON.stringify(result)],
    );
    return result;
  } catch (error) {
    await database.query(
      "UPDATE ai_action_events SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1",
      [eventId, safeFailureMarker(error)],
    );
    throw error;
  }
}

function ensureMcpWriteCleanupTimer(): void {
  if (globalThis.kalenderMcpWriteCleanupTimer) return;
  const timer = setInterval(() => {
    void getDatabase().then(cleanupMcpWriteEvents).catch(() => undefined);
  }, MCP_WRITE_CLEANUP_INTERVAL_MS);
  timer.unref();
  globalThis.kalenderMcpWriteCleanupTimer = timer;
}

async function cleanupMcpWriteEvents(database: Awaited<ReturnType<typeof getDatabase>>): Promise<void> {
  await database.query(
    `UPDATE ai_action_events
        SET status = 'failed', error_message = $1, result = '{}'::jsonb, finished_at = now()
      WHERE action LIKE 'dayline\\_%' ESCAPE '\\'
        AND status = 'running'
        AND created_at < now() - $2::interval`,
    [UNKNOWN_OUTCOME_MARKER, `${MCP_WRITE_RUNNING_TIMEOUT_MINUTES} minutes`],
  );
  await database.query(
    `DELETE FROM ai_action_events
      WHERE action LIKE 'dayline\\_%' ESCAPE '\\'
        AND status <> 'running'
        AND created_at < now() - $1::interval`,
    [`${MCP_WRITE_RESULT_RETENTION_HOURS} hours`],
  );
}

function createInputFingerprint(normalizedInput: string): { readonly algorithm: "sha256"; readonly salt: string; readonly digest: string } {
  const salt = randomUUID();
  return { algorithm: "sha256", salt, digest: hashInput(salt, normalizedInput) };
}

function inputMatchesFingerprint(stored: unknown, normalizedInput: string): boolean {
  if (stored && typeof stored === "object") {
    const candidate = stored as { algorithm?: unknown; salt?: unknown; digest?: unknown };
    if (candidate.algorithm === "sha256" && typeof candidate.salt === "string" && typeof candidate.digest === "string") {
      return hashInput(candidate.salt, normalizedInput) === candidate.digest;
    }
  }
  return stableJson(stored) === normalizedInput;
}

function hashInput(salt: string, normalizedInput: string): string {
  return createHash("sha256").update(salt).update("\0").update(normalizedInput).digest("hex");
}

function safeFailureMarker(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 80)
    : undefined;
  return code ? `MCP write failed (${code})` : "MCP write failed";
}

export function assertExpectedUpdatedAt(current: { readonly updatedAt: string } | undefined, value: unknown): void {
  if (!current) return;
  if (typeof value !== "string" || !value || current.updatedAt !== value) {
    throw new McpWriteSafetyError("version_conflict", "对象已被更新，请读取最新版本后重试");
  }
}

export function requiredIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 160) {
    throw new McpWriteSafetyError("idempotency_conflict", "idempotencyKey 必须为 16–160 个字符");
  }
  return value;
}

export function normalizeInput(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { idempotencyKey: _key, preview: _preview, requireIdempotency: _required, ...operationInput } = input;
  return operationInput;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
