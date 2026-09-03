import { noteContentToPlainText } from "../lib/note-content";

import { getDatabase } from "./database";
import { getUserScope } from "./user-scope";

export type WorkspaceSearchKind = "mail" | "task" | "calendar" | "note" | "project" | "ai";

export interface WorkspaceSearchResult {
  readonly id: string;
  readonly kind: WorkspaceSearchKind;
  readonly title: string;
  readonly subtitle: string;
  readonly snippet?: string;
  readonly href: string;
  readonly timestamp?: string;
  readonly score?: number;
}

export interface WorkspaceSearchOptions {
  readonly kind?: WorkspaceSearchKind;
  readonly from?: string;
  readonly to?: string;
  readonly projectId?: string;
  readonly accountId?: string;
  readonly status?: string;
  readonly hasAttachments?: boolean;
  readonly limit?: number;
}

export async function searchWorkspace(rawQuery: string, limitPerKindOrOptions: number | WorkspaceSearchOptions = 5): Promise<readonly WorkspaceSearchResult[]> {
  const query = rawQuery.trim();
  if (query.length < 2) return [];
  const database = await getDatabase();
  const scope = await getUserScope();
  const pattern = `%${query}%`;
  const options = typeof limitPerKindOrOptions === "number" ? { limit: limitPerKindOrOptions } : limitPerKindOrOptions;
  const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
  const kinds = new Set<WorkspaceSearchKind>(options.kind ? [options.kind] : ["mail", "task", "calendar", "note", "project", "ai"]);

  const [mail, tasks, events, notes, projects, ai] = await Promise.all([
    kinds.has("mail") ? (
    database.query<{ id: string; subject: string; snippet: string; sender: string; account_name: string; received_at: string }>(
      `SELECT m.id, m.subject, m.snippet,
              COALESCE(NULLIF(m.from_address->>'name', ''), m.from_address->>'address', '未知发件人') AS sender,
              a.display_name AS account_name, m.received_at
         FROM mail_messages m
         JOIN accounts a ON a.id = m.account_id
         LEFT JOIN mail_message_bodies body ON body.message_id = m.id
        WHERE (to_tsvector('simple', coalesce(m.subject, '') || ' ' || coalesce(m.snippet, '') || ' ' || coalesce(body.text_body, '') || ' ' || coalesce(body.html_body, '') || ' ' || coalesce(m.from_address::text, '') || ' ' || coalesce(m.to_addresses::text, '') || ' ' || coalesce(m.attachments::text, '')) @@ plainto_tsquery('simple', $1)
           OR m.subject ILIKE $2 OR m.snippet ILIKE $2
           OR body.text_body ILIKE $2 OR body.html_body ILIKE $2
           OR m.from_address->>'name' ILIKE $2 OR m.from_address->>'address' ILIKE $2
           OR m.to_addresses::text ILIKE $2 OR m.attachments::text ILIKE $2)
          ${scope.active ? "AND a.user_id = $4" : ""}
          ${options.accountId ? `AND m.account_id = $${scope.active ? 5 : 4}` : ""}
          ${options.hasAttachments === true ? "AND jsonb_array_length(m.attachments) > 0" : ""}
          ${options.from ? `AND m.received_at >= $${(scope.active ? 5 : 4) + (options.accountId ? 1 : 0)}` : ""}
          ${options.to ? `AND m.received_at <= $${(scope.active ? 5 : 4) + (options.accountId ? 1 : 0) + (options.from ? 1 : 0)}` : ""}
        ORDER BY m.received_at DESC LIMIT $3`,
      mailParams(query, pattern, limit, scope.userId, options),
    )) : emptyRows<{ id: string; subject: string; snippet: string; sender: string; account_name: string; received_at: string }>(),
    kinds.has("task") ? (
    database.query<{ id: string; title: string; notes: string | null; project_name: string | null; status: string; updated_at: string }>(
      `SELECT id, title, notes, project_name, status, updated_at FROM tasks
        WHERE (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(project_name, '')) @@ plainto_tsquery('simple', $1)
           OR title ILIKE $2 OR notes ILIKE $2 OR project_name ILIKE $2)
          AND NOT is_plan_item_mirror
          ${scope.active ? "AND user_id = $4" : ""}
          ${options.projectId ? `AND project_id = $${scope.active ? 5 : 4}` : ""}
          ${options.status ? `AND status = $${(scope.active ? 5 : 4) + (options.projectId ? 1 : 0)}` : ""}
          ${options.from ? `AND updated_at >= $${(scope.active ? 5 : 4) + (options.projectId ? 1 : 0) + (options.status ? 1 : 0)}` : ""}
          ${options.to ? `AND updated_at <= $${(scope.active ? 5 : 4) + (options.projectId ? 1 : 0) + (options.status ? 1 : 0) + (options.from ? 1 : 0)}` : ""}
        ORDER BY (status = 'done'), updated_at DESC LIMIT $3`,
      scopedParams(query, pattern, limit, scope.userId, [options.projectId, options.status, options.from, options.to]),
    )) : emptyRows<{ id: string; title: string; notes: string | null; project_name: string | null; status: string; updated_at: string }>(),
    kinds.has("calendar") ? (
    database.query<{ id: string; title: string; description: string | null; location: string | null; calendar_name: string; starts_at: string }>(
      `SELECT e.id, e.title, e.description, e.location,
              COALESCE(a.display_name, c.name) AS calendar_name, e.starts_at
         FROM calendar_events e
         JOIN calendars c ON c.id = e.calendar_id
         LEFT JOIN calendar_accounts a ON a.id = c.account_id
        WHERE (to_tsvector('simple', coalesce(e.title, '') || ' ' || coalesce(e.description, '') || ' ' || coalesce(e.location, '')) @@ plainto_tsquery('simple', $1)
           OR e.title ILIKE $2 OR e.description ILIKE $2 OR e.location ILIKE $2)
          ${scope.active ? "AND c.user_id = $4" : ""}
          ${options.from ? `AND e.starts_at >= $${scope.active ? 5 : 4}` : ""}
          ${options.to ? `AND e.starts_at <= $${(scope.active ? 5 : 4) + (options.from ? 1 : 0)}` : ""}
        ORDER BY e.starts_at DESC LIMIT $3`,
      scopedParams(query, pattern, limit, scope.userId, [options.from, options.to]),
    )) : emptyRows<{ id: string; title: string; description: string | null; location: string | null; calendar_name: string; starts_at: string }>(),
    kinds.has("note") ? (
    database.query<{ id: string; title: string; content: string; note_type: string; project_name: string | null; updated_at: string }>(
      `SELECT n.id, n.title, n.content, n.note_type, p.name AS project_name, n.updated_at
         FROM notes n LEFT JOIN projects p ON p.id = n.project_id
        WHERE (to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.content, '') || ' ' || coalesce(p.name, '')) @@ plainto_tsquery('simple', $1)
           OR n.title ILIKE $2 OR n.content ILIKE $2 OR p.name ILIKE $2)
          ${scope.active ? "AND n.user_id = $4" : ""}
          ${options.projectId ? `AND n.project_id = $${scope.active ? 5 : 4}` : ""}
          ${options.from ? `AND n.updated_at >= $${(scope.active ? 5 : 4) + (options.projectId ? 1 : 0)}` : ""}
          ${options.to ? `AND n.updated_at <= $${(scope.active ? 5 : 4) + (options.projectId ? 1 : 0) + (options.from ? 1 : 0)}` : ""}
        ORDER BY n.updated_at DESC LIMIT $3`,
      scopedParams(query, pattern, limit, scope.userId, [options.projectId, options.from, options.to]),
    )) : emptyRows<{ id: string; title: string; content: string; note_type: string; project_name: string | null; updated_at: string }>(),
    kinds.has("project") ? (
    database.query<{ id: string; name: string; description: string | null; area_name: string | null; updated_at: string }>(
      `SELECT id, name, description, area_name, updated_at FROM projects
        WHERE (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(area_name, '')) @@ plainto_tsquery('simple', $1)
           OR name ILIKE $2 OR description ILIKE $2 OR area_name ILIKE $2)
          ${scope.active ? "AND user_id = $4" : ""}
          ${options.status ? `AND status = $${scope.active ? 5 : 4}` : ""}
        ORDER BY updated_at DESC LIMIT $3`,
      scopedParams(query, pattern, limit, scope.userId, [options.status]),
    )) : emptyRows<{ id: string; name: string; description: string | null; area_name: string | null; updated_at: string }>(),
    kinds.has("ai") ? (
    database.query<{ id: string; title: string; preview: string | null; updated_at: string }>(
      `SELECT c.id, c.title,
              (SELECT left(COALESCE(m.content->>'text', ''), 160) FROM ai_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS preview,
              c.updated_at
         FROM ai_conversations c
        WHERE (to_tsvector('simple', coalesce(c.title, '')) @@ plainto_tsquery('simple', $1)
           OR c.title ILIKE $2
           OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id = c.id AND (m.content->>'text' ILIKE $2 OR to_tsvector('simple', coalesce(m.content->>'text', '')) @@ plainto_tsquery('simple', $1))))
          ${scope.active ? "AND c.user_id = $4" : ""}
        ORDER BY c.updated_at DESC LIMIT $3`,
      scopedParams(query, pattern, limit, scope.userId, []),
    )) : emptyRows<{ id: string; title: string; preview: string | null; updated_at: string }>(),
  ]);

  return [
    ...mail.rows.map((item): WorkspaceSearchResult => ({
      id: item.id,
      kind: "mail",
      title: item.subject,
      subtitle: `${item.sender} · ${item.account_name}`,
      snippet: compactSnippet(item.snippet),
      href: `/inbox?message=${encodeURIComponent(item.id)}`,
      timestamp: item.received_at,
    })),
    ...tasks.rows.map((item): WorkspaceSearchResult => ({
      id: item.id,
      kind: "task",
      title: item.title,
      subtitle: `${taskStatusLabel(item.status)}${item.project_name ? ` · ${item.project_name}` : ""}`,
      snippet: compactSnippet(item.notes),
      href: `/tasks?task=${encodeURIComponent(item.id)}`,
      timestamp: item.updated_at,
    })),
    ...events.rows.map((item): WorkspaceSearchResult => ({
      id: item.id,
      kind: "calendar",
      title: item.title,
      subtitle: `${item.calendar_name}${item.location ? ` · ${item.location}` : ""}`,
      snippet: compactSnippet(item.description),
      href: `/calendar?event=${encodeURIComponent(item.id)}&date=${encodeURIComponent(item.starts_at)}`,
      timestamp: item.starts_at,
    })),
    ...notes.rows.map((item): WorkspaceSearchResult => ({
      id: item.id,
      kind: "note",
      title: item.title,
      subtitle: item.project_name ?? noteTypeLabel(item.note_type),
      snippet: compactSnippet(noteContentToPlainText(item.content)),
      href: `/notes?note=${encodeURIComponent(item.id)}`,
      timestamp: item.updated_at,
    })),
    ...projects.rows.map((item): WorkspaceSearchResult => ({
      id: item.id,
      kind: "project",
      title: item.name,
      subtitle: item.area_name ?? "项目",
      snippet: compactSnippet(item.description),
      href: `/projects?project=${encodeURIComponent(item.id)}`,
      timestamp: item.updated_at,
    })),
    ...ai.rows.map((item): WorkspaceSearchResult => ({
      id: item.id,
      kind: "ai",
      title: item.title,
      subtitle: "AI 会话",
      snippet: compactSnippet(item.preview),
      href: `/ai?conversation=${encodeURIComponent(item.id)}`,
      timestamp: item.updated_at,
    })),
  ];
}

function scopedParams(query: string, pattern: string, limit: number, userId: string | undefined, tail: readonly (string | undefined)[]): unknown[] {
  return [query, pattern, limit, ...(userId ? [userId] : []), ...tail.filter((value): value is string => Boolean(value))];
}

function mailParams(query: string, pattern: string, limit: number, userId: string | undefined, options: WorkspaceSearchOptions): unknown[] {
  return scopedParams(query, pattern, limit, userId, [options.accountId, options.from, options.to]);
}

function emptyRows<T>(): Promise<{ rows: T[] }> {
  return Promise.resolve({ rows: [] });
}

function compactSnippet(value?: string | null): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
}

function taskStatusLabel(status: string): string {
  return { inbox: "待整理", next: "下一步", waiting: "等待中", someday: "以后也许", done: "已完成" }[status] ?? "任务";
}

function noteTypeLabel(type: string): string {
  return { general: "普通笔记", meeting: "会议笔记", email: "邮件笔记", project: "项目笔记", daily: "每日笔记" }[type] ?? "笔记";
}
