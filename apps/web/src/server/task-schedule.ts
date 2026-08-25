import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";
import { getStoredTask, TaskRepositoryError, type StoredTask } from "./task-repository";

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
    throw new TaskRepositoryError("CALENDAR_REQUIRED", "Bitte wählen Sie einen Kalender", 400);
  }
  const start = parseScheduleDate(body.start, "Startzeit");
  const end = parseScheduleDate(body.end, "Endzeit");
  const duration = end.getTime() - start.getTime();
  if (duration <= 0) throw new TaskRepositoryError("INVALID_TIME_RANGE", "Die Endzeit muss später als die Startzeit sein.", 400);
  if (duration > 24 * 60 * 60 * 1000) throw new TaskRepositoryError("TIME_BLOCK_TOO_LONG", "ein einzelner Taskblock sollte 24 Stunden nicht überschreiten", 400);
  const timeZone = typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone.trim() : "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(start);
  } catch {
    throw new TaskRepositoryError("INVALID_TIME_ZONE", "Zeitzone ungültig", 400);
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
  const event = await database.transaction(async (transaction) => {
    const taskResult = await transaction.query<{ id: string; title: string }>(
      "SELECT id, title FROM tasks WHERE id = $1 LIMIT 1",
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "Aufgabe existiert nicht", 404);

    const calendarResult = await transaction.query<{ id: string; read_only: boolean; provider_id: string }>(
      "SELECT id, read_only, provider_id FROM calendars WHERE id = $1 LIMIT 1",
      [input.calendarId],
    );
    const calendar = calendarResult.rows[0];
    if (!calendar) throw new TaskRepositoryError("CALENDAR_NOT_FOUND", "Kalender existiert nicht", 404);
    if (calendar.read_only) throw new TaskRepositoryError("CALENDAR_READ_ONLY", "Dieser Kalender ist nur lesbar", 409);
    if (calendar.provider_id !== "local-calendar") {
      throw new TaskRepositoryError("CALENDAR_NOT_LOCAL", "nur lokale Kalender können in dieser Phase geplant werden", 409);
    }

    const existing = await transaction.query<TimeBlockRow>(
      `SELECT e.id, e.title, e.starts_at, e.ends_at
         FROM task_time_blocks tb
         JOIN calendar_events e ON e.id = tb.calendar_event_id
        WHERE tb.task_id = $1 AND e.calendar_id = $2
          AND e.starts_at = $3 AND e.ends_at = $4
        LIMIT 1`,
      [taskId, input.calendarId, input.start, input.end],
    );
    if (existing.rows[0]) return mapScheduledEvent(existing.rows[0], input.calendarId, input.timeZone, task);

    const conflicts = await transaction.query<TimeBlockRow>(
      `SELECT id, title, starts_at, ends_at
         FROM calendar_events
        WHERE calendar_id = $1 AND status <> 'cancelled'
          AND starts_at < $3 AND ends_at > $2
        ORDER BY starts_at, ends_at`,
      [input.calendarId, input.start, input.end],
    );
    if (conflicts.rows.length && !input.allowConflicts) {
      throw new TaskScheduleConflictError(conflicts.rows.map(mapConflict));
    }

    const eventId = randomUUID();
    const saved = await transaction.query<TimeBlockRow>(
      `INSERT INTO calendar_events (
         id, calendar_id, provider_event_id, title, description, location,
         starts_at, ends_at, time_zone, all_day, attendees, status,
         idempotency_key, updated_at
       ) VALUES ($1,$2,$1,$3,$4,NULL,$5,$6,$7,false,'[]'::jsonb,'confirmed',$8,now())
       RETURNING id, title, starts_at, ends_at`,
      [eventId, input.calendarId, task.title, "aufgabenorientierter Fokusblock", input.start, input.end, input.timeZone, `task-time-block:${taskId}:${eventId}`],
    );
    await transaction.query(
      "INSERT INTO task_time_blocks (task_id, calendar_event_id) VALUES ($1, $2)",
      [taskId, eventId],
    );
    await transaction.query(
      `INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
       VALUES ($1,'task',$2,'calendar',$3,'scheduled')
       ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING`,
      [randomUUID(), taskId, eventId],
    );
    return mapScheduledEvent(saved.rows[0]!, input.calendarId, input.timeZone, task);
  });

  const task = await getStoredTask(taskId);
  if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "Aufgabe existiert nicht", 404);
  return { task, event };
}

export async function updateStoredTaskSchedule(taskId: string, eventId: string, input: TaskScheduleInput): Promise<ScheduledTaskResult> {
  const database = await getDatabase();
  const event = await database.transaction(async (transaction) => {
    const taskResult = await transaction.query<{ id: string; title: string }>(
      "SELECT id, title FROM tasks WHERE id = $1 LIMIT 1",
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "Aufgabe existiert nicht", 404);

    const blockResult = await transaction.query<{ calendar_event_id: string }>(
      "SELECT calendar_event_id FROM task_time_blocks WHERE task_id = $1 AND calendar_event_id = $2 LIMIT 1",
      [taskId, eventId],
    );
    if (!blockResult.rows[0]) throw new TaskRepositoryError("TIME_BLOCK_NOT_FOUND", "Aufgaben-Zeitblock existiert nicht", 404);

    const calendarResult = await transaction.query<{ id: string; read_only: boolean; provider_id: string }>(
      "SELECT id, read_only, provider_id FROM calendars WHERE id = $1 LIMIT 1",
      [input.calendarId],
    );
    const calendar = calendarResult.rows[0];
    if (!calendar) throw new TaskRepositoryError("CALENDAR_NOT_FOUND", "Kalender existiert nicht", 404);
    if (calendar.read_only || calendar.provider_id !== "local-calendar") {
      throw new TaskRepositoryError("CALENDAR_NOT_WRITABLE", "die aktuelle Stufe kann nur an einen beschreibbaren lokalen Kalender angepasst werden", 409);
    }

    const conflicts = await transaction.query<TimeBlockRow>(
      `SELECT id, title, starts_at, ends_at
         FROM calendar_events
        WHERE calendar_id = $1 AND status <> 'cancelled' AND id <> $4
          AND starts_at < $3 AND ends_at > $2
        ORDER BY starts_at, ends_at`,
      [input.calendarId, input.start, input.end, eventId],
    );
    if (conflicts.rows.length && !input.allowConflicts) {
      throw new TaskScheduleConflictError(conflicts.rows.map(mapConflict));
    }

    const updated = await transaction.query<TimeBlockRow>(
      `UPDATE calendar_events
          SET calendar_id = $1, title = $2, starts_at = $3, ends_at = $4,
              time_zone = $5, all_day = false, updated_at = now()
        WHERE id = $6
        RETURNING id, title, starts_at, ends_at`,
      [input.calendarId, task.title, input.start, input.end, input.timeZone, eventId],
    );
    const row = updated.rows[0];
    if (!row) throw new TaskRepositoryError("TIME_BLOCK_SAVE_FAILED", "Zeitblock kann nicht aktualisiert werden", 500);
    return mapScheduledEvent(row, input.calendarId, input.timeZone, task);
  });

  const task = await getStoredTask(taskId);
  if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "Aufgabe existiert nicht", 404);
  return { task, event };
}

export async function deleteStoredTaskSchedule(taskId: string, eventId: string): Promise<StoredTask> {
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    const blockResult = await transaction.query<{ calendar_event_id: string }>(
      "SELECT calendar_event_id FROM task_time_blocks WHERE task_id = $1 AND calendar_event_id = $2 LIMIT 1",
      [taskId, eventId],
    );
    if (!blockResult.rows[0]) throw new TaskRepositoryError("TIME_BLOCK_NOT_FOUND", "Aufgaben-Zeitblock existiert nicht", 404);
    await transaction.query(
      "DELETE FROM entity_links WHERE source_kind = 'task' AND source_id = $1 AND target_kind = 'calendar' AND target_id = $2 AND relation = 'scheduled'",
      [taskId, eventId],
    );
    await transaction.query("DELETE FROM calendar_events WHERE id = $1", [eventId]);
  });
  const task = await getStoredTask(taskId);
  if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "Aufgabe existiert nicht", 404);
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
    super("SCHEDULE_CONFLICT", "die ausgewählten Zeitkonflikte mit dem bestehenden Kalenderereignis", 409);
    this.name = "TaskScheduleConflictError";
  }
}

function parseScheduleDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || !value) throw new TaskRepositoryError("INVALID_DATE", `bitte ausfüllen${label}`, 400);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TaskRepositoryError("INVALID_DATE", `${label}ungültig`, 400);
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
