import {
  taskSourceKinds,
  taskStatuses,
  taskUrgencyModes,
  type SaveTaskInput,
  type TaskSourceReference,
} from "./task-repository";

export interface TaskRequestBody {
  readonly title?: unknown;
  readonly notes?: unknown;
  readonly status?: unknown;
  readonly important?: unknown;
  readonly urgencyMode?: unknown;
  readonly dueAt?: unknown;
  readonly estimatedMinutes?: unknown;
  readonly projectId?: unknown;
  readonly projectName?: unknown;
  readonly areaName?: unknown;
  readonly assigneeUserId?: unknown;
  readonly sourceReferences?: unknown;
}

export function parseTaskInput(body: TaskRequestBody | null, id?: string): SaveTaskInput {
  if (!body || typeof body.title !== "string") throw new TaskValidationError("Bitte geben Sie einen Aufgabentitel ein.");
  const title = body.title.trim();
  if (!title || title.length > 240) throw new TaskValidationError("Aufgabentitel erfordert 1–240 Zeichen");
  const status = taskStatuses.includes(body.status as (typeof taskStatuses)[number])
    ? body.status as SaveTaskInput["status"]
    : "inbox";
  const urgencyMode = taskUrgencyModes.includes(body.urgencyMode as (typeof taskUrgencyModes)[number])
    ? body.urgencyMode as SaveTaskInput["urgencyMode"]
    : "auto";
  let dueAt: string | undefined;
  if (body.dueAt !== undefined && body.dueAt !== null && body.dueAt !== "") {
    if (typeof body.dueAt !== "string") throw new TaskValidationError("Ungültige Frist");
    const date = new Date(body.dueAt);
    if (Number.isNaN(date.getTime())) throw new TaskValidationError("Ungültige Frist");
    dueAt = date.toISOString();
  }
  let estimatedMinutes: number | undefined;
  if (body.estimatedMinutes !== undefined && body.estimatedMinutes !== null && body.estimatedMinutes !== "") {
    const value = Number(body.estimatedMinutes);
    if (!Number.isInteger(value) || value < 5 || value > 1440) {
      throw new TaskValidationError("voraussichtliche Dauer zwischen 5 - 1440 Minuten");
    }
    estimatedMinutes = value;
  }
  return {
    id,
    title,
    notes: optionalText(body.notes, 10_000, "Notizen"),
    status,
    important: body.important === true,
    urgencyMode,
    dueAt,
    estimatedMinutes,
    projectId: optionalText(body.projectId, 100, "Projektidentifikation"),
    projectName: optionalText(body.projectName, 100, "Projektname"),
    areaName: optionalText(body.areaName, 100, "Domainname"),
    assigneeUserId: optionalText(body.assigneeUserId, 100, "Benutzer zuweisen"),
    sourceReferences: parseSources(body.sourceReferences),
  };
}

export class TaskValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

function optionalText(value: unknown, maximum: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new TaskValidationError(`${label}zu lang`);
  return value.trim() || undefined;
}

function parseSources(value: unknown): readonly Omit<TaskSourceReference, "id">[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new TaskValidationError("die Task-Quelle ist ungültig");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new TaskValidationError("die Task-Quelle ist ungültig");
    const source = entry as Record<string, unknown>;
    if (!taskSourceKinds.includes(source.kind as (typeof taskSourceKinds)[number])) throw new TaskValidationError("Ungültiger Aufgabenquellentyp");
    if (typeof source.sourceId !== "string" || !source.sourceId.trim() || source.sourceId.length > 500) throw new TaskValidationError("die Task-Source-ID ist ungültig");
    if (typeof source.label !== "string" || !source.label.trim() || source.label.length > 240) throw new TaskValidationError("der Titel der Task-Quelle ist ungültig");
    if (source.href !== undefined && (typeof source.href !== "string" || source.href.length > 2000)) throw new TaskValidationError("Ungültige Aufgabenquelle");
    return {
      kind: source.kind as TaskSourceReference["kind"],
      sourceId: source.sourceId.trim(),
      label: source.label.trim(),
      href: typeof source.href === "string" && source.href.trim() ? source.href.trim() : undefined,
    };
  });
}
