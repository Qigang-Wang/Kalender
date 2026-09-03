import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";
import { getStoredTask, TaskRepositoryError, type StoredTask } from "./task-repository";
import { getUserScope } from "./user-scope";

export interface TaskScheduleRequestBody {
  readonly calendarId?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly timeZone?: unknown;
  readonly allowConflicts?: unknown;
}

export interface TaskScheduleInput {
  readonly calendarId: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
  readonly allowConflicts: boolean;
}

export interface TaskScheduleConflict {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

export interface ScheduledTaskResult {
  readonly task: StoredTask;
  readonly event: {
    readonly id: string;
    readonly calendarId: string;
    readonly title: string;
    readonly start: string;
    readonly end: string;
    readonly timeZone: string;
    readonly allDay: false;
    readonly status: "confirmed";
    readonly linkedTask: { readonly id: string; readonly title: string; readonly href: string };
  };
}

export interface CalendarTaskLink {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

interface TimeBlockRow {
  id: string;
  title: string;
  starts_at: string | Date;
  ends_at: string | Date;
}

export function parseTaskScheduleInput(body: TaskScheduleRequestBody | null): TaskScheduleInput {
  if (!body || typeof body.calendarId !== "string" || !body.calendarId.trim()) {
    throw new TaskRepositoryError("CALENDAR_REQUIRED", "请选择日历", 400);
  }
  const start = parseScheduleDate(body.start, "开始时间");
  const end = parseScheduleDate(body.end, "结束时间");
  const duration = end.getTime() - start.getTime();
  if (duration <= 0) throw new TaskRepositoryError("INVALID_TIME_RANGE", "结束时间必须晚于开始时间", 400);
  if (duration > 24 * 60 * 60 * 1000) throw new TaskRepositoryError("TIME_BLOCK_TOO_LONG", "单个任务时间块不能超过 24 小时", 400);
  const timeZone = typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone.trim() : "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(start);
  } catch {
    throw new TaskRepositoryError("INVALID_TIME_ZONE", "时区无效", 400);
  }
  return {
    calendarId: body.calendarId.trim(),
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone,
    allowConflicts: body.allowConflicts === true,
  };
}

export async function scheduleStoredTask(taskId: string, input: TaskScheduleInput): Promise<ScheduledTaskResult> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const event = await database.transaction(async (transaction) => {
    const taskResult = await transaction.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [taskId, scope.userId] : [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);

    const calendarResult = await transaction.query<{ id: string; read_only: boolean; provider_id: string }>(
      `SELECT id, read_only, provider_id FROM calendars WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [input.calendarId, scope.userId] : [input.calendarId],
    );
    const calendar = calendarResult.rows[0];
    if (!calendar) throw new TaskRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
    if (calendar.read_only) throw new TaskRepositoryError("CALENDAR_READ_ONLY", "该日历为只读", 409);
    if (calendar.provider_id !== "local-calendar") {
      throw new TaskRepositoryError("CALENDAR_NOT_LOCAL", "当前阶段只能把任务安排到本地日历", 409);
    }

    const existing = await transaction.query<TimeBlockRow>(
      `SELECT e.id, e.title, e.starts_at, e.ends_at
         FROM task_time_blocks tb
         JOIN calendar_events e ON e.id = tb.calendar_event_id
         JOIN calendars c ON c.id = e.calendar_id
        WHERE tb.task_id = $1 AND e.calendar_id = $2
          AND e.starts_at = $3 AND e.ends_at = $4
          ${scope.active ? "AND c.user_id = $5" : ""}
        LIMIT 1`,
      scope.active ? [taskId, input.calendarId, input.start, input.end, scope.userId] : [taskId, input.calendarId, input.start, input.end],
    );
    if (existing.rows[0]) return mapScheduledEvent(existing.rows[0], input.calendarId, input.timeZone, task);

    const conflicts = await transaction.query<TimeBlockRow>(
      `SELECT e.id, e.title, e.starts_at, e.ends_at
         FROM calendar_events e
         JOIN calendars c ON c.id = e.calendar_id
        WHERE e.calendar_id = $1 AND e.status <> 'cancelled' AND e.availability <> 'free'
          AND starts_at < $3 AND ends_at > $2
          ${scope.active ? "AND c.user_id = $4" : ""}
        ORDER BY starts_at, ends_at`,
      scope.active ? [input.calendarId, input.start, input.end, scope.userId] : [input.calendarId, input.start, input.end],
    );
    if (conflicts.rows.length && !input.allowConflicts) {
      throw new TaskScheduleConflictError(conflicts.rows.map(mapConflict));
    }

    const eventId = randomUUID();
    const saved = await transaction.query<TimeBlockRow>(
      `INSERT INTO calendar_events (
         id, calendar_id, provider_event_id, title, description, location,
         starts_at, ends_at, time_zone, all_day, attendees, status,
         idempotency_key, availability, updated_at
       ) VALUES ($1,$2,$1,$3,$4,NULL,$5,$6,$7,false,'[]'::jsonb,'confirmed',$8,'busy',now())
       RETURNING id, title, starts_at, ends_at`,
      [eventId, input.calendarId, task.title, "由任务安排的专注时间块", input.start, input.end, input.timeZone, `task-time-block:${taskId}:${eventId}`],
    );
    await transaction.query(
      "INSERT INTO task_time_blocks (task_id, calendar_event_id) VALUES ($1, $2)",
      [taskId, eventId],
    );
    await transaction.query(
      `INSERT INTO entity_links (id, user_id, source_kind, source_id, target_kind, target_id, relation)
       VALUES ($1,$2,'task',$3,'calendar',$4,'scheduled')
       ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING`,
      [randomUUID(), scope.valueOrNull(), taskId, eventId],
    );
    return mapScheduledEvent(saved.rows[0]!, input.calendarId, input.timeZone, task);
  });

  const task = await getStoredTask(taskId);
  if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
  return { task, event };
}

export async function updateStoredTaskSchedule(taskId: string, eventId: string, input: TaskScheduleInput, expectedUpdatedAt?: string): Promise<ScheduledTaskResult> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const event = await database.transaction(async (transaction) => {
    const taskResult = await transaction.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [taskId, scope.userId] : [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);

    const blockResult = await transaction.query<{ calendar_event_id: string }>(
      `SELECT tb.calendar_event_id
         FROM task_time_blocks tb
         JOIN calendar_events e ON e.id = tb.calendar_event_id
         JOIN calendars c ON c.id = e.calendar_id
        WHERE tb.task_id = $1 AND tb.calendar_event_id = $2${scope.active ? " AND c.user_id = $3" : ""}
        LIMIT 1`,
      scope.active ? [taskId, eventId, scope.userId] : [taskId, eventId],
    );
    if (!blockResult.rows[0]) throw new TaskRepositoryError("TIME_BLOCK_NOT_FOUND", "任务时间块不存在", 404);

    const calendarResult = await transaction.query<{ id: string; read_only: boolean; provider_id: string }>(
      `SELECT id, read_only, provider_id FROM calendars WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [input.calendarId, scope.userId] : [input.calendarId],
    );
    const calendar = calendarResult.rows[0];
    if (!calendar) throw new TaskRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
    if (calendar.read_only || calendar.provider_id !== "local-calendar") {
      throw new TaskRepositoryError("CALENDAR_NOT_WRITABLE", "当前阶段只能调整到可写的本地日历", 409);
    }

    const conflicts = await transaction.query<TimeBlockRow>(
      `SELECT e.id, e.title, e.starts_at, e.ends_at
         FROM calendar_events e
         JOIN calendars c ON c.id = e.calendar_id
        WHERE e.calendar_id = $1 AND e.status <> 'cancelled' AND e.availability <> 'free' AND e.id <> $4
          AND e.starts_at < $3 AND e.ends_at > $2
          ${scope.active ? "AND c.user_id = $5" : ""}
        ORDER BY starts_at, ends_at`,
      scope.active ? [input.calendarId, input.start, input.end, eventId, scope.userId] : [input.calendarId, input.start, input.end, eventId],
    );
    if (conflicts.rows.length && !input.allowConflicts) {
      throw new TaskScheduleConflictError(conflicts.rows.map(mapConflict));
    }

    const updated = await transaction.query<TimeBlockRow>(
      `UPDATE calendar_events
          SET calendar_id = $1, title = $2, starts_at = $3, ends_at = $4,
              time_zone = $5, all_day = false,
              updated_at = GREATEST(clock_timestamp(), calendar_events.updated_at + interval '1 millisecond')
        WHERE id = $6 AND ($7::timestamptz IS NULL OR date_trunc('milliseconds', calendar_events.updated_at) = date_trunc('milliseconds', $7::timestamptz))${scope.active ? " AND EXISTS (SELECT 1 FROM calendars c WHERE c.id = calendar_events.calendar_id AND c.user_id = $8)" : ""}
        RETURNING id, title, starts_at, ends_at`,
      scope.active
        ? [input.calendarId, task.title, input.start, input.end, input.timeZone, eventId, expectedUpdatedAt ?? null, scope.userId]
        : [input.calendarId, task.title, input.start, input.end, input.timeZone, eventId, expectedUpdatedAt ?? null],
    );
    const row = updated.rows[0];
    if (!row) throw new TaskRepositoryError("VERSION_CONFLICT", "时间块已被更新，请读取最新版本后重试", 409);
    return mapScheduledEvent(row, input.calendarId, input.timeZone, task);
  });

  const task = await getStoredTask(taskId);
  if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
  return { task, event };
}

export async function deleteStoredTaskSchedule(taskId: string, eventId: string, expectedUpdatedAt?: string): Promise<StoredTask> {
  const database = await getDatabase();
  const scope = await getUserScope();
  await database.transaction(async (transaction) => {
    const taskResult = await transaction.query<{ id: string }>(
      `SELECT id FROM tasks WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [taskId, scope.userId] : [taskId],
    );
    if (!taskResult.rows[0]) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
    const blockResult = await transaction.query<{ calendar_event_id: string }>(
      `SELECT tb.calendar_event_id
         FROM task_time_blocks tb
         JOIN calendar_events e ON e.id = tb.calendar_event_id
         JOIN calendars c ON c.id = e.calendar_id
        WHERE tb.task_id = $1 AND tb.calendar_event_id = $2${scope.active ? " AND c.user_id = $3" : ""}
        LIMIT 1`,
      scope.active ? [taskId, eventId, scope.userId] : [taskId, eventId],
    );
    if (!blockResult.rows[0]) throw new TaskRepositoryError("TIME_BLOCK_NOT_FOUND", "任务时间块不存在", 404);
    const deleted = await transaction.query<{ id: string }>(
      `DELETE FROM calendar_events WHERE id = $1
         AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', calendar_events.updated_at) = date_trunc('milliseconds', $2::timestamptz))${scope.active ? " AND EXISTS (SELECT 1 FROM calendars c WHERE c.id = calendar_events.calendar_id AND c.user_id = $3)" : ""}
       RETURNING id`,
      scope.active ? [eventId, expectedUpdatedAt ?? null, scope.userId] : [eventId, expectedUpdatedAt ?? null],
    );
    if (!deleted.rows[0]) throw new TaskRepositoryError("VERSION_CONFLICT", "时间块已被更新，请读取最新版本后重试", 409);
    await transaction.query(
      `DELETE FROM entity_links WHERE source_kind = 'task' AND source_id = $1 AND target_kind = 'calendar' AND target_id = $2 AND relation = 'scheduled'${scope.active ? " AND user_id = $3" : ""}`,
      scope.active ? [taskId, eventId, scope.userId] : [taskId, eventId],
    );
  });
  const task = await getStoredTask(taskId);
  if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
  return task;
}

export async function listCalendarTaskLinks(eventIds: readonly string[]): Promise<ReadonlyMap<string, CalendarTaskLink>> {
  if (!eventIds.length) return new Map();
  const database = await getDatabase();
  const result = await database.query<{ calendar_event_id: string; task_id: string; title: string }>(
    `SELECT tb.calendar_event_id, t.id AS task_id, t.title
       FROM task_time_blocks tb
       JOIN tasks t ON t.id = tb.task_id
      WHERE tb.calendar_event_id = ANY($1::text[])`,
    [eventIds],
  );
  return new Map(result.rows.map((row) => [row.calendar_event_id, {
    id: row.task_id,
    title: row.title,
    href: `/tasks?task=${encodeURIComponent(row.task_id)}`,
  }]));
}

export class TaskScheduleConflictError extends TaskRepositoryError {
  constructor(readonly conflicts: readonly TaskScheduleConflict[]) {
    super("SCHEDULE_CONFLICT", "所选时间与现有日程冲突", 409);
    this.name = "TaskScheduleConflictError";
  }
}

function parseScheduleDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || !value) throw new TaskRepositoryError("INVALID_DATE", `请填写${label}`, 400);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TaskRepositoryError("INVALID_DATE", `${label}无效`, 400);
  return date;
}

function mapConflict(row: TimeBlockRow): TaskScheduleConflict {
  return { id: row.id, title: row.title, start: toIso(row.starts_at), end: toIso(row.ends_at) };
}

function mapScheduledEvent(
  row: TimeBlockRow,
  calendarId: string,
  timeZone: string,
  task: { readonly id: string; readonly title: string },
): ScheduledTaskResult["event"] {
  return {
    id: row.id,
    calendarId,
    title: row.title,
    start: toIso(row.starts_at),
    end: toIso(row.ends_at),
    timeZone,
    allDay: false,
    status: "confirmed",
    linkedTask: { id: task.id, title: task.title, href: `/tasks?task=${encodeURIComponent(task.id)}` },
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
