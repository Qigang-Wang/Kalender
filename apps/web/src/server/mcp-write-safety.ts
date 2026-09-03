import { randomUUID } from "node:crypto";

import type { AppUser } from "./auth";
import { getDatabase } from "./database";

export class McpWriteSafetyError extends Error {
  constructor(readonly code: "idempotency_conflict" | "operation_in_progress" | "version_conflict", message: string) {
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
}

/**
 * A small, domain-neutral write envelope.  It deliberately records the
 * normalized operation input, which makes a key safe across every MCP write
 * tool rather than only within a single table.
 */
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
  const fingerprint = stableJson(normalizeInput(input));
  const database = await getDatabase();
  const eventId = randomUUID();
  const inserted = await database.query<{ id: string }>(
    `INSERT INTO ai_action_events (
       id, actor_user_id, action, status, risk, idempotency_key, input
     ) VALUES ($1,$2,$3,'running','local-write',$4,$5::jsonb)
     ON CONFLICT (actor_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING RETURNING id`,
    [eventId, actor.id, operation, idempotencyKey, fingerprint],
  );
  if (!inserted.rows[0]) {
    const existing = await database.query<ActionEventRow>(
      `SELECT id, action, status, input, result
         FROM ai_action_events
        WHERE actor_user_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [actor.id, idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row || row.action !== operation || stableJson(row.input) !== fingerprint) {
      throw new McpWriteSafetyError("idempotency_conflict", "幂等键已用于不同的操作或输入");
    }
    if (row.status === "running") throw new McpWriteSafetyError("operation_in_progress", "相同操作仍在执行中");
    if (row.status === "succeeded") return row.result as T;
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
      [eventId, error instanceof Error ? error.message : "MCP write failed"],
    );
    throw error;
  }
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
