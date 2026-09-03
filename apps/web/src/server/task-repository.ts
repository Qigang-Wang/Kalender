import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";
import { ensureProjectAccess } from "./project-collaboration";
import { getUserScope } from "./user-scope";

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
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
  readonly planItemId?: string;
  readonly planItemTitle?: string;
  readonly areaName?: string;
  readonly assigneeUserId?: string;
  readonly assigneeDisplayName?: string;
  readonly assigneeEmail?: string;
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
  readonly planItemId?: string;
  readonly projectName?: string;
  readonly areaName?: string;
  readonly assigneeUserId?: string;
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
  project_id: string | null;
  project_name: string | null;
  project_color: string | null;
  plan_item_id: string | null;
  plan_item_title: string | null;
  area_name: string | null;
  assignee_user_id: string | null;
  assignee_display_name: string | null;
  assignee_email: string | null;
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
         t.due_at, t.estimated_minutes, t.project_id,
         COALESCE(p.name, t.project_name) AS project_name,
         p.color AS project_color,
         t.plan_item_id, plan_item.title AS plan_item_title,
         COALESCE(p.area_name, t.area_name) AS area_name,
         t.assignee_user_id, assignee.display_name AS assignee_display_name, assignee.email AS assignee_email,
         t.completed_at, t.created_at, t.updated_at,
         count(tb.calendar_event_id)::int AS scheduled_block_count
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN project_plan_items plan_item ON plan_item.id = t.plan_item_id
    LEFT JOIN app_users assignee ON assignee.id = t.assignee_user_id
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
  await ensureProjectAccess(projectId, "viewer");
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
  const scope = await getUserScope();
  const scoped = scope.active
    && whereClause.includes("t.project_id = $1")
    ? { whereClause, parameters }
    : scope.active
    ? { whereClause: `${whereClause} AND (t.user_id = $${parameters.length + 1} OR t.assignee_user_id = $${parameters.length + 1})`, parameters: [...parameters, scope.userId] }
    : { whereClause, parameters };
  const result = await database.query<TaskRow>(
    `${taskSelect}
     ${scoped.whereClause}
     GROUP BY t.id, p.id, plan_item.id, assignee.id
     ORDER BY (t.status = 'done'), t.due_at ASC NULLS LAST, t.important DESC, t.updated_at DESC`,
    scoped.parameters,
  );
  return attachSources(result.rows);
}

export async function getStoredTask(taskId: string): Promise<StoredTask | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const scoped = scope.active
    ? {
        clause: ` AND (t.user_id = $2 OR t.assignee_user_id = $2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = $2))`,
        parameters: [taskId, scope.userId],
      }
    : { clause: "", parameters: [taskId] };
  const result = await database.query<TaskRow>(
    `${taskSelect} WHERE t.id = $1${scoped.clause} GROUP BY t.id, p.id, plan_item.id, assignee.id LIMIT 1`,
    scoped.parameters,
  );
  return (await attachSources(result.rows))[0];
}

export async function saveStoredTask(input: SaveTaskInput, options: { readonly expectedUpdatedAt?: string } = {}): Promise<StoredTask> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const id = input.id ?? randomUUID();
  const existing = input.id
    ? await database.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
        scope.active ? [input.id, scope.userId] : [input.id],
      )
    : undefined;
  if (input.id && !existing?.rows[0]) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
  const project = await resolveTaskProject(input);
  const projectId = project?.id ?? null;
  const projectName = project?.name ?? input.projectName ?? null;
  const areaName = project?.areaName ?? input.areaName ?? null;
  let planItemId: string | null = null;

  if (projectId) await ensureProjectAccess(projectId, "editor");
  if (input.planItemId) {
    const planItem = await database.query<{ id: string; project_id: string }>(
      "SELECT id, project_id FROM project_plan_items WHERE id = $1 LIMIT 1",
      [input.planItemId],
    );
    if (!planItem.rows[0] || !projectId || planItem.rows[0].project_id !== projectId) {
      throw new TaskRepositoryError("PLAN_ITEM_NOT_FOUND", "关联计划项必须属于所选项目", 400);
    }
    planItemId = planItem.rows[0].id;
  }
  if (input.assigneeUserId) {
    const assignee = await database.query<{ id: string }>(
      "SELECT id FROM app_users WHERE id = $1 AND disabled_at IS NULL LIMIT 1",
      [input.assigneeUserId],
    );
    if (!assignee.rows[0]) throw new TaskRepositoryError("ASSIGNEE_NOT_FOUND", "指派用户不存在", 404);
  }

  await database.transaction(async (transaction) => {
    const written = await transaction.query<{ id: string }>(
      `INSERT INTO tasks (
         id, user_id, title, notes, status, important, urgency_mode, due_at,
         estimated_minutes, project_id, project_name, area_name, assignee_user_id, plan_item_id,
         completed_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
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
         assignee_user_id = EXCLUDED.assignee_user_id,
         plan_item_id = EXCLUDED.plan_item_id,
         completed_at = EXCLUDED.completed_at,
         updated_at = GREATEST(clock_timestamp(), tasks.updated_at + interval '1 millisecond')
       WHERE ($16::timestamptz IS NULL OR date_trunc('milliseconds', tasks.updated_at) = date_trunc('milliseconds', $16::timestamptz))
       RETURNING id`,
      [
        id,
        scope.valueOrNull(),
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
        input.assigneeUserId ?? null,
        planItemId,
        input.status === "done" ? new Date().toISOString() : null,
        options.expectedUpdatedAt ?? null,
      ],
    );
    if (!written.rows[0]) {
      const exists = await transaction.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
        scope.active ? [id, scope.userId] : [id],
      );
      if (!exists.rows[0]) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404);
      throw new TaskRepositoryError("VERSION_CONFLICT", "任务已被更新，请读取最新版本后重试", 409);
    }
    await transaction.query(
      `DELETE FROM entity_links WHERE source_kind = 'project' AND target_kind = 'task' AND target_id = $1 AND relation = 'project-item'${scope.active ? " AND user_id = $2" : ""}`,
      scope.active ? [id, scope.userId] : [id],
    );
    if (projectId) {
      await transaction.query(
        `INSERT INTO entity_links (id, user_id, source_kind, source_id, target_kind, target_id, relation)
         VALUES ($1,$2,'project',$3,'task',$4,'project-item')
         ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING`,
        [`project-task:${id}`, scope.valueOrNull(), projectId, id],
      );
    }
    if (input.sourceReferences) {
      await transaction.query("DELETE FROM task_source_references WHERE task_id = $1", [id]);
      await transaction.query(
        `DELETE FROM entity_links WHERE target_kind = 'task' AND target_id = $1 AND relation = 'derived-task'${scope.active ? " AND user_id = $2" : ""}`,
        scope.active ? [id, scope.userId] : [id],
      );
      for (const source of input.sourceReferences) {
        const sourceReferenceId = randomUUID();
        await transaction.query(
          `INSERT INTO task_source_references (id, task_id, source_kind, source_id, label, href)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [sourceReferenceId, id, source.kind, source.sourceId, source.label, source.href ?? null],
        );
        await transaction.query(
          `INSERT INTO entity_links (id, user_id, source_kind, source_id, target_kind, target_id, relation)
           VALUES ($1,$2,$3,$4,'task',$5,'derived-task')
           ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING`,
          [`source:${sourceReferenceId}`, scope.valueOrNull(), source.kind, source.sourceId, id],
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
  const scope = await getUserScope();
  return database.transaction(async (transaction) => {
    await transaction.query(
      `DELETE FROM entity_links WHERE ((source_kind = 'task' AND source_id = $1) OR (target_kind = 'task' AND target_id = $1))${scope.active ? " AND user_id = $2" : ""}`,
      scope.active ? [taskId, scope.userId] : [taskId],
    );
    const result = await transaction.query<{ id: string }>(
      `DELETE FROM tasks WHERE id = $1${scope.active ? " AND user_id = $2" : ""} RETURNING id`,
      scope.active ? [taskId, scope.userId] : [taskId],
    );
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
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    projectColor: row.project_color ?? undefined,
    planItemId: row.plan_item_id ?? undefined,
    planItemTitle: row.plan_item_title ?? undefined,
    areaName: row.area_name ?? undefined,
    assigneeUserId: row.assignee_user_id ?? undefined,
    assigneeDisplayName: row.assignee_display_name ?? undefined,
    assigneeEmail: row.assignee_email ?? undefined,
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
  const scope = await getUserScope();
  let result;
  if (input.projectId) {
    result = await database.query<TaskProjectRow>(
      `SELECT id, name, area_name, status FROM projects WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [input.projectId, scope.userId] : [input.projectId],
    );
    const selectedProject = result.rows[0];
    if (!selectedProject) {
      throw new TaskRepositoryError("PROJECT_NOT_FOUND", "项目不存在或已归档", 404);
    }
    if (selectedProject.status === "archived") {
      const existingLink = input.id
        ? await database.query<{ project_id: string | null }>(
            `SELECT project_id FROM tasks WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
            scope.active ? [input.id, scope.userId] : [input.id],
          )
        : undefined;
      if (existingLink?.rows[0]?.project_id !== selectedProject.id) {
        throw new TaskRepositoryError("PROJECT_NOT_FOUND", "项目不存在或已归档", 404);
      }
    }
  } else if (input.projectName) {
    result = await database.query<TaskProjectRow>(
      `SELECT id, name, area_name, status FROM projects WHERE lower(trim(name)) = lower(trim($1)) AND status = 'active'${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [input.projectName, scope.userId] : [input.projectName],
    );
  } else {
    return undefined;
  }
  const project = result.rows[0];
  return project
    ? { id: project.id, name: project.name, areaName: project.area_name ?? undefined }
    : undefined;
}
