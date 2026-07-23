import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";

export const noteTypes = ["general", "meeting", "email", "project", "daily"] as const;
export type NoteType = (typeof noteTypes)[number];
export type ProjectStatus = "active" | "archived";

export interface StoredProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly areaName?: string;
  readonly color: string;
  readonly status: ProjectStatus;
  readonly noteCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LinkedNoteTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly href: string;
}

export interface StoredNote {
  readonly id: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
  readonly title: string;
  readonly content: string;
  readonly noteType: NoteType;
  readonly pinned: boolean;
  readonly linkedTasks: readonly LinkedNoteTask[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveProjectInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly areaName?: string;
  readonly color: string;
  readonly status: ProjectStatus;
}

export interface SaveNoteInput {
  readonly id?: string;
  readonly projectId?: string;
  readonly title: string;
  readonly content: string;
  readonly noteType: NoteType;
  readonly pinned: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  area_name: string | null;
  color: string;
  status: ProjectStatus;
  note_count: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface NoteRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  project_color: string | null;
  title: string;
  content: string;
  note_type: NoteType;
  pinned: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

export async function listStoredProjects(includeArchived = false): Promise<readonly StoredProject[]> {
  const database = await getDatabase();
  const result = await database.query<ProjectRow>(
    `SELECT p.id, p.name, p.description, p.area_name, p.color, p.status,
            count(n.id)::int AS note_count, p.created_at, p.updated_at
       FROM projects p
       LEFT JOIN notes n ON n.project_id = p.id
      WHERE ($1::boolean OR p.status = 'active')
      GROUP BY p.id
      ORDER BY (p.status = 'archived'), p.updated_at DESC, p.name`,
    [includeArchived],
  );
  return result.rows.map(mapProject);
}

export async function saveStoredProject(input: SaveProjectInput): Promise<StoredProject> {
  const database = await getDatabase();
  const id = input.id ?? randomUUID();
  if (input.id) {
    const existing = await database.query<{ id: string }>("SELECT id FROM projects WHERE id = $1 LIMIT 1", [input.id]);
    if (!existing.rows[0]) throw new NoteRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
  }
  try {
    await database.query(
      `INSERT INTO projects (id, name, description, area_name, color, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         area_name = EXCLUDED.area_name, color = EXCLUDED.color,
         status = EXCLUDED.status, updated_at = now()`,
      [id, input.name, input.description ?? null, input.areaName ?? null, input.color, input.status],
    );
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      throw new NoteRepositoryError("PROJECT_NAME_EXISTS", "已有同名项目", 409);
    }
    throw error;
  }
  const saved = (await listStoredProjects(true)).find((project) => project.id === id);
  if (!saved) throw new NoteRepositoryError("PROJECT_SAVE_FAILED", "无法保存项目", 500);
  return saved;
}

export async function deleteStoredProject(projectId: string): Promise<boolean> {
  const database = await getDatabase();
  const notes = await database.query<{ count: number | string }>("SELECT count(*)::int AS count FROM notes WHERE project_id = $1", [projectId]);
  if (Number(notes.rows[0]?.count ?? 0) > 0) {
    throw new NoteRepositoryError("PROJECT_NOT_EMPTY", "请先移动或删除该项目中的笔记", 409);
  }
  const result = await database.query<{ id: string }>("DELETE FROM projects WHERE id = $1 RETURNING id", [projectId]);
  return Boolean(result.rows[0]);
}

export async function listStoredNotes(): Promise<readonly StoredNote[]> {
  const database = await getDatabase();
  const result = await database.query<NoteRow>(
    `SELECT n.id, n.project_id, p.name AS project_name, p.color AS project_color,
            n.title, n.content, n.note_type, n.pinned, n.created_at, n.updated_at
       FROM notes n
       LEFT JOIN projects p ON p.id = n.project_id
      ORDER BY n.pinned DESC, n.updated_at DESC, n.title`,
  );
  return attachLinkedTasks(result.rows);
}

export async function getStoredNote(noteId: string): Promise<StoredNote | undefined> {
  const database = await getDatabase();
  const result = await database.query<NoteRow>(
    `SELECT n.id, n.project_id, p.name AS project_name, p.color AS project_color,
            n.title, n.content, n.note_type, n.pinned, n.created_at, n.updated_at
       FROM notes n LEFT JOIN projects p ON p.id = n.project_id
      WHERE n.id = $1 LIMIT 1`,
    [noteId],
  );
  return (await attachLinkedTasks(result.rows))[0];
}

export async function saveStoredNote(input: SaveNoteInput): Promise<StoredNote> {
  const database = await getDatabase();
  const id = input.id ?? randomUUID();
  if (input.id) {
    const existing = await database.query<{ id: string }>("SELECT id FROM notes WHERE id = $1 LIMIT 1", [input.id]);
    if (!existing.rows[0]) throw new NoteRepositoryError("NOTE_NOT_FOUND", "笔记不存在", 404);
  }
  if (input.projectId) {
    const project = await database.query<{ id: string }>("SELECT id FROM projects WHERE id = $1 AND status = 'active' LIMIT 1", [input.projectId]);
    if (!project.rows[0]) throw new NoteRepositoryError("PROJECT_NOT_FOUND", "项目不存在或已归档", 404);
  }
  await database.query(
    `INSERT INTO notes (id, project_id, title, content, note_type, pinned, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (id) DO UPDATE SET
       project_id = EXCLUDED.project_id, title = EXCLUDED.title,
       content = EXCLUDED.content, note_type = EXCLUDED.note_type,
       pinned = EXCLUDED.pinned, updated_at = now()`,
    [id, input.projectId ?? null, input.title, input.content, input.noteType, input.pinned],
  );
  const saved = await getStoredNote(id);
  if (!saved) throw new NoteRepositoryError("NOTE_SAVE_FAILED", "无法保存笔记", 500);
  return saved;
}

export async function deleteStoredNote(noteId: string): Promise<boolean> {
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM task_source_references WHERE source_kind = 'note' AND source_id = $1", [noteId]);
    await transaction.query(
      "DELETE FROM entity_links WHERE (source_kind = 'note' AND source_id = $1) OR (target_kind = 'note' AND target_id = $1)",
      [noteId],
    );
    const result = await transaction.query<{ id: string }>("DELETE FROM notes WHERE id = $1 RETURNING id", [noteId]);
    return Boolean(result.rows[0]);
  });
}

export class NoteRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "NoteRepositoryError";
  }
}

async function attachLinkedTasks(rows: readonly NoteRow[]): Promise<readonly StoredNote[]> {
  if (!rows.length) return [];
  const database = await getDatabase();
  const tasks = await database.query<{ source_id: string; id: string; title: string; status: string }>(
    `SELECT r.source_id, t.id, t.title, t.status
       FROM task_source_references r
       JOIN tasks t ON t.id = r.task_id
      WHERE r.source_kind = 'note' AND r.source_id = ANY($1::text[])
      ORDER BY t.updated_at DESC`,
    [rows.map((row) => row.id)],
  );
  const tasksByNote = new Map<string, LinkedNoteTask[]>();
  for (const row of tasks.rows) {
    const entries = tasksByNote.get(row.source_id) ?? [];
    entries.push({ id: row.id, title: row.title, status: row.status, href: `/tasks?task=${encodeURIComponent(row.id)}` });
    tasksByNote.set(row.source_id, entries);
  }
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    projectColor: row.project_color ?? undefined,
    title: row.title,
    content: row.content,
    noteType: row.note_type,
    pinned: row.pinned,
    linkedTasks: tasksByNote.get(row.id) ?? [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

function mapProject(row: ProjectRow): StoredProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    areaName: row.area_name ?? undefined,
    color: row.color,
    status: row.status,
    noteCount: Number(row.note_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
