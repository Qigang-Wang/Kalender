import { NextResponse } from "next/server";

import { noteErrorResponse } from "@/server/note-api";
import { reorderStoredProjects } from "@/server/note-repository";
import { parseProjectReorderInput } from "@/server/note-validation";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { readonly projectIds?: unknown } | null;
    const projects = await reorderStoredProjects(parseProjectReorderInput(body));
    return NextResponse.json({ ok: true, projects });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
