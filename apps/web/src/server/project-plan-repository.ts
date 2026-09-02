import { randomUUID } from "node:crypto";

import { getDatabase, type DatabaseExecutor } from "./database";
import { getStoredProject } from "./note-repository";
import { ensureProjectAccess } from "./project-collaboration";
import type { ProjectTaskStatus } from "./task-repository";

export interface StoredProjectPlanItem {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId?: string;
  readonly title: string;
  readonly projectStatus: ProjectTaskStatus;
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly ganttSortOrder: number;
  readonly durationWorkdays?: number;
  readonly autoSchedule: boolean;
  readonly dependencyIds: readonly string[];
  readonly linkedTaskCount: number;
  readonly completedTaskCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveProjectPlanItemInput {
  readonly id?: string;
  readonly projectId: string;
  readonly title?: string;
  readonly projectStatus?: ProjectTaskStatus;
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly dependencyIds: readonly string[];
  readonly phaseId?: string | null;
  readonly durationWorkdays?: number;
  readonly autoSchedule?: boolean;
}

interface PlanItemRow {
  readonly id: string;
  readonly project_id: string;
  readonly phase_id: string | null;
  readonly title: string;
  readonly status: ProjectTaskStatus;
  readonly planned_start: string | Date | null;
  readonly planned_end: string | Date | null;
  readonly sort_order: number;
  readonly duration_workdays: number | null;
  readonly auto_schedule: boolean;
  readonly linked_task_count: number | string;
  readonly completed_task_count: number | string;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

interface PlanDependencyRow {
  readonly predecessor_plan_item_id: string;
  readonly successor_plan_item_id: string;
}

interface PlanScheduleRow {
  readonly id: string;
  readonly planned_start: string | Date | null;
  readonly planned_end: string | Date | null;
  readonly duration_workdays: number | null;
  readonly auto_schedule: boolean;
}

export async function listStoredProjectPlanItems(projectId: string): Promise<readonly StoredProjectPlanItem[]> {
  const database = await getDatabase();
  const [items, dependencies] = await Promise.all([
    database.query<PlanItemRow>(
      `SELECT item.id, item.project_id, item.phase_id, item.title, item.status,
              item.planned_start, item.planned_end, item.sort_order,
              item.duration_workdays, item.auto_schedule,
              count(task.id)::int AS linked_task_count,
              count(task.id) FILTER (WHERE task.status = 'done')::int AS completed_task_count,
              item.created_at, item.updated_at
         FROM project_plan_items item
         LEFT JOIN tasks task ON task.plan_item_id = item.id
        WHERE item.project_id = $1
        GROUP BY item.id
        ORDER BY item.sort_order, item.created_at, item.id`,
      [projectId],
    ),
    listDependencyRows(projectId),
  ]);
  const dependencyIdsByItem = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const entries = dependencyIdsByItem.get(dependency.successor_plan_item_id) ?? [];
    entries.push(dependency.predecessor_plan_item_id);
    dependencyIdsByItem.set(dependency.successor_plan_item_id, entries);
  }
  return items.rows.map((row) => mapPlanItem(row, dependencyIdsByItem.get(row.id) ?? []));
}

export async function saveStoredProjectPlanItem(input: SaveProjectPlanItemInput): Promise<StoredProjectPlanItem> {
  const database = await getDatabase();
  const project = await getStoredProject(input.projectId);
  if (!project) throw new ProjectPlanRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  await ensureProjectAccess(input.projectId, "editor");
  if (project.status === "archived") {
    throw new ProjectPlanRepositoryError("PROJECT_ARCHIVED", "已归档项目不能修改计划项", 409);
  }

  const id = input.id ?? randomUUID();
  const current = input.id
    ? (await database.query<PlanItemRow>(
        `SELECT item.id, item.project_id, item.phase_id, item.title, item.status,
                item.planned_start, item.planned_end, item.sort_order,
                item.duration_workdays, item.auto_schedule, 0 AS linked_task_count,
                0 AS completed_task_count, item.created_at, item.updated_at
           FROM project_plan_items item
          WHERE item.id = $1 AND item.project_id = $2 LIMIT 1`,
        [id, input.projectId],
      )).rows[0]
    : undefined;
  if (input.id && !current) {
    throw new ProjectPlanRepositoryError("PLAN_ITEM_NOT_FOUND", "项目计划项不存在", 404);
  }
  const title = input.title ?? current?.title;
  if (!title) throw new ProjectPlanRepositoryError("PLAN_ITEM_TITLE_REQUIRED", "请填写计划项名称", 400);

  if (input.phaseId) {
    const phase = await database.query<{ id: string }>(
      "SELECT id FROM project_phases WHERE id = $1 AND project_id = $2 LIMIT 1",
      [input.phaseId, input.projectId],
    );
    if (!phase.rows[0]) throw new ProjectPlanRepositoryError("PHASE_NOT_FOUND", "项目阶段不存在", 404);
  }

  const dependencyIds = Array.from(new Set(input.dependencyIds));
  if (dependencyIds.includes(id)) {
    throw new ProjectPlanRepositoryError("PLAN_DEPENDENCY_SELF", "计划项不能依赖自身", 400);
  }
  if (dependencyIds.length) {
    const valid = await database.query<{ id: string }>(
      "SELECT id FROM project_plan_items WHERE project_id = $1 AND id = ANY($2::text[])",
      [input.projectId, dependencyIds],
    );
    if (valid.rows.length !== dependencyIds.length) {
      throw new ProjectPlanRepositoryError("PLAN_DEPENDENCY_INVALID", "前置计划项必须属于同一个项目", 400);
    }
  }

  const existingDependencies = await listDependencyRows(input.projectId);
  const adjacency = new Map<string, string[]>();
  for (const dependency of existingDependencies) {
    if (dependency.successor_plan_item_id === id) continue;
    const successors = adjacency.get(dependency.predecessor_plan_item_id) ?? [];
    successors.push(dependency.successor_plan_item_id);
    adjacency.set(dependency.predecessor_plan_item_id, successors);
  }
  for (const predecessorId of dependencyIds) {
    if (hasDependencyPath(adjacency, id, predecessorId)) {
      throw new ProjectPlanRepositoryError("PLAN_DEPENDENCY_CYCLE", "计划项依赖不能形成循环", 409);
    }
  }

  const phaseId = input.phaseId === undefined ? current?.phase_id ?? null : input.phaseId;
  let sortOrder = current?.sort_order ?? 0;
  if (!current || sortOrder === 0 || (current.phase_id ?? null) !== (phaseId ?? null)) {
    const lastSibling = await database.query<{ sort_order: number }>(
      `SELECT COALESCE(max(sort_order), 0)::integer AS sort_order
         FROM project_plan_items
        WHERE project_id = $1 AND phase_id IS NOT DISTINCT FROM $2::text AND id <> $3`,
      [input.projectId, phaseId, id],
    );
    sortOrder = (lastSibling.rows[0]?.sort_order ?? 0) + 1000;
  }
  const durationWorkdays = input.durationWorkdays
    ?? (input.plannedStart && input.plannedEnd ? countProjectDays(input.plannedStart, input.plannedEnd) : current?.duration_workdays)
    ?? 1;
  const plannedStart = input.plannedStart;
  const plannedEnd = plannedStart
    ? addProjectDays(plannedStart, durationWorkdays - 1)
    : input.plannedEnd;
  const status = input.projectStatus ?? current?.status ?? "planned";
  const autoSchedule = input.autoSchedule ?? current?.auto_schedule ?? false;

  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO project_plan_items (
         id, project_id, phase_id, title, status, planned_start, planned_end,
         sort_order, duration_workdays, auto_schedule, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (id) DO UPDATE SET
         phase_id = EXCLUDED.phase_id,
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         planned_start = EXCLUDED.planned_start,
         planned_end = EXCLUDED.planned_end,
         sort_order = EXCLUDED.sort_order,
         duration_workdays = EXCLUDED.duration_workdays,
         auto_schedule = EXCLUDED.auto_schedule,
         updated_at = now()
       WHERE project_plan_items.project_id = EXCLUDED.project_id`,
      [id, input.projectId, phaseId, title, status, plannedStart ?? null, plannedEnd ?? null, sortOrder, durationWorkdays, autoSchedule],
    );
    await transaction.query(
      "DELETE FROM project_plan_item_dependencies WHERE project_id = $1 AND successor_plan_item_id = $2",
      [input.projectId, id],
    );
    if (dependencyIds.length) {
      await transaction.query(
        `INSERT INTO project_plan_item_dependencies (
           project_id, predecessor_plan_item_id, successor_plan_item_id
         ) SELECT $1, dependency.id, $2 FROM unnest($3::text[]) dependency(id)`,
        [input.projectId, id, dependencyIds],
      );
    }
    await autoScheduleProjectPlan(transaction, input.projectId);
  });

  const saved = (await listStoredProjectPlanItems(input.projectId)).find((entry) => entry.id === id);
  if (!saved) throw new ProjectPlanRepositoryError("PLAN_ITEM_SAVE_FAILED", "无法保存项目计划项", 500);
  return saved;
}

export async function deleteStoredProjectPlanItem(projectId: string, planItemId: string): Promise<boolean> {
  const database = await getDatabase();
  const project = await getStoredProject(projectId);
  if (!project) throw new ProjectPlanRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  await ensureProjectAccess(projectId, "editor");
  if (project.status === "archived") {
    throw new ProjectPlanRepositoryError("PROJECT_ARCHIVED", "已归档项目不能删除计划项", 409);
  }
  const result = await database.query(
    "DELETE FROM project_plan_items WHERE id = $1 AND project_id = $2",
    [planItemId, projectId],
  );
  return (result.affectedRows ?? 0) > 0;
}

export async function reorderStoredProjectPlanItem(
  projectId: string,
  itemId: string,
  phaseId: string | null,
  beforeId?: string,
): Promise<void> {
  const database = await getDatabase();
  const project = await getStoredProject(projectId);
  if (!project) throw new ProjectPlanRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  await ensureProjectAccess(projectId, "editor");
  if (project.status === "archived") {
    throw new ProjectPlanRepositoryError("PROJECT_ARCHIVED", "已归档项目不能调整计划顺序", 409);
  }
  await database.transaction(async (transaction) => {
    const current = await transaction.query<{ id: string }>(
      "SELECT id FROM project_plan_items WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [itemId, projectId],
    );
    if (!current.rows[0]) throw new ProjectPlanRepositoryError("PLAN_ITEM_NOT_FOUND", "项目计划项不存在", 404);
    if (phaseId) {
      const phase = await transaction.query<{ id: string }>(
        "SELECT id FROM project_phases WHERE id = $1 AND project_id = $2 LIMIT 1",
        [phaseId, projectId],
      );
      if (!phase.rows[0]) throw new ProjectPlanRepositoryError("PHASE_NOT_FOUND", "项目阶段不存在", 404);
    }
    await transaction.query(
      "UPDATE project_plan_items SET phase_id = $3, updated_at = now() WHERE id = $1 AND project_id = $2",
      [itemId, projectId, phaseId],
    );
    const siblings = await transaction.query<{ id: string }>(
      `SELECT id FROM project_plan_items
        WHERE project_id = $1 AND phase_id IS NOT DISTINCT FROM $2::text AND id <> $3
        ORDER BY sort_order, created_at, id FOR UPDATE`,
      [projectId, phaseId, itemId],
    );
    const orderedIds = insertItem(siblings.rows.map((entry) => entry.id), itemId, beforeId);
    await transaction.query(
      `UPDATE project_plan_items item
          SET sort_order = ordered.sort_order, updated_at = now()
         FROM (
           SELECT id, (ordinality * 1000)::integer AS sort_order
             FROM unnest($2::text[]) WITH ORDINALITY AS entry(id, ordinality)
         ) ordered
        WHERE item.project_id = $1 AND item.id = ordered.id`,
      [projectId, orderedIds],
    );
  });
}

async function autoScheduleProjectPlan(
  transaction: DatabaseExecutor,
  projectId: string,
): Promise<void> {
  const [items, dependencies] = await Promise.all([
    transaction.query<PlanScheduleRow>(
      `SELECT id, planned_start, planned_end, duration_workdays, auto_schedule
         FROM project_plan_items WHERE project_id = $1`,
      [projectId],
    ),
    transaction.query<PlanDependencyRow>(
      `SELECT predecessor_plan_item_id, successor_plan_item_id
         FROM project_plan_item_dependencies WHERE project_id = $1`,
      [projectId],
    ),
  ]);
  const plans = new Map(items.rows.map((row) => [row.id, {
    ...row,
    planned_start: row.planned_start ? toDateOnly(row.planned_start) : null,
    planned_end: row.planned_end ? toDateOnly(row.planned_end) : null,
  }]));
  const predecessorsByItem = new Map<string, string[]>();
  for (const dependency of dependencies.rows) {
    const predecessors = predecessorsByItem.get(dependency.successor_plan_item_id) ?? [];
    predecessors.push(dependency.predecessor_plan_item_id);
    predecessorsByItem.set(dependency.successor_plan_item_id, predecessors);
  }
  const updates = new Map<string, { readonly plannedStart: string; readonly plannedEnd: string }>();
  for (let pass = 0; pass < plans.size; pass += 1) {
    let changed = false;
    for (const plan of plans.values()) {
      const predecessorIds = predecessorsByItem.get(plan.id) ?? [];
      if (!plan.auto_schedule || !predecessorIds.length) continue;
      const predecessorEnds = predecessorIds
        .map((id) => plans.get(id)?.planned_end)
        .filter((value): value is string => Boolean(value));
      if (predecessorEnds.length !== predecessorIds.length) continue;
      const nextStart = addProjectDays(predecessorEnds.sort().at(-1)!, 1);
      const nextEnd = addProjectDays(nextStart, (plan.duration_workdays ?? 1) - 1);
      if (plan.planned_start === nextStart && plan.planned_end === nextEnd) continue;
      plans.set(plan.id, { ...plan, planned_start: nextStart, planned_end: nextEnd });
      updates.set(plan.id, { plannedStart: nextStart, plannedEnd: nextEnd });
      changed = true;
    }
    if (!changed) break;
  }
  if (!updates.size) return;
  await transaction.query(
    `WITH updates AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS value (
         id text, planned_start date, planned_end date
       )
     )
     UPDATE project_plan_items item SET
       planned_start = updates.planned_start,
       planned_end = updates.planned_end,
       updated_at = now()
     FROM updates WHERE item.project_id = $1 AND item.id = updates.id`,
    [projectId, JSON.stringify([...updates].map(([id, value]) => ({ id, planned_start: value.plannedStart, planned_end: value.plannedEnd })))],
  );
}

async function listDependencyRows(projectId: string): Promise<readonly PlanDependencyRow[]> {
  const database = await getDatabase();
  const result = await database.query<PlanDependencyRow>(
    `SELECT predecessor_plan_item_id, successor_plan_item_id
       FROM project_plan_item_dependencies WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return result.rows;
}

function mapPlanItem(row: PlanItemRow, dependencyIds: readonly string[]): StoredProjectPlanItem {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id ?? undefined,
    title: row.title,
    projectStatus: row.status,
    plannedStart: row.planned_start ? toDateOnly(row.planned_start) : undefined,
    plannedEnd: row.planned_end ? toDateOnly(row.planned_end) : undefined,
    ganttSortOrder: row.sort_order,
    durationWorkdays: row.duration_workdays ?? undefined,
    autoSchedule: row.auto_schedule,
    dependencyIds,
    linkedTaskCount: Number(row.linked_task_count),
    completedTaskCount: Number(row.completed_task_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function hasDependencyPath(adjacency: ReadonlyMap<string, readonly string[]>, startId: string, targetId: string): boolean {
  const pending = [startId];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function insertItem(siblingIds: string[], itemId: string, beforeId?: string): string[] {
  if (!beforeId) return [...siblingIds, itemId];
  const index = siblingIds.indexOf(beforeId);
  if (index < 0) throw new ProjectPlanRepositoryError("PLAN_REORDER_TARGET_INVALID", "拖放目标不在当前阶段", 400);
  return [...siblingIds.slice(0, index), itemId, ...siblingIds.slice(index)];
}

function countProjectDays(start: string, end: string): number {
  return Math.max(1, Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000) + 1);
}

function addProjectDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class ProjectPlanRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProjectPlanRepositoryError";
  }
}
