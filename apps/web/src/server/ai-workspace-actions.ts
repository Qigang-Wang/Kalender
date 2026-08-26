import { randomUUID } from "node:crypto";

import { recordAuditEvent, type AppUser, type AppUserRole } from "./auth";
import { getDatabase } from "./database";
import { appendJobLog, type AppJob } from "./job-service";
import { performMailMessageAction, type MailMessageAction } from "./mail-message-actions";
import { sendMailDraft } from "./mail-send-service";
import { searchWorkspace, type WorkspaceSearchKind } from "./workspace-search";

export type AiWorkspaceAction =
  | "workspace.search"
  | "task.create"
  | "task.update-status"
  | "note.create"
  | "calendar.create-event"
  | "mail.message-action"
  | "mail.send-draft";

export type AiActionRisk = "read" | "local-write" | "external-write" | "destructive";

export class AiActionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AiActionError";
  }
}

export async function getAiActionSettings(actor: AppUser): Promise<{
  readonly autoExecutionEnabled: boolean;
  readonly highRiskAutoEnabled: boolean;
}> {
  const database = await getDatabase();
  const result = await database.query<{ auto_execution_enabled: boolean; high_risk_auto_enabled: boolean }>(
    `SELECT auto_execution_enabled, high_risk_auto_enabled
       FROM ai_action_settings WHERE user_id = $1 LIMIT 1`,
    [actor.id],
  );
  return {
    autoExecutionEnabled: Boolean(result.rows[0]?.auto_execution_enabled),
    highRiskAutoEnabled: Boolean(result.rows[0]?.high_risk_auto_enabled),
  };
}

export async function saveAiActionSettings(actor: AppUser, input: {
  readonly autoExecutionEnabled: boolean;
  readonly highRiskAutoEnabled: boolean;
}): Promise<Awaited<ReturnType<typeof getAiActionSettings>>> {
  if (actor.role === "viewer") throw new AiActionError("只读用户不能启用 AI 自动执行", 403);
  const database = await getDatabase();
  await database.query(
    `INSERT INTO ai_action_settings (user_id, auto_execution_enabled, high_risk_auto_enabled, updated_by_user_id)
     VALUES ($1, $2, $3, $1)
     ON CONFLICT (user_id) DO UPDATE SET
       auto_execution_enabled = EXCLUDED.auto_execution_enabled,
       high_risk_auto_enabled = EXCLUDED.high_risk_auto_enabled,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()`,
    [actor.id, input.autoExecutionEnabled, input.highRiskAutoEnabled],
  );
  await recordAuditEvent({
    actorUserId: actor.id,
    targetUserId: actor.id,
    action: "ai.settings.update",
    metadata: input,
  });
  return getAiActionSettings(actor);
}

export async function runAiWorkspaceAction(actor: AppUser, action: AiWorkspaceAction, input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const risk = actionRisk(action, input);
  await assertAiActionAllowed(actor, risk);
  const database = await getDatabase();
  const eventId = randomUUID();
  await database.query(
    `INSERT INTO ai_action_events (id, actor_user_id, action, status, risk, target_kind, target_id, idempotency_key, input)
     VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8::jsonb)`,
    [eventId, actor.id, action, risk, targetKind(action), stringInput(input.targetId), stringInput(input.idempotencyKey), JSON.stringify(redactActionInput(input))],
  );
  try {
    const result = await executeAction(actor, action, input);
    await database.query(
      `UPDATE ai_action_events SET status = 'succeeded', result = $2::jsonb, finished_at = now() WHERE id = $1`,
      [eventId, JSON.stringify(result)],
    );
    await recordAuditEvent({
      actorUserId: actor.id,
      targetUserId: actor.id,
      action: `ai.action.${action}`,
      metadata: { risk, result },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "AI 动作失败";
    await database.query(
      `UPDATE ai_action_events SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1`,
      [eventId, message],
    );
    throw error;
  }
}

export async function runAiActionJob(job: AppJob): Promise<Readonly<Record<string, unknown>>> {
  const actorId = typeof job.payload.actorUserId === "string" ? job.payload.actorUserId : job.userId;
  if (!actorId) throw new AiActionError("AI 动作缺少用户");
  const actor = await loadActor(actorId);
  const action = parseAction(job.payload.action);
  const input = job.payload.input && typeof job.payload.input === "object" && !Array.isArray(job.payload.input)
    ? job.payload.input as Record<string, unknown>
    : {};
  await appendJobLog(job.id, `AI 执行动作：${action}`);
  return runAiWorkspaceAction(actor, action, input);
}

async function executeAction(actor: AppUser, action: AiWorkspaceAction, input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const database = await getDatabase();
  if (action === "workspace.search") {
    const query = requiredString(input.query, "搜索内容");
    const results = await searchWorkspace(query, { kind: searchKind(stringInput(input.kind)), limit: 8 });
    return { results: results.slice(0, 8) };
  }
  if (action === "task.create") {
    const id = randomUUID();
    await database.query(
      `INSERT INTO tasks (id, user_id, title, notes, status, important, urgency_mode, due_at, project_id, project_name, area_name)
       VALUES ($1, $2, $3, $4, $5, $6, 'auto', $7, $8, $9, $10)`,
      [
        id,
        actor.id,
        requiredString(input.title, "任务标题").slice(0, 240),
        stringInput(input.notes) ?? "",
        safeTaskStatus(input.status),
        input.important === true,
        dateInput(input.dueAt),
        stringInput(input.projectId),
        stringInput(input.projectName),
        stringInput(input.areaName),
      ],
    );
    return { taskId: id, href: `/tasks?task=${encodeURIComponent(id)}` };
  }
  if (action === "task.update-status") {
    const taskId = requiredString(input.taskId, "任务");
    const status = safeTaskStatus(input.status);
    const result = await database.query(
      `UPDATE tasks SET status = $3, completed_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END, updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [taskId, actor.id, status],
    );
    if (!result.affectedRows) throw new AiActionError("任务不存在或无权修改", 404);
    return { taskId, status };
  }
  if (action === "note.create") {
    const id = randomUUID();
    await database.query(
      `INSERT INTO notes (id, user_id, project_id, title, content, note_type, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, actor.id, stringInput(input.projectId), requiredString(input.title, "笔记标题").slice(0, 240), stringInput(input.content) ?? "", safeNoteType(input.noteType), input.pinned === true],
    );
    return { noteId: id, href: `/notes?note=${encodeURIComponent(id)}` };
  }
  if (action === "calendar.create-event") {
    const id = randomUUID();
    const calendarId = requiredString(input.calendarId, "日历");
    const ownsCalendar = await database.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM calendars WHERE id = $1 AND user_id = $2 AND read_only = false) AS exists`,
      [calendarId, actor.id],
    );
    if (!ownsCalendar.rows[0]?.exists) throw new AiActionError("日历不存在或不可写", 404);
    await database.query(
      `INSERT INTO calendar_events (id, calendar_id, title, description, location, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, calendarId, requiredString(input.title, "日程标题").slice(0, 240), stringInput(input.description), stringInput(input.location), requiredString(input.start, "开始时间"), requiredString(input.end, "结束时间")],
    );
    return { eventId: id, href: `/calendar?event=${encodeURIComponent(id)}` };
  }
  if (action === "mail.message-action") {
    const messageId = requiredString(input.messageId, "邮件");
    const mailAction = parseMailAction(requiredString(input.mailAction, "邮件操作"));
    const result = await performMailMessageAction(messageId, mailAction, stringInput(input.folderId));
    return { messageId, mailAction, result };
  }
  if (action === "mail.send-draft") {
    const draftId = requiredString(input.draftId, "草稿");
    const accountId = requiredString(input.accountId, "发件账户");
    const idempotencyKey = requiredString(input.idempotencyKey, "发送确认标识");
    const result = await sendMailDraft(draftId, accountId, idempotencyKey);
    return { draftId, result };
  }
  throw new AiActionError("不支持的 AI 动作");
}

async function assertAiActionAllowed(actor: AppUser, risk: AiActionRisk): Promise<void> {
  if (actor.role === "viewer" && risk !== "read") throw new AiActionError("只读用户不能执行写入动作", 403);
  const settings = await getAiActionSettings(actor);
  if (risk === "read") return;
  if (process.env.KALENDER_AI_AUTO_EXECUTION !== "true") {
    throw new AiActionError("服务器未启用 AI 自动执行", 403);
  }
  if (!settings.autoExecutionEnabled) throw new AiActionError("AI 自动执行尚未启用", 403);
  if ((risk === "external-write" || risk === "destructive") && !settings.highRiskAutoEnabled) {
    throw new AiActionError("高风险 AI 自动执行尚未启用", 403);
  }
}

async function loadActor(userId: string): Promise<AppUser> {
  const database = await getDatabase();
  const result = await database.query<{
    id: string;
    display_name: string;
    username: string;
    email: string;
    role: AppUserRole;
    session_version: number;
    must_change_password: boolean;
  }>(
    `SELECT u.id, u.display_name, c.username, u.email, u.role, c.session_version, c.must_change_password
       FROM app_users u
       JOIN app_login_credentials c ON c.user_id = u.id
      WHERE u.id = $1 AND u.disabled_at IS NULL LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new AiActionError("AI 动作用户不存在", 404);
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    email: row.email,
    role: row.role,
    sessionVersion: Number(row.session_version),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

function actionRisk(action: AiWorkspaceAction, input: Readonly<Record<string, unknown>>): AiActionRisk {
  if (action === "workspace.search") return "read";
  if (action === "mail.send-draft") return "external-write";
  if (action === "mail.message-action") return input.mailAction === "delete" ? "destructive" : "external-write";
  if (action === "calendar.create-event") return "local-write";
  return "local-write";
}

function targetKind(action: AiWorkspaceAction): string {
  return action.split(".")[0] ?? "workspace";
}

function parseAction(value: unknown): AiWorkspaceAction {
  if (
    value === "workspace.search"
    || value === "task.create"
    || value === "task.update-status"
    || value === "note.create"
    || value === "calendar.create-event"
    || value === "mail.message-action"
    || value === "mail.send-draft"
  ) return value;
  throw new AiActionError("AI 动作类型无效");
}

function parseMailAction(value: string): MailMessageAction {
  if (value === "mark-read" || value === "mark-unread" || value === "star" || value === "unstar" || value === "archive" || value === "delete" || value === "move") return value;
  throw new AiActionError("邮件操作无效");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AiActionError(`缺少${label}`);
  return value.trim();
}

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dateInput(value: unknown): string | null {
  const text = stringInput(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new AiActionError("日期无效");
  return date.toISOString();
}

function safeTaskStatus(value: unknown): "inbox" | "next" | "waiting" | "someday" | "done" {
  return value === "next" || value === "waiting" || value === "someday" || value === "done" ? value : "inbox";
}

function safeNoteType(value: unknown): "general" | "meeting" | "email" | "project" | "daily" {
  return value === "meeting" || value === "email" || value === "project" || value === "daily" ? value : "general";
}

function searchKind(value: string | undefined): WorkspaceSearchKind | undefined {
  return value === "mail" || value === "task" || value === "calendar" || value === "note" || value === "project" || value === "ai"
    ? value
    : undefined;
}

function redactActionInput(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const copy = { ...input };
  if ("password" in copy) copy.password = "[redacted]";
  if ("content" in copy && typeof copy.content === "string" && copy.content.length > 2000) copy.content = `${copy.content.slice(0, 2000)}…`;
  return copy;
}
