import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";

export const entityKinds = ["mail", "calendar", "task", "note", "project"] as const;
export type EntityKind = (typeof entityKinds)[number];

export interface StoredEntityLink {
  readonly id: string;
  readonly sourceKind: EntityKind;
  readonly sourceId: string;
  readonly targetKind: EntityKind;
  readonly targetId: string;
  readonly relation: string;
  readonly createdAt: string;
}

export interface RelatedEntity {
  readonly linkId: string;
  readonly kind: EntityKind;
  readonly entityId: string;
  readonly title: string;
  readonly meta: string;
  readonly href: string;
  readonly relation: string;
  readonly direction: "source" | "target";
  readonly createdAt: string;
}

export interface SaveEntityLinkInput {
  readonly sourceKind: EntityKind;
  readonly sourceId: string;
  readonly targetKind: EntityKind;
  readonly targetId: string;
  readonly relation: string;
}

interface LinkRow {
  id: string;
  source_kind: EntityKind;
  source_id: string;
  target_kind: EntityKind;
  target_id: string;
  relation: string;
  created_at: string | Date;
}

interface EntityDetails {
  readonly title: string;
  readonly meta: string;
  readonly href: string;
}

export async function saveEntityLink(input: SaveEntityLinkInput): Promise<StoredEntityLink> {
  if (input.sourceKind === input.targetKind && input.sourceId === input.targetId) {
    throw new EntityLinkRepositoryError("ENTITY_LINK_SELF", "不能把对象关联到自身", 400);
  }
  const database = await getDatabase();
  const [sourceExists, targetExists] = await Promise.all([
    entityExists(input.sourceKind, input.sourceId),
    entityExists(input.targetKind, input.targetId),
  ]);
  if (!sourceExists || !targetExists) {
    throw new EntityLinkRepositoryError("ENTITY_NOT_FOUND", "要关联的对象不存在或已删除", 404);
  }
  const existing = await database.query<LinkRow>(
    `SELECT id, source_kind, source_id, target_kind, target_id, relation, created_at
       FROM entity_links
      WHERE relation = $1
        AND ((source_kind = $2 AND source_id = $3 AND target_kind = $4 AND target_id = $5)
          OR (source_kind = $4 AND source_id = $5 AND target_kind = $2 AND target_id = $3))
      LIMIT 1`,
    [input.relation, input.sourceKind, input.sourceId, input.targetKind, input.targetId],
  );
  if (existing.rows[0]) return mapLink(existing.rows[0]);

  const result = await database.query<LinkRow>(
    `INSERT INTO entity_links (id, source_kind, source_id, target_kind, target_id, relation)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, source_kind, source_id, target_kind, target_id, relation, created_at`,
    [randomUUID(), input.sourceKind, input.sourceId, input.targetKind, input.targetId, input.relation],
  );
  const saved = result.rows[0];
  if (!saved) throw new EntityLinkRepositoryError("ENTITY_LINK_SAVE_FAILED", "无法保存对象关联", 500);
  return mapLink(saved);
}

export async function listRelatedEntities(kind: EntityKind, entityId: string): Promise<readonly RelatedEntity[]> {
  const database = await getDatabase();
  const result = await database.query<LinkRow>(
    `SELECT id, source_kind, source_id, target_kind, target_id, relation, created_at
       FROM entity_links
      WHERE (source_kind = $1 AND source_id = $2) OR (target_kind = $1 AND target_id = $2)
      ORDER BY created_at DESC`,
    [kind, entityId],
  );
  const related = await Promise.all(result.rows.map(async (row): Promise<RelatedEntity | undefined> => {
    const currentIsSource = row.source_kind === kind && row.source_id === entityId;
    const relatedKind = currentIsSource ? row.target_kind : row.source_kind;
    const relatedId = currentIsSource ? row.target_id : row.source_id;
    const details = await resolveEntityDetails(relatedKind, relatedId);
    if (!details) return undefined;
    return {
      linkId: row.id,
      kind: relatedKind,
      entityId: relatedId,
      ...details,
      relation: row.relation,
      direction: currentIsSource ? "target" : "source",
      createdAt: toIso(row.created_at),
    };
  }));
  return related.filter((entry): entry is RelatedEntity => Boolean(entry));
}

export async function deleteEntityLink(linkId: string): Promise<boolean> {
  const database = await getDatabase();
  const result = await database.query<{ id: string }>("DELETE FROM entity_links WHERE id = $1 RETURNING id", [linkId]);
  return Boolean(result.rows[0]);
}

export async function deleteEntityLinksFor(kind: EntityKind, entityId: string): Promise<void> {
  const database = await getDatabase();
  await database.query(
    "DELETE FROM entity_links WHERE (source_kind = $1 AND source_id = $2) OR (target_kind = $1 AND target_id = $2)",
    [kind, entityId],
  );
}

export class EntityLinkRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "EntityLinkRepositoryError";
  }
}

async function entityExists(kind: EntityKind, entityId: string): Promise<boolean> {
  return Boolean(await resolveEntityDetails(kind, entityId));
}

async function resolveEntityDetails(kind: EntityKind, entityId: string): Promise<EntityDetails | undefined> {
  const database = await getDatabase();
  if (kind === "mail") {
    const result = await database.query<{ subject: string; received_at: string | Date }>("SELECT subject, received_at FROM mail_messages WHERE id = $1 LIMIT 1", [entityId]);
    const row = result.rows[0];
    return row ? { title: row.subject, meta: "邮件", href: `/inbox?message=${encodeURIComponent(entityId)}` } : undefined;
  }
  if (kind === "calendar") {
    const result = await database.query<{ title: string; starts_at: string | Date }>("SELECT title, starts_at FROM calendar_events WHERE id = $1 LIMIT 1", [entityId]);
    const row = result.rows[0];
    const start = row ? toIso(row.starts_at) : undefined;
    return row && start ? { title: row.title, meta: "日程", href: `/calendar?event=${encodeURIComponent(entityId)}&date=${encodeURIComponent(start)}` } : undefined;
  }
  if (kind === "task") {
    const result = await database.query<{ title: string; status: string }>("SELECT title, status FROM tasks WHERE id = $1 LIMIT 1", [entityId]);
    const row = result.rows[0];
    return row ? { title: row.title, meta: row.status === "done" ? "任务 · 已完成" : "任务", href: `/tasks?task=${encodeURIComponent(entityId)}` } : undefined;
  }
  if (kind === "note") {
    const result = await database.query<{ title: string; note_type: string }>("SELECT title, note_type FROM notes WHERE id = $1 LIMIT 1", [entityId]);
    const row = result.rows[0];
    return row ? { title: row.title, meta: row.note_type === "meeting" ? "会议笔记" : "笔记", href: `/notes?note=${encodeURIComponent(entityId)}` } : undefined;
  }
  const result = await database.query<{ name: string; status: string }>("SELECT name, status FROM projects WHERE id = $1 LIMIT 1", [entityId]);
  const row = result.rows[0];
  return row ? { title: row.name, meta: row.status === "archived" ? "项目 · 已归档" : "项目", href: `/projects?project=${encodeURIComponent(entityId)}` } : undefined;
}

function mapLink(row: LinkRow): StoredEntityLink {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    relation: row.relation,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
