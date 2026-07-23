import { noteContentToPlainText } from "../lib/note-content";

import { getDatabase } from "./database";

export type WorkspaceSearchKind = "mail" | "task" | "calendar" | "note";

export interface WorkspaceSearchResult {
  readonly id: string;
  readonly kind: WorkspaceSearchKind;
  readonly title: string;
  readonly subtitle: string;
  readonly snippet?: string;
  readonly href: string;
  readonly timestamp?: string;
}

export async function searchWorkspace(rawQuery: string, limitPerKind = 5): Promise<readonly WorkspaceSearchResult[]> {
  const query = rawQuery.trim();
  if (query.length < 2) return [];
  const database = await getDatabase();
  const pattern = `%${query}%`;
  const limit = Math.max(1, Math.min(limitPerKind, 10));

  const [mail, tasks, events, notes] = await Promise.all([
    database.query<{ id: string; subject: string; snippet: string; sender: string; account_name: string; received_at: string }>(
      `SELECT m.id, m.subject, m.snippet,
              COALESCE(NULLIF(m.from_address->>'name', ''), m.from_address->>'address', '未知发件人') AS sender,
              a.display_name AS account_name, m.received_at
         FROM mail_messages m JOIN accounts a ON a.id = m.account_id
        WHERE m.subject ILIKE $1 OR m.snippet ILIKE $1
           OR m.from_address->>'name' ILIKE $1 OR m.from_address->>'address' ILIKE $1
        ORDER BY m.received_at DESC LIMIT $2`,
      [pattern, limit],
    ),
    database.query<{ id: string; title: string; notes: string | null; project_name: string | null; status: string; updated_at: string }>(
      `SELECT id, title, notes, project_name, status, updated_at FROM tasks
        WHERE title ILIKE $1 OR notes ILIKE $1 OR project_name ILIKE $1
        ORDER BY (status = 'done'), updated_at DESC LIMIT $2`,
      [pattern, limit],
    ),
    database.query<{ id: string; title: string; description: string | null; location: string | null; calendar_name: string; starts_at: string }>(
      `SELECT e.id, e.title, e.description, e.location,
              COALESCE(a.display_name, c.name) AS calendar_name, e.starts_at
         FROM calendar_events e
         JOIN calendars c ON c.id = e.calendar_id
         LEFT JOIN calendar_accounts a ON a.id = c.account_id
        WHERE e.title ILIKE $1 OR e.description ILIKE $1 OR e.location ILIKE $1
        ORDER BY e.starts_at DESC LIMIT $2`,
      [pattern, limit],
    ),
    database.query<{ id: string; title: string; content: string; note_type: string; project_name: string | null; updated_at: string }>(
      `SELECT n.id, n.title, n.content, n.note_type, p.name AS project_name, n.updated_at
         FROM notes n LEFT JOIN projects p ON p.id = n.project_id
        WHERE n.title ILIKE $1 OR n.content ILIKE $1 OR p.name ILIKE $1
        ORDER BY n.updated_at DESC LIMIT $2`,
      [pattern, limit],
    ),
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
  ];
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
