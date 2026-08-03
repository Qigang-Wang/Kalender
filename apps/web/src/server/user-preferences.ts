import { createHash } from "node:crypto";

import { getDatabase } from "./database";

export interface UserPreference {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

interface UserPreferenceRow {
  readonly preference_key: string;
  readonly preference_value: unknown;
  readonly updated_at: string | Date;
}

const MAX_KEY_LENGTH = 120;

export async function listUserPreferences(
  userId: string,
  keys: readonly string[],
): Promise<Readonly<Record<string, unknown>>> {
  const normalizedKeys = normalizePreferenceKeys(keys);
  if (!normalizedKeys.length) return {};
  const database = await getDatabase();
  const result = await database.query<UserPreferenceRow>(
    `SELECT preference_key, preference_value, updated_at
       FROM user_preferences
      WHERE user_id = $1 AND preference_key = ANY($2::text[])`,
    [userId, normalizedKeys],
  );
  return Object.fromEntries(result.rows.map((row) => [row.preference_key, row.preference_value]));
}

export async function saveUserPreference(
  userId: string,
  key: string,
  value: unknown,
): Promise<UserPreference> {
  const [normalizedKey] = normalizePreferenceKeys([key]);
  if (!normalizedKey) throw new UserPreferenceError("偏好键无效");
  if (!isJsonObject(value)) throw new UserPreferenceError("偏好内容无效");
  const database = await getDatabase();
  const id = preferenceId(userId, normalizedKey);
  const result = await database.query<UserPreferenceRow>(
    `INSERT INTO user_preferences (id, user_id, preference_key, preference_value, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (user_id, preference_key) DO UPDATE SET
       preference_value = EXCLUDED.preference_value,
       updated_at = now()
     RETURNING preference_key, preference_value, updated_at`,
    [id, userId, normalizedKey, JSON.stringify(value)],
  );
  const row = result.rows[0];
  if (!row) throw new UserPreferenceError("无法保存偏好", 500);
  return {
    key: row.preference_key,
    value: row.preference_value,
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

export class UserPreferenceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UserPreferenceError";
  }
}

function normalizePreferenceKeys(keys: readonly string[]): readonly string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter((key) => (
    key.length > 0 && key.length <= MAX_KEY_LENGTH
  ))));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function preferenceId(userId: string, key: string): string {
  return `pref:${createHash("sha256").update(`${userId}:${key}`).digest("hex").slice(0, 48)}`;
}

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
