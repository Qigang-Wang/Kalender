import { NextResponse } from "next/server";

import { entityLinkErrorResponse } from "@/server/entity-link-api";
import { deleteEntityLink, EntityLinkRepositoryError } from "@/server/entity-link-repository";

export const runtime = "nodejs";

interface EntityLinkRouteContext {
  readonly params: Promise<{ readonly linkId: string }>;
}

export async function DELETE(_request: Request, context: EntityLinkRouteContext) {
  try {
    const { linkId } = await context.params;
    if (!await deleteEntityLink(linkId)) throw new EntityLinkRepositoryError("ENTITY_LINK_NOT_FOUND", "对象关联不存在", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return entityLinkErrorResponse(error);
  }
}
