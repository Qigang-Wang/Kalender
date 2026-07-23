import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";
import { AiProviderError } from "./ai-provider-validation";

export interface StoredAiConversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly preview?: string;
}

export interface StoredAiChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly modelId?: string;
  readonly status: "complete" | "partial";
  readonly createdAt: string;
}

export interface StoredAiRun {
  readonly id: string;
  readonly conversationId: string;
  readonly featureKey: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly attemptCount: number;
  readonly usedFallback: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: StoredAiChatMessage["role"];
  content: { text?: unknown } | string;
  model_id: string | null;
  status: StoredAiChatMessage["status"];
  created_at: string;
}

interface RunRow {
  id: string;
  conversation_id: string;
  feature_key: string;
  provider_id: string | null;
  model_id: string | null;
  status: StoredAiRun["status"];
  attempt_count: number;
  used_fallback: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
}

export async function listAiConversations(): Promise<readonly StoredAiConversation[]> {
  const database = await getDatabase();
  const result = await database.query<ConversationRow>(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id)::integer AS message_count,
            (SELECT left(COALESCE(m2.content->>'text', ''), 180)
               FROM ai_messages m2 WHERE m2.conversation_id = c.id
               ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS preview
       FROM ai_conversations c
       LEFT JOIN ai_messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC`,
  );
  return result.rows.map(mapConversation);
}

export async function getAiConversation(id: string): Promise<StoredAiConversation | undefined> {
  const database = await getDatabase();
  const result = await database.query<ConversationRow>(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id)::integer AS message_count,
            (SELECT left(COALESCE(m2.content->>'text', ''), 180)
               FROM ai_messages m2 WHERE m2.conversation_id = c.id
               ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS preview
       FROM ai_conversations c
       LEFT JOIN ai_messages m ON m.conversation_id = c.id
      WHERE c.id = $1
      GROUP BY c.id LIMIT 1`, [id],
  );
  return result.rows[0] ? mapConversation(result.rows[0]) : undefined;
}

export async function createAiConversation(firstPrompt: string): Promise<StoredAiConversation> {
  const database = await getDatabase();
  const id = randomUUID();
  await database.query(
    "INSERT INTO ai_conversations (id, title) VALUES ($1, $2)",
    [id, conversationTitle(firstPrompt)],
  );
  return (await getAiConversation(id))!;
}

export async function requireAiConversation(id: string): Promise<StoredAiConversation> {
  const conversation = await getAiConversation(id);
  if (!conversation) throw new AiProviderError("AI 会话不存在", "AI_CONVERSATION_NOT_FOUND", 404);
  return conversation;
}

export async function listAiChatMessages(conversationId: string): Promise<readonly StoredAiChatMessage[]> {
  const database = await getDatabase();
  const result = await database.query<MessageRow>(
    `SELECT id, conversation_id, role, content, model_id, status, created_at
       FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId],
  );
  return result.rows.map(mapMessage);
}

export async function saveAiChatMessage(input: {
  readonly id?: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly modelId?: string;
  readonly status?: "complete" | "partial";
}): Promise<StoredAiChatMessage> {
  const database = await getDatabase();
  const id = input.id ?? randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO ai_messages (id, conversation_id, role, content, model_id, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, input.conversationId, input.role, JSON.stringify({ text: input.text }),
        input.modelId ?? null, input.status ?? "complete"],
    );
    await transaction.query("UPDATE ai_conversations SET updated_at = now() WHERE id = $1", [input.conversationId]);
  });
  const result = await database.query<MessageRow>(
    `SELECT id, conversation_id, role, content, model_id, status, created_at
       FROM ai_messages WHERE id = $1 LIMIT 1`, [id],
  );
  if (!result.rows[0]) throw new AiProviderError("无法保存 AI 消息", "AI_MESSAGE_SAVE_FAILED", 500);
  return mapMessage(result.rows[0]);
}

export async function deleteAiConversation(id: string): Promise<boolean> {
  const database = await getDatabase();
  const result = await database.query("DELETE FROM ai_conversations WHERE id = $1", [id]);
  return (result.affectedRows ?? 0) > 0;
}

export async function createAiRun(input: {
  readonly conversationId: string;
  readonly featureKey: string;
  readonly providerId: string;
  readonly modelId: string;
}): Promise<StoredAiRun> {
  const database = await getDatabase();
  const id = randomUUID();
  await database.query(
    `INSERT INTO ai_runs (id, conversation_id, feature_key, provider_id, model_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.conversationId, input.featureKey, input.providerId, input.modelId],
  );
  return (await getAiRun(id))!;
}

export async function updateAiRun(id: string, input: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly attemptCount?: number;
  readonly usedFallback?: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
  readonly errorCode?: string;
}): Promise<StoredAiRun | undefined> {
  const database = await getDatabase();
  await database.query(
    `UPDATE ai_runs SET
       provider_id = COALESCE($2, provider_id), model_id = COALESCE($3, model_id),
       status = $4, attempt_count = COALESCE($5, attempt_count),
       used_fallback = COALESCE($6, used_fallback), prompt_tokens = $7,
       completion_tokens = $8, latency_ms = $9, error_code = $10,
       finished_at = CASE WHEN $4 = 'running' THEN NULL ELSE now() END
     WHERE id = $1`,
    [id, input.providerId ?? null, input.modelId ?? null, input.status,
      input.attemptCount ?? null, input.usedFallback ?? null, input.promptTokens ?? null,
      input.completionTokens ?? null, input.latencyMs ?? null, input.errorCode ?? null],
  );
  return getAiRun(id);
}

export async function getAiRun(id: string): Promise<StoredAiRun | undefined> {
  const database = await getDatabase();
  const result = await database.query<RunRow>(
    `SELECT id, conversation_id, feature_key, provider_id, model_id, status,
            attempt_count, used_fallback, prompt_tokens, completion_tokens,
            latency_ms, error_code, created_at, finished_at
       FROM ai_runs WHERE id = $1 LIMIT 1`, [id],
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

function mapConversation(row: ConversationRow): StoredAiConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count),
    preview: row.preview || undefined,
  };
}

function mapMessage(row: MessageRow): StoredAiChatMessage {
  const content = typeof row.content === "string" ? JSON.parse(row.content) as { text?: unknown } : row.content;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    text: typeof content.text === "string" ? content.text : "",
    modelId: row.model_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapRun(row: RunRow): StoredAiRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    featureKey: row.feature_key,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    usedFallback: row.used_fallback,
    promptTokens: row.prompt_tokens ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function conversationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 48)}…` : compact || "新对话";
}
