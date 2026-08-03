import {
  projectMilestoneStatuses,
  type ReorderProjectGanttItemInput,
  type SaveProjectPhaseInput,
  type SaveProjectMilestoneInput,
  type SaveProjectTaskPlanInput,
} from "./project-repository";

export interface ProjectMilestoneRequestBody {
  readonly title?: unknown;
  readonly dueOn?: unknown;
  readonly status?: unknown;
  readonly sortOrder?: unknown;
  readonly phaseId?: unknown;
}

export interface ProjectTaskPlanRequestBody {
  readonly plannedStart?: unknown;
  readonly plannedEnd?: unknown;
  readonly dependencyIds?: unknown;
  readonly phaseId?: unknown;
  readonly durationWorkdays?: unknown;
  readonly autoSchedule?: unknown;
}

export interface ProjectPhaseRequestBody {
  readonly name?: unknown;
  readonly color?: unknown;
  readonly sortOrder?: unknown;
}

export interface ProjectGanttReorderRequestBody {
  readonly kind?: unknown;
  readonly itemId?: unknown;
  readonly phaseId?: unknown;
  readonly beforeId?: unknown;
}

export function parseProjectGanttReorderInput(
  body: ProjectGanttReorderRequestBody | null,
  projectId: string,
): ReorderProjectGanttItemInput {
  if (!body || (body.kind !== "task" && body.kind !== "milestone")) {
    throw new ProjectValidationError("甘特拖放类型无效");
  }
  if (typeof body.itemId !== "string" || !body.itemId.trim() || body.itemId.length > 100) {
    throw new ProjectValidationError("甘特拖放项目无效");
  }
  let phaseId: string | null;
  if (body.phaseId === null || body.phaseId === "" || body.phaseId === undefined) phaseId = null;
  else if (typeof body.phaseId === "string" && body.phaseId.trim() && body.phaseId.length <= 100) phaseId = body.phaseId.trim();
  else throw new ProjectValidationError("项目阶段无效");
  let beforeId: string | undefined;
  if (body.beforeId !== undefined && body.beforeId !== null && body.beforeId !== "") {
    if (typeof body.beforeId !== "string" || !body.beforeId.trim() || body.beforeId.length > 100) {
      throw new ProjectValidationError("甘特拖放目标无效");
    }
    beforeId = body.beforeId.trim();
  }
  if (beforeId === body.itemId) throw new ProjectValidationError("不能将项目拖放到自身");
  return { projectId, kind: body.kind, itemId: body.itemId.trim(), phaseId, beforeId };
}

export function parseProjectTaskPlanInput(
  body: ProjectTaskPlanRequestBody | null,
  projectId: string,
  taskId: string,
): SaveProjectTaskPlanInput {
  if (!body) throw new ProjectValidationError("缺少任务计划");
  const plannedStart = parseOptionalDate(body.plannedStart, "计划开始日期");
  const plannedEnd = parseOptionalDate(body.plannedEnd, "计划结束日期");
  if ((plannedStart && !plannedEnd) || (!plannedStart && plannedEnd)) {
    throw new ProjectValidationError("计划开始和结束日期需要同时填写");
  }
  if (plannedStart && plannedEnd && plannedEnd < plannedStart) {
    throw new ProjectValidationError("计划结束日期不能早于开始日期");
  }
  if (plannedStart && plannedEnd) {
    const duration = new Date(`${plannedEnd}T00:00:00.000Z`).getTime() - new Date(`${plannedStart}T00:00:00.000Z`).getTime();
    if (duration > 5 * 366 * 24 * 60 * 60 * 1000) {
      throw new ProjectValidationError("单个任务的计划跨度不能超过 5 年");
    }
  }
  if (!Array.isArray(body.dependencyIds) || body.dependencyIds.length > 100) {
    throw new ProjectValidationError("任务依赖无效");
  }
  const dependencyIds = body.dependencyIds.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 100) {
      throw new ProjectValidationError("任务依赖无效");
    }
    return value.trim();
  });
  let phaseId: string | null | undefined;
  if (body.phaseId === null || body.phaseId === "") phaseId = null;
  else if (body.phaseId !== undefined) {
    if (typeof body.phaseId !== "string" || !body.phaseId.trim() || body.phaseId.length > 100) {
      throw new ProjectValidationError("项目阶段无效");
    }
    phaseId = body.phaseId.trim();
  }
  let durationWorkdays: number | undefined;
  if (body.durationWorkdays !== undefined) {
    durationWorkdays = Number(body.durationWorkdays);
    if (!Number.isInteger(durationWorkdays) || durationWorkdays < 1 || durationWorkdays > 2600) {
      throw new ProjectValidationError("任务工期需要在 1–2600 天之间");
    }
  }
  if (body.autoSchedule !== undefined && typeof body.autoSchedule !== "boolean") {
    throw new ProjectValidationError("自动排期设置无效");
  }
  return {
    projectId,
    taskId,
    plannedStart,
    plannedEnd,
    dependencyIds,
    phaseId,
    durationWorkdays,
    autoSchedule: body.autoSchedule as boolean | undefined,
  };
}

export function parseProjectPhaseInput(
  body: ProjectPhaseRequestBody | null,
  projectId: string,
  id?: string,
): SaveProjectPhaseInput {
  if (!body || typeof body.name !== "string") throw new ProjectValidationError("请填写阶段名称");
  const name = body.name.trim();
  if (!name || name.length > 120) throw new ProjectValidationError("阶段名称需要 1–120 个字符");
  const color = typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)
    ? body.color
    : "#86bdf5";
  const sortOrder = body.sortOrder === undefined ? undefined : Number(body.sortOrder);
  if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100_000)) {
    throw new ProjectValidationError("阶段顺序无效");
  }
  return { id, projectId, name, color, sortOrder };
}

export function parseProjectMilestoneInput(
  body: ProjectMilestoneRequestBody | null,
  projectId: string,
  id?: string,
): SaveProjectMilestoneInput {
  if (!body || typeof body.title !== "string") throw new ProjectValidationError("请填写里程碑标题");
  const title = body.title.trim();
  if (!title || title.length > 240) throw new ProjectValidationError("里程碑标题需要 1–240 个字符");
  let dueOn: string | undefined;
  if (body.dueOn !== undefined && body.dueOn !== null && body.dueOn !== "") {
    if (typeof body.dueOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueOn)) {
      throw new ProjectValidationError("里程碑日期无效");
    }
    const date = new Date(`${body.dueOn}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.dueOn) {
      throw new ProjectValidationError("里程碑日期无效");
    }
    dueOn = body.dueOn;
  }
  const status = projectMilestoneStatuses.includes(body.status as (typeof projectMilestoneStatuses)[number])
    ? body.status as SaveProjectMilestoneInput["status"]
    : "planned";
  const sortOrder = body.sortOrder === undefined ? undefined : Number(body.sortOrder);
  if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100_000)) {
    throw new ProjectValidationError("里程碑顺序无效");
  }
  let phaseId: string | null | undefined;
  if (body.phaseId === null || body.phaseId === "") phaseId = null;
  else if (body.phaseId !== undefined) {
    if (typeof body.phaseId !== "string" || !body.phaseId.trim() || body.phaseId.length > 100) {
      throw new ProjectValidationError("项目阶段无效");
    }
    phaseId = body.phaseId.trim();
  }
  return { id, projectId, title, dueOn, status, sortOrder, phaseId };
}

export class ProjectValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

function parseOptionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ProjectValidationError(`${label}无效`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ProjectValidationError(`${label}无效`);
  }
  return value;
}
