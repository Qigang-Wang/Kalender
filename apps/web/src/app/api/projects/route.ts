import { NextResponse } from "next/server";

import { noteErrorResponse } from "@/server/note-api";
import { listStoredProjects, saveStoredProject } from "@/server/note-repository";
import { parseProjectInput, type ProjectRequestBody } from "@/server/note-validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "true";
    return NextResponse.json({ ok: true, projects: await listStoredProjects(includeArchived) });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as ProjectRequestBody | null;
    const project = await saveStoredProject(parseProjectInput(body));
    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
