import { noteTypes, type SaveNoteInput, type SaveProjectInput } from "./note-repository";

export interface ProjectRequestBody {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly areaName?: unknown;
  readonly color?: unknown;
  readonly status?: unknown;
}

export interface NoteRequestBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  readonly content?: unknown;
  readonly noteType?: unknown;
  readonly pinned?: unknown;
}

export function parseProjectInput(body: ProjectRequestBody | null, id?: string): SaveProjectInput {
  if (!body || typeof body.name !== "string") throw new NoteValidationError("请填写项目名称");
  const name = body.name.trim();
  if (!name || name.length > 100) throw new NoteValidationError("项目名称需要 1–100 个字符");
  const color = typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : "#86bdf5";
  return {
    id,
    name,
    description: optionalText(body.description, 2_000, "项目说明"),
    areaName: optionalText(body.areaName, 100, "领域名称"),
    color,
    status: body.status === "archived" ? "archived" : "active",
  };
}

export function parseNoteInput(body: NoteRequestBody | null, id?: string): SaveNoteInput {
  if (!body || typeof body.title !== "string") throw new NoteValidationError("请填写笔记标题");
  const title = body.title.trim();
  if (!title || title.length > 240) throw new NoteValidationError("笔记标题需要 1–240 个字符");
  if (body.content !== undefined && typeof body.content !== "string") throw new NoteValidationError("笔记正文无效");
  const content = typeof body.content === "string" ? body.content : "";
  if (content.length > 500_000) throw new NoteValidationError("笔记正文不能超过 500,000 个字符");
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
  if (typeof value !== "string" || value.length > maximum) throw new NoteValidationError(`${label}内容过长`);
  return value.trim() || undefined;
}
