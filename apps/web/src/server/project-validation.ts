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
    throw new ProjectValidationError("Gant-Drag-and-Drop-Typ ungültig");
  }
  if (typeof body.itemId !== "string" || !body.itemId.trim() || body.itemId.length > 100) {
    throw new ProjectValidationError("Gant-Drag-and-Drop-Projekt ist ungültig");
  }
  let phaseId: string | null;
  if (body.phaseId === null || body.phaseId === "" || body.phaseId === undefined) phaseId = null;
  else if (typeof body.phaseId === "string" && body.phaseId.trim() && body.phaseId.length <= 100) phaseId = body.phaseId.trim();
  else throw new ProjectValidationError("Projektphase ungültig");
  let beforeId: string | undefined;
  if (body.beforeId !== undefined && body.beforeId !== null && body.beforeId !== "") {
    if (typeof body.beforeId !== "string" || !body.beforeId.trim() || body.beforeId.length > 100) {
      throw new ProjectValidationError("Gant-Drag-and-Drop-Ziel ist ungültig");
    }
    beforeId = body.beforeId.trim();
  }
  if (beforeId === body.itemId) throw new ProjectValidationError("Projekte können nicht in sich hineingezogen werden");
  return { projectId, kind: body.kind, itemId: body.itemId.trim(), phaseId, beforeId };
}

export function parseProjectTaskPlanInput(
  body: ProjectTaskPlanRequestBody | null,
  projectId: string,
  taskId: string,
): SaveProjectTaskPlanInput {
  if (!body) throw new ProjectValidationError("kein Aufgabenplan verfügbar ist");
  const plannedStart = parseOptionalDate(body.plannedStart, "planmäßiges Startdatum");
  const plannedEnd = parseOptionalDate(body.plannedEnd, "planmäßiges Enddatum");
  if ((plannedStart && !plannedEnd) || (!plannedStart && plannedEnd)) {
    throw new ProjectValidationError("geplante Start- und Endtermine müssen gleichzeitig abgeschlossen werden");
  }
  if (plannedStart && plannedEnd && plannedEnd < plannedStart) {
    throw new ProjectValidationError("planmäßiges Enddatum sollte nicht früher als Anfangsdatum sein");
  }
  if (plannedStart && plannedEnd) {
    const duration = new Date(`${plannedEnd}T00:00:00.000Z`).getTime() - new Date(`${plannedStart}T00:00:00.000Z`).getTime();
    if (duration > 5 * 366 * 24 * 60 * 60 * 1000) {
      throw new ProjectValidationError("Die geplante Dauer einer einzelnen Aufgabe darf 5 Jahre nicht überschreiten");
    }
  }
  if (!Array.isArray(body.dependencyIds) || body.dependencyIds.length > 100) {
    throw new ProjectValidationError("Aufgabenabhängigkeit ist ungültig");
  }
  const dependencyIds = body.dependencyIds.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 100) {
      throw new ProjectValidationError("Aufgabenabhängigkeit ist ungültig");
    }
    return value.trim();
  });
  let phaseId: string | null | undefined;
  if (body.phaseId === null || body.phaseId === "") phaseId = null;
  else if (body.phaseId !== undefined) {
    if (typeof body.phaseId !== "string" || !body.phaseId.trim() || body.phaseId.length > 100) {
      throw new ProjectValidationError("Projektphase ungültig");
    }
    phaseId = body.phaseId.trim();
  }
  let durationWorkdays: number | undefined;
  if (body.durationWorkdays !== undefined) {
    durationWorkdays = Number(body.durationWorkdays);
    if (!Number.isInteger(durationWorkdays) || durationWorkdays < 1 || durationWorkdays > 2600) {
      throw new ProjectValidationError("Aufgabenplan im Bereich von 1-2600 Tagen");
    }
  }
  if (body.autoSchedule !== undefined && typeof body.autoSchedule !== "boolean") {
    throw new ProjectValidationError("Ungültige AutoScheduling-Einstellungen");
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
  if (!body || typeof body.name !== "string") throw new ProjectValidationError("Bitte füllen Sie den Künstlernamen aus");
  const name = body.name.trim();
  if (!name || name.length > 120) throw new ProjectValidationError("Name der Bühne erfordert 1–120 Zeichen");
  const color = typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)
    ? body.color
    : "#86bdf5";
  const sortOrder = body.sortOrder === undefined ? undefined : Number(body.sortOrder);
  if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100_000)) {
    throw new ProjectValidationError("stage order ist ungültig");
  }
  return { id, projectId, name, color, sortOrder };
}

export function parseProjectMilestoneInput(
  body: ProjectMilestoneRequestBody | null,
  projectId: string,
  id?: string,
): SaveProjectMilestoneInput {
  if (!body || typeof body.title !== "string") throw new ProjectValidationError("Bitte füllen Sie den Meilenstein-Titel aus");
  const title = body.title.trim();
  if (!title || title.length > 240) throw new ProjectValidationError("Meilenstein-Titel erfordert 1–240 Zeichen");
  let dueOn: string | undefined;
  if (body.dueOn !== undefined && body.dueOn !== null && body.dueOn !== "") {
    if (typeof body.dueOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueOn)) {
      throw new ProjectValidationError("Meilenstein-Datum ungültig");
    }
    const date = new Date(`${body.dueOn}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.dueOn) {
      throw new ProjectValidationError("Meilenstein-Datum ungültig");
    }
    dueOn = body.dueOn;
  }
  const status = projectMilestoneStatuses.includes(body.status as (typeof projectMilestoneStatuses)[number])
    ? body.status as SaveProjectMilestoneInput["status"]
    : "planned";
  const sortOrder = body.sortOrder === undefined ? undefined : Number(body.sortOrder);
  if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100_000)) {
    throw new ProjectValidationError("ist die Meilenstein-Reihenfolge ungültig");
  }
  let phaseId: string | null | undefined;
  if (body.phaseId === null || body.phaseId === "") phaseId = null;
  else if (body.phaseId !== undefined) {
    if (typeof body.phaseId !== "string" || !body.phaseId.trim() || body.phaseId.length > 100) {
      throw new ProjectValidationError("Projektphase ungültig");
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
    throw new ProjectValidationError(`${label}ungültig`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ProjectValidationError(`${label}ungültig`);
  }
  return value;
}
