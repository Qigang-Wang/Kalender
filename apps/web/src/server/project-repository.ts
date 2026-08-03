import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";
import { getStoredProject, listStoredProjectNotes, type StoredNote, type StoredProject } from "./note-repository";
import { listStoredProjectTasks, type StoredTask, type TaskTimeBlock } from "./task-repository";

export const projectMilestoneStatuses = ["planned", "active", "done"] as const;
export type ProjectMilestoneStatus = (typeof projectMilestoneStatuses)[number];

export interface StoredProjectMilestone {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId?: string;
  readonly title: string;
  readonly dueOn?: string;
  readonly status: ProjectMilestoneStatus;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveProjectMilestoneInput {
  readonly id?: string;
  readonly projectId: string;
  readonly phaseId?: string | null;
  readonly title: string;
  readonly dueOn?: string;
  readonly status: ProjectMilestoneStatus;
  readonly sortOrder?: number;
}

export interface StoredProjectPhase {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly color: string;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveProjectPhaseInput {
  readonly id?: string;
  readonly projectId: string;
  readonly name: string;
  readonly color: string;
  readonly sortOrder?: number;
}

export interface ProjectScheduledBlock extends TaskTimeBlock {
  readonly taskId: string;
  readonly taskTitle: string;
}

export interface StoredProjectGanttTask extends StoredTask {
  readonly dependencyIds: readonly string[];
}

export interface SaveProjectTaskPlanInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly dependencyIds: readonly string[];
  readonly phaseId?: string | null;
  readonly durationWorkdays?: number;
  readonly autoSchedule?: boolean;
}

export interface SaveProjectTaskPlanResult {
  readonly task: StoredProjectGanttTask;
  readonly overview: StoredProjectOverview;
}

export interface StoredProjectOverview {
  readonly project: StoredProject;
  readonly tasks: readonly StoredTask[];
  readonly ganttTasks: readonly StoredProjectGanttTask[];
  readonly notes: readonly StoredNote[];
  readonly milestones: readonly StoredProjectMilestone[];
  readonly phases: readonly StoredProjectPhase[];
  readonly scheduledBlocks: readonly ProjectScheduledBlock[];
  readonly stats: {
    readonly totalTaskCount: number;
    readonly openTaskCount: number;
    readonly completedTaskCount: number;
    readonly completionPercent: number;
    readonly noteCount: number;
    readonly scheduledMinutes: number;
  };
  readonly review: {
    readonly completedLast7DaysCount: number;
    readonly overdueTaskCount: number;
    readonly dueNext7DaysCount: number;
    readonly unscheduledOpenTaskCount: number;
    readonly lastActivityAt: string;
    readonly isStalled: boolean;
  };
}

export async function getStoredProjectOverview(projectId: string): Promise<StoredProjectOverview | undefined> {
  const [project, projectTasks, projectNotes, milestones, phases, dependencies] = await Promise.all([
    getStoredProject(projectId),
    listStoredProjectTasks(projectId),
    listStoredProjectNotes(projectId),
    listStoredProjectMilestones(projectId),
    listStoredProjectPhases(projectId),
    listProjectDependencyRows(projectId),
  ]);
  if (!project) return undefined;

  const dependencyIdsByTask = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const entries = dependencyIdsByTask.get(dependency.successor_task_id) ?? [];
    entries.push(dependency.predecessor_task_id);
    dependencyIdsByTask.set(dependency.successor_task_id, entries);
  }
  const ganttTasks = projectTasks.map((task) => ({
    ...task,
    dependencyIds: dependencyIdsByTask.get(task.id) ?? [],
  }));
  const scheduledBlocks = projectTasks
    .flatMap((task) => task.scheduledBlocks.map((block) => ({
      ...block,
      taskId: task.id,
      taskTitle: task.title,
    })))
    .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
  const completedTaskCount = projectTasks.filter((task) => task.status === "done").length;
  const totalTaskCount = projectTasks.length;
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const sevenDaysAhead = now + 7 * 24 * 60 * 60 * 1000;
  const openTasks = projectTasks.filter((task) => task.status !== "done");
  const lastActivityAt = [project.updatedAt, ...projectTasks.map((task) => task.updatedAt), ...projectNotes.map((note) => note.updatedAt)]
    .reduce((latest, value) => new Date(value).getTime() > new Date(latest).getTime() ? value : latest, project.updatedAt);

  return {
    project,
    tasks: projectTasks,
    ganttTasks,
    notes: projectNotes,
    milestones,
    phases,
    scheduledBlocks,
    stats: {
      totalTaskCount,
      openTaskCount: totalTaskCount - completedTaskCount,
      completedTaskCount,
      completionPercent: totalTaskCount ? Math.round((completedTaskCount / totalTaskCount) * 100) : 0,
      noteCount: projectNotes.length,
      scheduledMinutes: scheduledBlocks.reduce((total, block) => (
        total + Math.max(0, Math.round((new Date(block.end).getTime() - new Date(block.start).getTime()) / 60_000))
      ), 0),
    },
    review: {
      completedLast7DaysCount: projectTasks.filter((task) => (
        task.completedAt && new Date(task.completedAt).getTime() >= sevenDaysAgo
      )).length,
      overdueTaskCount: openTasks.filter((task) => task.dueAt && new Date(task.dueAt).getTime() < now).length,
      dueNext7DaysCount: openTasks.filter((task) => {
        if (!task.dueAt) return false;
        const due = new Date(task.dueAt).getTime();
        return due >= now && due <= sevenDaysAhead;
      }).length,
      unscheduledOpenTaskCount: openTasks.filter((task) => task.scheduledBlockCount === 0).length,
      lastActivityAt,
      isStalled: openTasks.length > 0 && new Date(lastActivityAt).getTime() < sevenDaysAgo,
    },
  };
}

interface TaskDependencyRow {
  readonly predecessor_task_id: string;
  readonly successor_task_id: string;
}

interface TaskPlanRow {
  readonly id: string;
  readonly phase_id: string | null;
  readonly planned_start: string | Date | null;
  readonly planned_end: string | Date | null;
  readonly duration_workdays: number | null;
  readonly auto_schedule: boolean;
}

export async function saveStoredProjectTaskPlan(input: SaveProjectTaskPlanInput): Promise<SaveProjectTaskPlanResult> {
  const database = await getDatabase();
  const project = await getStoredProject(input.projectId);
  if (!project) throw new ProjectRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  if (project.status === "archived") {
    throw new ProjectRepositoryError("PROJECT_ARCHIVED", "已归档项目不能修改甘特计划", 409);
  }
  const task = await database.query<TaskPlanRow>(
    `SELECT id, phase_id, planned_start, planned_end, duration_workdays, auto_schedule
       FROM tasks
      WHERE id = $1 AND project_id = $2
      LIMIT 1`,
    [input.taskId, input.projectId],
  );
  const currentTask = task.rows[0];
  if (!currentTask) throw new ProjectRepositoryError("TASK_NOT_FOUND", "项目任务不存在", 404);

  if (input.phaseId) {
    const phase = await database.query<{ id: string }>(
      "SELECT id FROM project_phases WHERE id = $1 AND project_id = $2 LIMIT 1",
      [input.phaseId, input.projectId],
    );
    if (!phase.rows[0]) throw new ProjectRepositoryError("PHASE_NOT_FOUND", "项目阶段不存在", 404);
  }

  const dependencyIds = Array.from(new Set(input.dependencyIds));
  if (dependencyIds.includes(input.taskId)) {
    throw new ProjectRepositoryError("TASK_DEPENDENCY_SELF", "任务不能依赖自身", 400);
  }
  if (dependencyIds.length) {
    const validDependencies = await database.query<{ id: string }>(
      "SELECT id FROM tasks WHERE project_id = $1 AND id = ANY($2::text[])",
      [input.projectId, dependencyIds],
    );
    if (validDependencies.rows.length !== dependencyIds.length) {
      throw new ProjectRepositoryError("TASK_DEPENDENCY_INVALID", "依赖任务必须属于同一个项目", 400);
    }
  }

  const existingDependencies = await listProjectDependencyRows(input.projectId);
  const adjacency = new Map<string, string[]>();
  for (const dependency of existingDependencies) {
    if (dependency.successor_task_id === input.taskId) continue;
    const successors = adjacency.get(dependency.predecessor_task_id) ?? [];
    successors.push(dependency.successor_task_id);
    adjacency.set(dependency.predecessor_task_id, successors);
  }
  for (const predecessorId of dependencyIds) {
    if (hasDependencyPath(adjacency, input.taskId, predecessorId)) {
      throw new ProjectRepositoryError("TASK_DEPENDENCY_CYCLE", "任务依赖不能形成循环", 409);
    }
  }

  const nextPhaseId = input.phaseId === undefined ? currentTask.phase_id : input.phaseId;
  const suppliedStart = input.plannedStart;
  const suppliedEnd = input.plannedEnd;
  const durationDays = input.durationWorkdays
    ?? (suppliedStart && suppliedEnd ? countProjectDays(suppliedStart, suppliedEnd) : currentTask.duration_workdays)
    ?? 1;
  const autoSchedule = input.autoSchedule ?? currentTask.auto_schedule;
  const plannedStart = suppliedStart;
  const plannedEnd = suppliedStart
    ? addProjectDays(suppliedStart, durationDays - 1)
    : suppliedEnd;

  await database.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE tasks
          SET planned_start = $1,
              planned_end = $2,
              phase_id = $3,
              duration_workdays = $4,
              auto_schedule = $5,
              updated_at = now()
        WHERE id = $6 AND project_id = $7`,
      [
        plannedStart ?? null,
        plannedEnd ?? null,
        nextPhaseId,
        durationDays,
        autoSchedule,
        input.taskId,
        input.projectId,
      ],
    );
    await transaction.query(
      "DELETE FROM task_dependencies WHERE project_id = $1 AND successor_task_id = $2",
      [input.projectId, input.taskId],
    );
    if (dependencyIds.length > 0) {
      await transaction.query(
        `INSERT INTO task_dependencies (project_id, predecessor_task_id, successor_task_id)
         SELECT $1, dependency.predecessor_task_id, $2
           FROM unnest($3::text[]) AS dependency(predecessor_task_id)`,
        [input.projectId, input.taskId, dependencyIds],
      );
    }

    const planResult = await transaction.query<TaskPlanRow>(
      `SELECT id, phase_id, planned_start, planned_end, duration_workdays, auto_schedule
         FROM tasks
        WHERE project_id = $1`,
      [input.projectId],
    );
    const dependencyResult = await transaction.query<TaskDependencyRow>(
      `SELECT predecessor_task_id, successor_task_id
         FROM task_dependencies
        WHERE project_id = $1`,
      [input.projectId],
    );
    const plans = new Map(planResult.rows.map((row) => [row.id, {
      ...row,
      planned_start: row.planned_start ? toDateOnly(row.planned_start) : null,
      planned_end: row.planned_end ? toDateOnly(row.planned_end) : null,
    }]));
    const predecessorsByTask = new Map<string, string[]>();
    for (const dependency of dependencyResult.rows) {
      const predecessors = predecessorsByTask.get(dependency.successor_task_id) ?? [];
      predecessors.push(dependency.predecessor_task_id);
      predecessorsByTask.set(dependency.successor_task_id, predecessors);
    }

    const automaticallyScheduled = new Map<string, { readonly plannedStart: string; readonly plannedEnd: string }>();
    for (let pass = 0; pass < plans.size; pass += 1) {
      let changed = false;
      for (const plan of plans.values()) {
        const predecessorIds = predecessorsByTask.get(plan.id) ?? [];
        if (!plan.auto_schedule || !predecessorIds.length) continue;
        const predecessorEnds = predecessorIds
          .map((id) => plans.get(id)?.planned_end)
          .filter((value): value is string => Boolean(value));
        if (predecessorEnds.length !== predecessorIds.length) continue;
        const nextStart = addProjectDays(predecessorEnds.sort().at(-1)!, 1);
        const nextEnd = addProjectDays(nextStart, (plan.duration_workdays ?? 1) - 1);
        if (plan.planned_start === nextStart && plan.planned_end === nextEnd) continue;
        plans.set(plan.id, { ...plan, planned_start: nextStart, planned_end: nextEnd });
        automaticallyScheduled.set(plan.id, { plannedStart: nextStart, plannedEnd: nextEnd });
        changed = true;
      }
      if (!changed) break;
    }
    if (automaticallyScheduled.size > 0) {
      await transaction.query(
        `WITH plan_updates AS (
           SELECT *
             FROM jsonb_to_recordset($2::jsonb) AS plan (
               id text,
               planned_start date,
               planned_end date
             )
         )
         UPDATE tasks task SET
           planned_start = plan.planned_start,
           planned_end = plan.planned_end,
           updated_at = now()
         FROM plan_updates plan
         WHERE task.id = plan.id AND task.project_id = $1`,
        [
          input.projectId,
          JSON.stringify([...automaticallyScheduled].map(([id, plan]) => ({
            id,
            planned_start: plan.plannedStart,
            planned_end: plan.plannedEnd,
          }))),
        ],
      );
    }
  });

  const overview = await getStoredProjectOverview(input.projectId);
  const saved = overview?.ganttTasks.find((entry) => entry.id === input.taskId);
  if (!overview || !saved) throw new ProjectRepositoryError("TASK_PLAN_SAVE_FAILED", "无法保存任务计划", 500);
  return { task: saved, overview };
}

async function listProjectDependencyRows(projectId: string): Promise<readonly TaskDependencyRow[]> {
  const database = await getDatabase();
  const result = await database.query<TaskDependencyRow>(
    `SELECT predecessor_task_id, successor_task_id
       FROM task_dependencies
      WHERE project_id = $1
      ORDER BY created_at`,
    [projectId],
  );
  return result.rows;
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

interface ProjectPhaseRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly color: string;
  readonly sort_order: number;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

export async function listStoredProjectPhases(projectId: string): Promise<readonly StoredProjectPhase[]> {
  if (!await getStoredProject(projectId)) return [];
  const database = await getDatabase();
  const result = await database.query<ProjectPhaseRow>(
    `SELECT id, project_id, name, color, sort_order, created_at, updated_at
       FROM project_phases
      WHERE project_id = $1
      ORDER BY sort_order, created_at`,
    [projectId],
  );
  return result.rows.map(mapProjectPhase);
}

export async function saveStoredProjectPhase(input: SaveProjectPhaseInput): Promise<StoredProjectPhase> {
  const database = await getDatabase();
  const project = await getStoredProject(input.projectId);
  if (!project) throw new ProjectRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  if (project.status === "archived") {
    throw new ProjectRepositoryError("PROJECT_ARCHIVED", "已归档项目不能修改阶段", 409);
  }
  const id = input.id ?? randomUUID();
  if (input.id) {
    const existing = await database.query<{ id: string }>(
      "SELECT id FROM project_phases WHERE id = $1 AND project_id = $2 LIMIT 1",
      [input.id, input.projectId],
    );
    if (!existing.rows[0]) throw new ProjectRepositoryError("PHASE_NOT_FOUND", "项目阶段不存在", 404);
  }
  await database.query(
    `INSERT INTO project_phases (id, project_id, name, color, sort_order, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       color = EXCLUDED.color,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()
     WHERE project_phases.project_id = EXCLUDED.project_id`,
    [id, input.projectId, input.name, input.color, input.sortOrder ?? 0],
  );
  const saved = (await listStoredProjectPhases(input.projectId)).find((phase) => phase.id === id);
  if (!saved) throw new ProjectRepositoryError("PHASE_SAVE_FAILED", "无法保存项目阶段", 500);
  return saved;
}

export async function deleteStoredProjectPhase(projectId: string, phaseId: string): Promise<boolean> {
  const database = await getDatabase();
  const project = await getStoredProject(projectId);
  if (!project) throw new ProjectRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  if (project.status === "archived") {
    throw new ProjectRepositoryError("PROJECT_ARCHIVED", "已归档项目不能修改阶段", 409);
  }
  const result = await database.query<{ id: string }>(
    "DELETE FROM project_phases WHERE id = $1 AND project_id = $2 RETURNING id",
    [phaseId, projectId],
  );
  return Boolean(result.rows[0]);
}

interface ProjectMilestoneRow {
  readonly id: string;
  readonly project_id: string;
  readonly phase_id: string | null;
  readonly title: string;
  readonly due_on: string | Date | null;
  readonly status: ProjectMilestoneStatus;
  readonly sort_order: number;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

export async function listStoredProjectMilestones(projectId: string): Promise<readonly StoredProjectMilestone[]> {
  if (!await getStoredProject(projectId)) return [];
  const database = await getDatabase();
  const result = await database.query<ProjectMilestoneRow>(
    `SELECT id, project_id, phase_id, title, due_on, status, sort_order, created_at, updated_at
       FROM project_milestones
      WHERE project_id = $1
      ORDER BY (status = 'done'), due_on ASC NULLS LAST, sort_order, created_at`,
    [projectId],
  );
  return result.rows.map(mapProjectMilestone);
}

export async function saveStoredProjectMilestone(input: SaveProjectMilestoneInput): Promise<StoredProjectMilestone> {
  const database = await getDatabase();
  const project = await getStoredProject(input.projectId);
  if (!project) throw new ProjectRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  if (project.status === "archived") {
    throw new ProjectRepositoryError("PROJECT_ARCHIVED", "已归档项目不能修改里程碑", 409);
  }
  if (input.phaseId) {
    const phase = await database.query<{ id: string }>(
      "SELECT id FROM project_phases WHERE id = $1 AND project_id = $2 LIMIT 1",
      [input.phaseId, input.projectId],
    );
    if (!phase.rows[0]) throw new ProjectRepositoryError("PHASE_NOT_FOUND", "项目阶段不存在", 404);
  }
  const id = input.id ?? randomUUID();
  if (input.id) {
    const existing = await database.query<{ id: string }>(
      "SELECT id FROM project_milestones WHERE id = $1 AND project_id = $2 LIMIT 1",
      [input.id, input.projectId],
    );
    if (!existing.rows[0]) throw new ProjectRepositoryError("MILESTONE_NOT_FOUND", "里程碑不存在", 404);
  }
  await database.query(
    `INSERT INTO project_milestones (id, project_id, phase_id, title, due_on, status, sort_order, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (id) DO UPDATE SET
       phase_id = CASE WHEN $8 THEN EXCLUDED.phase_id ELSE project_milestones.phase_id END,
       title = EXCLUDED.title,
       due_on = EXCLUDED.due_on,
       status = EXCLUDED.status,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()
     WHERE project_milestones.project_id = EXCLUDED.project_id`,
    [id, input.projectId, input.phaseId ?? null, input.title, input.dueOn ?? null, input.status, input.sortOrder ?? 0, input.phaseId !== undefined],
  );
  const saved = (await listStoredProjectMilestones(input.projectId)).find((milestone) => milestone.id === id);
  if (!saved) throw new ProjectRepositoryError("MILESTONE_SAVE_FAILED", "无法保存里程碑", 500);
  return saved;
}

export async function deleteStoredProjectMilestone(projectId: string, milestoneId: string): Promise<boolean> {
  if (!await getStoredProject(projectId)) return false;
  const database = await getDatabase();
  const result = await database.query<{ id: string }>(
    "DELETE FROM project_milestones WHERE id = $1 AND project_id = $2 RETURNING id",
    [milestoneId, projectId],
  );
  return Boolean(result.rows[0]);
}

export class ProjectRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ProjectRepositoryError";
  }
}

function mapProjectMilestone(row: ProjectMilestoneRow): StoredProjectMilestone {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id ?? undefined,
    title: row.title,
    dueOn: row.due_on ? toDateOnly(row.due_on) : undefined,
    status: row.status,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapProjectPhase(row: ProjectPhaseRow): StoredProjectPhase {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toDateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function countProjectDays(start: string, end: string): number {
  return Math.max(1, Math.round((projectDateToUtcTime(end) - projectDateToUtcTime(start)) / 86_400_000) + 1);
}

function addProjectDays(start: string, additionalDays: number): string {
  return new Date(projectDateToUtcTime(start) + Math.max(0, additionalDays) * 86_400_000).toISOString().slice(0, 10);
}

function projectDateToUtcTime(value: string): number {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}
