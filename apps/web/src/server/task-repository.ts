import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";

export const taskStatuses = ["inbox", "next", "waiting", "someday", "done"] as const;
export const taskUrgencyModes = ["auto", "urgent", "not_urgent"] as const;
export const taskSourceKinds = ["mail", "calendar", "note"] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type TaskUrgencyMode = (typeof taskUrgencyModes)[number];
export type TaskSourceKind = (typeof taskSourceKinds)[number];

export interface TaskSourceReference {
  readonly id: string;
  readonly kind: TaskSourceKind;
  readonly sourceId: string;
  readonly label: string;
  readonly href?: string;
}

export interface StoredTask {
  readonly id: string;
  readonly title: string;
  readonly notes?: string;
  readonly status: TaskStatus;
  readonly important: boolean;
  readonly urgencyMode: TaskUrgencyMode;
  readonly isUrgent: boolean;
  readonly dueAt?: string;
  readonly estimatedMinutes?: number;
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly phaseId?: string;
  readonly durationWorkdays?: number;
  readonly autoSchedule: boolean;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
  readonly areaName?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceReferences: readonly TaskSourceReference[];
  readonly scheduledBlockCount: number;
  readonly scheduledBlocks: readonly TaskTimeBlock[];
}

export interface TaskTimeBlock {
  readonly eventId: string;
  readonly calendarId: string;
  readonly calendarName: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly href: string;
}

export interface SaveTaskInput {
  readonly id?: string;
  readonly title: string;
  readonly notes?: string;
  readonly status: TaskStatus;
  readonly important: boolean;
  readonly urgencyMode: TaskUrgencyMode;
  readonly dueAt?: string;
  readonly estimatedMinutes?: number;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly areaName?: string;
  readonly sourceReferences?: readonly Omit<TaskSourceReference, "id">[];
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  important: boolean;
  urgency_mode: TaskUrgencyMode;
  due_at: string | Date | null;
  estimated_minutes: number | null;
  planned_start: string | Date | null;
  planned_end: string | Date | null;
  phase_id: string | null;
  duration_workdays: number | null;
  auto_schedule: boolean;
  project_id: string | null;
  project_name: string | null;
  project_color: string | null;
  area_name: string | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  scheduled_block_count: number | string;
}

interface SourceRow {
  id: string;
  task_id: string;
  source_kind: TaskSourceKind;
  source_id: string;
  label: string;
  href: string | null;
}

interface TimeBlockDetailsRow {
  task_id: string;
  calendar_event_id: string;
  calendar_id: string;
  calendar_name: string;
  title: string;
  starts_at: string | Date;
  ends_at: string | Date;
}

const taskSelect = `
  SELECT t.id, t.title, t.notes, t.status, t.important, t.urgency_mode,
         t.due_at, t.estimated_minutes, t.planned_start, t.planned_end,
         t.phase_id, t.duration_workdays, t.auto_schedule, t.project_id,
         COALESCE(p.name, t.project_name) AS project_name,
         p.color AS project_color,
         COALESCE(p.area_name, t.area_name) AS area_name,
         t.completed_at, t.created_at, t.updated_at,
         count(tb.calendar_event_id)::int AS scheduled_block_count
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN task_time_blocks tb ON tb.task_id = t.id`;

export async function listStoredTasks(includeCompleted = false): Promise<readonly StoredTask[]> {
  return queryStoredTasks(
    "WHERE ($1::boolean OR t.status <> 'done')",
    [includeCompleted],
  );
}

export async function listStoredProjectTasks(
  projectId: string,
  includeCompleted = true,
): Promise<readonly StoredTask[]> {
  return queryStoredTasks(
    "WHERE t.project_id = $1 AND ($2::boolean OR t.status <> 'done')",
    [projectId, includeCompleted],
  );
}

export async function listStoredTodayTasks(
  before: string,
  urgencyReference = new Date(),
): Promise<readonly StoredTask[]> {
  const urgencyBoundary = new Date(urgencyReference.getTime() + 24 * 60 * 60 * 1000).toISOString();
  return queryStoredTasks(
    `WHERE t.status <> 'done'
       AND (
         t.due_at < $1
         OR (
           t.status = 'next'
           AND (
             t.urgency_mode = 'urgent'
             OR (t.urgency_mode = 'auto' AND t.due_at <= $2)
           )
         )
       )`,
    [before, urgencyBoundary],
  );
}

async function queryStoredTasks(
  whereClause: string,
  parameters: unknown[],
): Promise<readonly StoredTask[]> {
  const database = await getDatabase();
  const result = await database.query<TaskRow>(
    `${taskSelect}
     ${whereClause}
     GROUP BY t.id, p.id
     ORDER BY (t.status = 'done'), t.due_at ASC NULLS LAST, t.important DESC, t.updated_at DESC`,
    parameters,
  );
  return attachSources(result.rows);
}

export async function getStoredTask(taskId: string): Promise<StoredTask | undefined> {
  const database = await getDatabase();
  const result = await database.query<TaskRow>(
    `${taskSelect} WHERE t.id = $1 GROUP BY t.id, p.id LIMIT 1`,
    [taskId],
  );
  return (await attachSources(result.rows))[0];
}

export async function saveStoredTask(input: SaveTaskInput): Promise<StoredTask> {
  const database = await getDatabase();
  const id = input.id ?? randomUUID();
  const existing = input.id
    ? await database.query<{ id: string }>("SELECT id FROM tasks WHERE id = $1 LIMIT 1", [input.id])
    : undefined;
  if (input.id && !existing?.rows[0]) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
  const project = await resolveTaskProject(input);
  const projectId = project?.id ?? null;
  const projectName = project?.name ?? input.projectName ?? null;
  const areaName = project?.areaName ?? input.areaName ?? null;

  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO tasks (
         id, title, notes, status, important, urgency_mode, due_at,
         estimated_minutes, project_id, project_name, area_name, completed_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         notes = EXCLUDED.notes,
         status = EXCLUDED.status,
         important = EXCLUDED.important,
         urgency_mode = EXCLUDED.urgency_mode,
         due_at = EXCLUDED.due_at,
         estimated_minutes = EXCLUDED.estimated_minutes,
         project_id = EXCLUDED.project_id,
         project_name = EXCLUDED.project_name,
         area_name = EXCLUDED.area_name,
         completed_at = EXCLUDED.completed_at,
         updated_at = now()`,
      [
        id,
        input.title,
        input.notes ?? null,
        input.status,
        input.important,
        input.urgencyMode,
        input.dueAt ?? null,
        input.estimatedMinutes ?? null,
        projectId,
        projectName,
        areaName,
        input.status === "done" ? new Date().toISOString() : null,
      ],
    );
    await transaction.query(
      "DELETE FROM entity_links WHERE source_kind = 'project' AND target_kind = 'task' AND target_id = $1 AND relation = 'project-item'",
      [id],
    );
    if (projectId) {
      await transaction.query(
        `INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
         VALUES ($1,'project',$2,'task',$3,'project-item')
         ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING`,
        [`project-task:${id}`, projectId, id],
      );
    }
    if (input.sourceReferences) {
      await transaction.query("DELETE FROM task_source_references WHERE task_id = $1", [id]);
      await transaction.query(
        "DELETE FROM entity_links WHERE target_kind = 'task' AND target_id = $1 AND relation = 'derived-task'",
        [id],
      );
      for (const source of input.sourceReferences) {
        const sourceReferenceId = randomUUID();
        await transaction.query(
          `INSERT INTO task_source_references (id, task_id, source_kind, source_id, label, href)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [sourceReferenceId, id, source.kind, source.sourceId, source.label, source.href ?? null],
        );
        await transaction.query(
          `INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
           VALUES ($1,$2,$3,'task',$4,'derived-task')
           ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING`,
          [`source:${sourceReferenceId}`, source.kind, source.sourceId, id],
        );
      }
    }
  });

  const saved = await getStoredTask(id);
  if (!saved) throw new TaskRepositoryError("TASK_SAVE_FAILED", "无法保存任务", 500);
  return saved;
}

export async function deleteStoredTask(taskId: string): Promise<boolean> {
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    await transaction.query(
      "DELETE FROM entity_links WHERE (source_kind = 'task' AND source_id = $1) OR (target_kind = 'task' AND target_id = $1)",
      [taskId],
    );
    const result = await transaction.query<{ id: string }>("DELETE FROM tasks WHERE id = $1 RETURNING id", [taskId]);
    return Boolean(result.rows[0]);
  });
}

export function deriveTaskUrgency(
  urgencyMode: TaskUrgencyMode,
  dueAt?: string,
  referenceTime = new Date(),
): boolean {
  if (urgencyMode === "urgent") return true;
  if (urgencyMode === "not_urgent" || !dueAt) return false;
  const due = new Date(dueAt);
  return !Number.isNaN(due.getTime()) && due.getTime() <= referenceTime.getTime() + 24 * 60 * 60 * 1000;
}

export class TaskRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "TaskRepositoryError";
  }
}

async function attachSources(rows: readonly TaskRow[]): Promise<readonly StoredTask[]> {
  if (!rows.length) return [];
  const database = await getDatabase();
  const taskIds = rows.map((row) => row.id);
  const [sources, blocks] = await Promise.all([
    database.query<SourceRow>(
      `SELECT id, task_id, source_kind, source_id, label, href
         FROM task_source_references
        WHERE task_id = ANY($1::text[])
        ORDER BY created_at`,
      [taskIds],
    ),
    database.query<TimeBlockDetailsRow>(
      `SELECT tb.task_id, tb.calendar_event_id, e.calendar_id,
              COALESCE(a.display_name, c.name) AS calendar_name,
              e.title, e.starts_at, e.ends_at
         FROM task_time_blocks tb
         JOIN calendar_events e ON e.id = tb.calendar_event_id
         JOIN calendars c ON c.id = e.calendar_id
         LEFT JOIN calendar_accounts a ON a.id = c.account_id
        WHERE tb.task_id = ANY($1::text[])
        ORDER BY e.starts_at, e.ends_at`,
      [taskIds],
    ),
  ]);
  const sourcesByTask = new Map<string, TaskSourceReference[]>();
  for (const row of sources.rows) {
    const entries = sourcesByTask.get(row.task_id) ?? [];
    entries.push({ id: row.id, kind: row.source_kind, sourceId: row.source_id, label: row.label, href: row.href ?? undefined });
    sourcesByTask.set(row.task_id, entries);
  }
  const blocksByTask = new Map<string, TaskTimeBlock[]>();
  for (const row of blocks.rows) {
    const entries = blocksByTask.get(row.task_id) ?? [];
    const start = toIso(row.starts_at)!;
    entries.push({
      eventId: row.calendar_event_id,
      calendarId: row.calendar_id,
      calendarName: row.calendar_name,
      title: row.title,
      start,
      end: toIso(row.ends_at)!,
      href: `/calendar?event=${encodeURIComponent(row.calendar_event_id)}&date=${encodeURIComponent(start)}`,
    });
    blocksByTask.set(row.task_id, entries);
  }
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    notes: row.notes ?? undefined,
    status: row.status,
    important: row.important,
    urgencyMode: row.urgency_mode,
    isUrgent: deriveTaskUrgency(row.urgency_mode, toIso(row.due_at)),
    dueAt: toIso(row.due_at),
    estimatedMinutes: row.estimated_minutes ?? undefined,
    plannedStart: toDateOnly(row.planned_start),
    plannedEnd: toDateOnly(row.planned_end),
    phaseId: row.phase_id ?? undefined,
    durationWorkdays: row.duration_workdays ?? undefined,
    autoSchedule: row.auto_schedule,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    projectColor: row.project_color ?? undefined,
    areaName: row.area_name ?? undefined,
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
    sourceReferences: sourcesByTask.get(row.id) ?? [],
    scheduledBlockCount: Number(row.scheduled_block_count),
    scheduledBlocks: blocksByTask.get(row.id) ?? [],
  }));
}

function toIso(value: string | Date | null): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDateOnly(value: string | Date | null): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

interface TaskProjectRow {
  readonly id: string;
  readonly name: string;
  readonly area_name: string | null;
  readonly status: "active" | "archived";
}

async function resolveTaskProject(input: SaveTaskInput): Promise<
  { readonly id: string; readonly name: string; readonly areaName?: string } | undefined
> {
  const database = await getDatabase();
  let result;
  if (input.projectId) {
    result = await database.query<TaskProjectRow>(
      "SELECT id, name, area_name, status FROM projects WHERE id = $1 LIMIT 1",
      [input.projectId],
    );
    const selectedProject = result.rows[0];
    if (!selectedProject) {
      throw new TaskRepositoryError("PROJECT_NOT_FOUND", "项目不存在或已归档", 404);
    }
    if (selectedProject.status === "archived") {
      const existingLink = input.id
        ? await database.query<{ project_id: string | null }>("SELECT project_id FROM tasks WHERE id = $1 LIMIT 1", [input.id])
        : undefined;
      if (existingLink?.rows[0]?.project_id !== selectedProject.id) {
        throw new TaskRepositoryError("PROJECT_NOT_FOUND", "项目不存在或已归档", 404);
      }
    }
  } else if (input.projectName) {
    result = await database.query<TaskProjectRow>(
      "SELECT id, name, area_name, status FROM projects WHERE lower(trim(name)) = lower(trim($1)) AND status = 'active' LIMIT 1",
      [input.projectName],
    );
  } else {
    return undefined;
  }
  const project = result.rows[0];
  return project
    ? { id: project.id, name: project.name, areaName: project.area_name ?? undefined }
    : undefined;
}
