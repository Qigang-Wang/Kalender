import { noteTypes, type SaveNoteInput, type SaveProjectInput } from "./note-repository";

export interface ProjectRequestBody {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly areaName?: unknown;
  readonly color?: unknown;
  readonly status?: unknown;
  readonly sortOrder?: unknown;
}

export interface ProjectAreaRenameRequestBody {
  readonly previousName?: unknown;
  readonly name?: unknown;
}

export interface NoteRequestBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  readonly content?: unknown;
  readonly noteType?: unknown;
  readonly pinned?: unknown;
}

export function parseProjectInput(body: ProjectRequestBody | null, id?: string): SaveProjectInput {
  if (!body || typeof body.name !== "string") throw new NoteValidationError("Bitte füllen Sie den Projektnamen aus");
  const name = body.name.trim();
  if (!name || name.length > 100) throw new NoteValidationError("Projektname erfordert 1-100 Zeichen");
  const color = typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : "#86bdf5";
  return {
    id,
    name,
    description: optionalText(body.description, 2_000, "Projektbeschreibung"),
    areaName: optionalText(body.areaName, 100, "Domainname"),
    color,
    status: body.status === "archived" ? "archived" : "active",
    sortOrder: optionalSortOrder(body.sortOrder),
  };
}

export function parseProjectReorderInput(body: { readonly projectIds?: unknown } | null): readonly string[] {
  if (!body || !Array.isArray(body.projectIds)) throw new NoteValidationError("die Reihenfolge der Projekte ungültig ist");
  const projectIds = body.projectIds.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 100) {
      throw new NoteValidationError("die Reihenfolge der Projekte ungültig ist");
    }
    return value.trim();
  });
  if (!projectIds.length || projectIds.length > 500) throw new NoteValidationError("die Reihenfolge der Projekte ungültig ist");
  return projectIds;
}

export function parseProjectAreaRenameInput(body: ProjectAreaRenameRequestBody | null): {
  readonly previousName: string;
  readonly name: string;
} {
  if (!body || typeof body.previousName !== "string" || typeof body.name !== "string") {
    throw new NoteValidationError("Feld-Umbenennung-Parameter ungültig");
  }
  const previousName = body.previousName.trim();
  const name = body.name.trim();
  if (!previousName || previousName.length > 100 || !name || name.length > 100) {
    throw new NoteValidationError("Feldname erfordert 1-100 Zeichen");
  }
  if (previousName === "Nicht kategorisiert" || name === "Nicht kategorisiert") {
    throw new NoteValidationError("\"Unklassifiziert\" ist eine Systemgruppe und kann weder umbenannt noch als Gebietsname benannt werden.");
  }
  if (previousName === name) throw new NoteValidationError("Bitte geben Sie einen anderen Feldnamen ein");
  return { previousName, name };
}

export function parseNoteInput(body: NoteRequestBody | null, id?: string): SaveNoteInput {
  if (!body || typeof body.title !== "string") throw new NoteValidationError("Bitte füllen Sie den Titel der Notizen aus");
  const title = body.title.trim();
  if (!title || title.length > 240) throw new NoteValidationError("Notiztitel erfordert 1–240 Zeichen");
  if (body.content !== undefined && typeof body.content !== "string") throw new NoteValidationError("Ungültiger Notizkörper");
  const content = typeof body.content === "string" ? body.content : "";
  if (content.length > 500_000) throw new NoteValidationError("Notiztext darf 500.000 Zeichen nicht überschreiten");
  return {
    id,
    projectId: typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined,
    title,
    content,
    noteType: noteTypes.includes(body.noteType as (typeof noteTypes)[number]) ? body.noteType as SaveNoteInput["noteType"] : "general",
    pinned: body.pinned === true,
  };
}

export class NoteValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "NoteValidationError";
  }
}

function optionalText(value: unknown, maximum: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new NoteValidationError(`${label}zu lang`);
  return value.trim() || undefined;
}

function optionalSortOrder(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const sortOrder = Number(value);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000_000) {
    throw new NoteValidationError("die Reihenfolge der Projekte ungültig ist");
  }
  return sortOrder;
}
