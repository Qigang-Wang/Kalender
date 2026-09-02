import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";
import { getStoredProject, listStoredProjectNotes, type StoredNote, type StoredProject } from "./note-repository";
import { listStoredProjectPlanItems, type StoredProjectPlanItem } from "./project-plan-repository";
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

export interface ReorderProjectTimelineItemInput {
  readonly projectId: string;
  readonly kind: "planItem" | "milestone";
  readonly itemId: string;
  readonly phaseId: string | null;
  readonly beforeId?: string;
}

export interface StoredProjectOverview {
  readonly project: StoredProject;
  readonly tasks: readonly StoredTask[];
  readonly planItems: readonly StoredProjectPlanItem[];
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
  const [project, projectTasks, projectNotes, milestones, phases, planItems] = await Promise.all([
    getStoredProject(projectId),
    listStoredProjectTasks(projectId),
    listStoredProjectNotes(projectId),
    listStoredProjectMilestones(projectId),
    listStoredProjectPhases(projectId),
    listStoredProjectPlanItems(projectId),
  ]);
  if (!project) return undefined;

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
  const lastActivityAt = [
    project.updatedAt,
    ...projectTasks.map((task) => task.updatedAt),
    ...planItems.map((item) => item.updatedAt),
    ...projectNotes.map((note) => note.updatedAt),
  ]
    .reduce((latest, value) => new Date(value).getTime() > new Date(latest).getTime() ? value : latest, project.updatedAt);

  return {
    project,
    tasks: projectTasks,
    planItems,
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

export async function reorderStoredProjectMilestone(
  input: ReorderProjectTimelineItemInput,
): Promise<StoredProjectOverview> {
  const database = await getDatabase();
  const project = await getStoredProject(input.projectId);
  if (!project) throw new ProjectRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  if (project.status === "archived") {
    throw new ProjectRepositoryError("PROJECT_ARCHIVED", "已归档项目不能调整甘特顺序", 409);
  }
  if (input.phaseId) {
    const phase = await database.query<{ id: string }>(
      "SELECT id FROM project_phases WHERE id = $1 AND project_id = $2 LIMIT 1",
      [input.phaseId, input.projectId],
    );
    if (!phase.rows[0]) throw new ProjectRepositoryError("PHASE_NOT_FOUND", "项目阶段不存在", 404);
  }

  await database.transaction(async (transaction) => {
    const current = await transaction.query<{ id: string }>(
      "SELECT id FROM project_milestones WHERE id = $1 AND project_id = $2 FOR UPDATE",
      [input.itemId, input.projectId],
    );
    if (!current.rows[0]) throw new ProjectRepositoryError("MILESTONE_NOT_FOUND", "里程碑不存在", 404);
    const siblings = await transaction.query<{ id: string }>(
      `SELECT id
         FROM project_milestones
        WHERE project_id = $1
          AND phase_id IS NOT DISTINCT FROM $2::text
          AND id <> $3
        ORDER BY sort_order, due_on ASC NULLS LAST, created_at, id
        FOR UPDATE`,
      [input.projectId, input.phaseId, input.itemId],
    );
    const orderedIds = insertProjectGanttItem(siblings.rows.map((entry) => entry.id), input.itemId, input.beforeId);
    await transaction.query(
      `UPDATE project_milestones milestone
          SET phase_id = $2,
              sort_order = ordered.sort_order,
              updated_at = now()
         FROM (
           SELECT id, (ordinality * 1000)::integer AS sort_order
             FROM unnest($3::text[]) WITH ORDINALITY AS item(id, ordinality)
         ) ordered
        WHERE milestone.project_id = $1 AND milestone.id = ordered.id`,
      [input.projectId, input.phaseId, orderedIds],
    );
  });

  const overview = await getStoredProjectOverview(input.projectId);
  if (!overview) throw new ProjectRepositoryError("GANTT_REORDER_FAILED", "无法保存甘特顺序", 500);
  return overview;
}

function insertProjectGanttItem(siblingIds: string[], itemId: string, beforeId?: string): string[] {
  if (!beforeId) return [...siblingIds, itemId];
  const index = siblingIds.indexOf(beforeId);
  if (index < 0) throw new ProjectRepositoryError("GANTT_REORDER_TARGET_INVALID", "拖放目标不在当前阶段", 400);
  return [...siblingIds.slice(0, index), itemId, ...siblingIds.slice(index)];
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
      ORDER BY phase_id ASC NULLS LAST, sort_order, due_on ASC NULLS LAST, created_at`,
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
  let existingMilestone: { readonly id: string; readonly phase_id: string | null; readonly sort_order: number } | undefined;
  if (input.id) {
    const existing = await database.query<{ id: string; phase_id: string | null; sort_order: number }>(
      "SELECT id, phase_id, sort_order FROM project_milestones WHERE id = $1 AND project_id = $2 LIMIT 1",
      [input.id, input.projectId],
    );
    existingMilestone = existing.rows[0];
    if (!existingMilestone) throw new ProjectRepositoryError("MILESTONE_NOT_FOUND", "里程碑不存在", 404);
  }
  const targetPhaseId = input.phaseId === undefined ? existingMilestone?.phase_id ?? null : input.phaseId;
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    if (existingMilestone && (existingMilestone.phase_id ?? null) === (targetPhaseId ?? null)) {
      sortOrder = existingMilestone.sort_order;
    } else {
      const lastSibling = await database.query<{ sort_order: number }>(
        `SELECT COALESCE(max(sort_order), 0)::integer AS sort_order
           FROM project_milestones
          WHERE project_id = $1
            AND phase_id IS NOT DISTINCT FROM $2::text
            AND id <> $3`,
        [input.projectId, targetPhaseId, id],
      );
      sortOrder = (lastSibling.rows[0]?.sort_order ?? 0) + 1000;
    }
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
    [id, input.projectId, input.phaseId ?? null, input.title, input.dueOn ?? null, input.status, sortOrder, input.phaseId !== undefined],
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
