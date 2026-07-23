import { entityKinds, type EntityKind, type SaveEntityLinkInput } from "./entity-link-repository";

export interface EntityLinkRequestBody {
  readonly sourceKind?: unknown;
  readonly sourceId?: unknown;
  readonly targetKind?: unknown;
  readonly targetId?: unknown;
  readonly relation?: unknown;
}

export function parseEntityReference(kind: unknown, entityId: unknown): { readonly kind: EntityKind; readonly entityId: string } {
  if (!entityKinds.includes(kind as EntityKind)) throw new EntityLinkValidationError("对象类型无效");
  if (typeof entityId !== "string" || !entityId.trim() || entityId.length > 500) throw new EntityLinkValidationError("对象 ID 无效");
  return { kind: kind as EntityKind, entityId: entityId.trim() };
}

export function parseEntityLinkInput(body: EntityLinkRequestBody | null): SaveEntityLinkInput {
  if (!body) throw new EntityLinkValidationError("缺少关联信息");
  const source = parseEntityReference(body.sourceKind, body.sourceId);
  const target = parseEntityReference(body.targetKind, body.targetId);
  const relation = typeof body.relation === "string" ? body.relation.trim() : "related";
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(relation)) throw new EntityLinkValidationError("关联类型无效");
  return { sourceKind: source.kind, sourceId: source.entityId, targetKind: target.kind, targetId: target.entityId, relation };
}

export class EntityLinkValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "EntityLinkValidationError";
  }
}
