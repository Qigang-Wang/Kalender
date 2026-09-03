import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";
import { ensureProjectAccess, visibleProjectWhere } from "./project-collaboration";
import { getUserScope } from "./user-scope";

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
  readonly sortOrder: number;
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
  readonly sortOrder?: number;
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
  sort_order: number;
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
  const scope = await getUserScope();
  const scoped = await visibleProjectWhere("p", [includeArchived]);
  const result = await database.query<ProjectRow>(
    `SELECT p.id, p.name, p.description, p.area_name, p.color, p.status, p.sort_order,
            count(n.id)::int AS note_count, p.created_at, p.updated_at
       FROM projects p
       LEFT JOIN notes n ON n.project_id = p.id${scope.active ? " AND n.user_id = p.user_id" : ""}
      WHERE ($1::boolean OR p.status = 'active')${scoped.clause ? ` AND ${scoped.clause}` : ""}
      GROUP BY p.id
      ORDER BY (p.status = 'archived'), coalesce(p.area_name, ''), p.sort_order, p.name`,
    scoped.parameters,
  );
  return result.rows.map(mapProject);
}

export async function getStoredProject(projectId: string): Promise<StoredProject | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const scoped = await visibleProjectWhere("p", [projectId]);
  const result = await database.query<ProjectRow>(
    `SELECT p.id, p.name, p.description, p.area_name, p.color, p.status, p.sort_order,
            count(n.id)::int AS note_count, p.created_at, p.updated_at
       FROM projects p
       LEFT JOIN notes n ON n.project_id = p.id${scope.active ? " AND n.user_id = p.user_id" : ""}
      WHERE p.id = $1${scoped.clause ? ` AND ${scoped.clause}` : ""}
      GROUP BY p.id
      LIMIT 1`,
    scoped.parameters,
  );
  return result.rows[0] ? mapProject(result.rows[0]) : undefined;
}

export async function saveStoredProject(input: SaveProjectInput): Promise<StoredProject> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const id = input.id ?? randomUUID();
  if (input.id) {
    await ensureProjectAccess(input.id, "editor");
  }
  const sortOrder = input.sortOrder ?? (input.id ? undefined : await nextProjectSortOrder(input.areaName, input.status));
  try {
    await database.query(
      `INSERT INTO projects (id, user_id, name, description, area_name, color, status, sort_order, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, 0),now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         area_name = EXCLUDED.area_name, color = EXCLUDED.color,
         status = EXCLUDED.status,
         sort_order = COALESCE($8, projects.sort_order),
         updated_at = now()`,
      [id, scope.valueOrNull(), input.name, input.description ?? null, input.areaName ?? null, input.color, input.status, sortOrder ?? null],
    );
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      throw new NoteRepositoryError("PROJECT_NAME_EXISTS", "已有同名项目", 409);
    }
    throw error;
  }
  const saved = await getStoredProject(id);
  if (!saved) throw new NoteRepositoryError("PROJECT_SAVE_FAILED", "无法保存项目", 500);
  return saved;
}

export async function reorderStoredProjects(projectIds: readonly string[]): Promise<readonly StoredProject[]> {
  const normalizedIds = Array.from(new Set(projectIds.map((id) => id.trim()).filter(Boolean)));
  if (!normalizedIds.length) throw new NoteRepositoryError("PROJECT_REORDER_EMPTY", "请提供项目顺序", 400);
  if (normalizedIds.length > 500) throw new NoteRepositoryError("PROJECT_REORDER_TOO_LARGE", "一次最多重排 500 个项目", 400);
  const database = await getDatabase();
  for (const projectId of normalizedIds) await ensureProjectAccess(projectId, "editor");
  await database.query(
    `WITH ordered AS (
       SELECT *
         FROM unnest($1::text[]) WITH ORDINALITY AS item(id, position)
     )
     UPDATE projects p
        SET sort_order = ordered.position * 1000,
            updated_at = now()
       FROM ordered
      WHERE p.id = ordered.id`,
    [normalizedIds],
  );
  const result = await Promise.all(normalizedIds.map((id) => getStoredProject(id)));
  return result.filter((project): project is StoredProject => Boolean(project));
}

export async function renameStoredProjectArea(previousName: string, name: string): Promise<{
  readonly previousName: string;
  readonly name: string;
  readonly projectsUpdated: number;
}> {
  const database = await getDatabase();
  const sourceScope = await visibleProjectWhere("p", [previousName]);
  const source = await database.query<{ id: string }>(
    `SELECT p.id
       FROM projects p
      WHERE p.area_name = $1${sourceScope.clause ? ` AND ${sourceScope.clause}` : ""}
      ORDER BY p.id`,
    sourceScope.parameters,
  );
  if (!source.rows.length) {
    throw new NoteRepositoryError("PROJECT_AREA_NOT_FOUND", "领域不存在或已经被重命名", 404);
  }
  for (const project of source.rows) {
    await ensureProjectAccess(project.id, "editor");
  }

  const projectIds = source.rows.map((project) => project.id);
  const destinationScope = await visibleProjectWhere("p", [name, projectIds]);
  const destination = await database.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM projects p
        WHERE lower(p.area_name) = lower($1)
          AND NOT (p.id = ANY($2::text[]))
          ${destinationScope.clause ? `AND ${destinationScope.clause}` : ""}
     ) AS exists`,
    destinationScope.parameters,
  );
  if (destination.rows[0]?.exists) {
    throw new NoteRepositoryError("PROJECT_AREA_EXISTS", "已有同名领域，请将项目移动到该领域", 409);
  }

  await database.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE projects
          SET area_name = $2, updated_at = now()
        WHERE id = ANY($1::text[])`,
      [projectIds, name],
    );
    await transaction.query(
      `UPDATE tasks
          SET area_name = $2, updated_at = now()
        WHERE project_id = ANY($1::text[])
          AND area_name IS DISTINCT FROM $2`,
      [projectIds, name],
    );
  });
  return { previousName, name, projectsUpdated: projectIds.length };
}

export async function deleteStoredProject(projectId: string): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const projectScope = scope.and("p", [projectId]);
  const project = await database.query<{ id: string }>(
    `SELECT id FROM projects p WHERE p.id = $1${projectScope.clause} LIMIT 1`,
    projectScope.parameters,
  );
  if (!project.rows[0]) return false;
  const contents = await database.query<{ note_count: number | string; task_count: number | string }>(
    `SELECT
       (SELECT count(*)::int FROM notes WHERE project_id = $1${scope.active ? " AND user_id = $2" : ""}) AS note_count,
       (SELECT count(*)::int FROM tasks WHERE project_id = $1${scope.active ? " AND user_id = $2" : ""}) AS task_count`,
    scope.active ? [projectId, scope.userId] : [projectId],
  );
  if (Number(contents.rows[0]?.note_count ?? 0) > 0 || Number(contents.rows[0]?.task_count ?? 0) > 0) {
    throw new NoteRepositoryError("PROJECT_NOT_EMPTY", "请先移动或删除该项目中的笔记和任务", 409);
  }
  return database.transaction(async (transaction) => {
    await transaction.query(
      `DELETE FROM entity_links WHERE ((source_kind = 'project' AND source_id = $1) OR (target_kind = 'project' AND target_id = $1))${scope.active ? " AND user_id = $2" : ""}`,
      scope.active ? [projectId, scope.userId] : [projectId],
    );
    const result = await transaction.query<{ id: string }>(
      `DELETE FROM projects WHERE id = $1${scope.active ? " AND user_id = $2" : ""} RETURNING id`,
      scope.active ? [projectId, scope.userId] : [projectId],
    );
    return Boolean(result.rows[0]);
  });
}

export async function listStoredNotes(): Promise<readonly StoredNote[]> {
  return queryStoredNotes("", []);
}

export async function listStoredProjectNotes(projectId: string): Promise<readonly StoredNote[]> {
  await ensureProjectAccess(projectId, "viewer");
  return queryStoredNotes("WHERE n.project_id = $1", [projectId]);
}

async function queryStoredNotes(
  whereClause: string,
  parameters: unknown[],
): Promise<readonly StoredNote[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const scoped = scope.active
    && whereClause.includes("n.project_id = $1")
    ? { clause: whereClause, parameters }
    : scope.active
    ? {
        clause: whereClause ? `${whereClause} AND n.user_id = $${parameters.length + 1}` : `WHERE n.user_id = $${parameters.length + 1}`,
        parameters: [...parameters, scope.userId],
      }
    : { clause: whereClause, parameters };
  const result = await database.query<NoteRow>(
    `SELECT n.id, n.project_id, p.name AS project_name, p.color AS project_color,
            n.title, n.content, n.note_type, n.pinned, n.created_at, n.updated_at
       FROM notes n
       LEFT JOIN projects p ON p.id = n.project_id${scope.active ? " AND p.user_id = n.user_id" : ""}
       ${scoped.clause}
      ORDER BY n.pinned DESC, n.updated_at DESC, n.title`,
    scoped.parameters,
  );
  return attachLinkedTasks(result.rows);
}

export async function getStoredNote(noteId: string): Promise<StoredNote | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const scoped = scope.and("n", [noteId]);
  const result = await database.query<NoteRow>(
    `SELECT n.id, n.project_id, p.name AS project_name, p.color AS project_color,
            n.title, n.content, n.note_type, n.pinned, n.created_at, n.updated_at
       FROM notes n LEFT JOIN projects p ON p.id = n.project_id${scope.active ? " AND p.user_id = n.user_id" : ""}
      WHERE n.id = $1${scoped.clause} LIMIT 1`,
    scoped.parameters,
  );
  return (await attachLinkedTasks(result.rows))[0];
}

export async function saveStoredNote(input: SaveNoteInput, options: { readonly expectedUpdatedAt?: string } = {}): Promise<StoredNote> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const id = input.id ?? randomUUID();
  if (input.id) {
    const scoped = scope.and("notes", [input.id]);
    const existing = await database.query<{ id: string }>(`SELECT id FROM notes WHERE id = $1${scoped.clause} LIMIT 1`, scoped.parameters);
    if (!existing.rows[0]) throw new NoteRepositoryError("NOTE_NOT_FOUND", "笔记不存在", 404);
  }
  if (input.projectId) {
    await ensureProjectAccess(input.projectId, "editor");
  }
  await database.transaction(async (transaction) => {
    const written = await transaction.query<{ id: string }>(
      `INSERT INTO notes (id, user_id, project_id, title, content, note_type, pinned, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id, title = EXCLUDED.title,
         content = EXCLUDED.content, note_type = EXCLUDED.note_type,
         pinned = EXCLUDED.pinned,
         updated_at = GREATEST(clock_timestamp(), notes.updated_at + interval '1 millisecond')
       WHERE ($8::timestamptz IS NULL OR date_trunc('milliseconds', notes.updated_at) = date_trunc('milliseconds', $8::timestamptz))
       RETURNING id`,
      [id, scope.valueOrNull(), input.projectId ?? null, input.title, input.content, input.noteType, input.pinned, options.expectedUpdatedAt ?? null],
    );
    if (!written.rows[0]) {
      const exists = await transaction.query<{ id: string }>(`SELECT id FROM notes WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`, scope.active ? [id, scope.userId] : [id]);
      if (!exists.rows[0]) throw new NoteRepositoryError("NOTE_NOT_FOUND", "笔记不存在", 404);
      throw new NoteRepositoryError("VERSION_CONFLICT", "笔记已被更新，请读取最新版本后重试", 409);
    }
    await transaction.query(
      `DELETE FROM entity_links WHERE source_kind = 'project' AND target_kind = 'note' AND target_id = $1 AND relation = 'project-item'${scope.active ? " AND user_id = $2" : ""}`,
      scope.active ? [id, scope.userId] : [id],
    );
    if (input.projectId) {
      await transaction.query(
        `INSERT INTO entity_links (id, user_id, source_kind, source_id, target_kind, target_id, relation)
         VALUES ($1,$2,'project',$3,'note',$4,'project-item')
         ON CONFLICT (source_kind, source_id, target_kind, target_id, relation) DO NOTHING`,
        [`project-note:${id}`, scope.valueOrNull(), input.projectId, id],
      );
    }
  });
  const saved = await getStoredNote(id);
  if (!saved) throw new NoteRepositoryError("NOTE_SAVE_FAILED", "无法保存笔记", 500);
  return saved;
}

export async function deleteStoredNote(noteId: string, expectedUpdatedAt?: string): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      `DELETE FROM notes WHERE id = $1
         AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', notes.updated_at) = date_trunc('milliseconds', $2::timestamptz))${scope.active ? " AND user_id = $3" : ""}
       RETURNING id`,
      scope.active ? [noteId, expectedUpdatedAt ?? null, scope.userId] : [noteId, expectedUpdatedAt ?? null],
    );
    if (!result.rows[0]) {
      const exists = await transaction.query<{ id: string }>(`SELECT id FROM notes WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`, scope.active ? [noteId, scope.userId] : [noteId]);
      if (!exists.rows[0]) throw new NoteRepositoryError("NOTE_NOT_FOUND", "笔记不存在", 404);
      throw new NoteRepositoryError("VERSION_CONFLICT", "笔记已被更新，请读取最新版本后重试", 409);
    }
    await transaction.query(
      `DELETE FROM task_source_references r USING tasks t WHERE r.task_id = t.id AND r.source_kind = 'note' AND r.source_id = $1${scope.active ? " AND t.user_id = $2" : ""}`,
      scope.active ? [noteId, scope.userId] : [noteId],
    );
    await transaction.query(
      `DELETE FROM entity_links WHERE ((source_kind = 'note' AND source_id = $1) OR (target_kind = 'note' AND target_id = $1))${scope.active ? " AND user_id = $2" : ""}`,
      scope.active ? [noteId, scope.userId] : [noteId],
    );
    return true;
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
    sortOrder: row.sort_order,
    noteCount: Number(row.note_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function nextProjectSortOrder(areaName: string | undefined, status: ProjectStatus): Promise<number> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const scoped = scope.and("p", [areaName ?? null, status]);
  const result = await database.query<{ next_sort_order: number }>(
    `SELECT COALESCE(max(p.sort_order), 0) + 1000 AS next_sort_order
       FROM projects p
      WHERE p.area_name IS NOT DISTINCT FROM $1
        AND p.status = $2${scoped.clause}`,
    scoped.parameters,
  );
  return Number(result.rows[0]?.next_sort_order ?? 1000);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
