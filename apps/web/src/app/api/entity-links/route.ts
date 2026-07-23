import { NextResponse } from "next/server";

import { entityLinkErrorResponse } from "@/server/entity-link-api";
import { listRelatedEntities, saveEntityLink } from "@/server/entity-link-repository";
import { parseEntityLinkInput, parseEntityReference, type EntityLinkRequestBody } from "@/server/entity-link-validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const reference = parseEntityReference(url.searchParams.get("kind"), url.searchParams.get("id"));
    return NextResponse.json({ ok: true, related: await listRelatedEntities(reference.kind, reference.entityId) });
  } catch (error) {
    return entityLinkErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as EntityLinkRequestBody | null;
    return NextResponse.json({ ok: true, link: await saveEntityLink(parseEntityLinkInput(body)) }, { status: 201 });
  } catch (error) {
    return entityLinkErrorResponse(error);
  }
}
