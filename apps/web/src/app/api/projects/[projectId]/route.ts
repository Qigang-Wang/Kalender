import { NextResponse } from "next/server";

import { noteErrorResponse } from "@/server/note-api";
import { deleteStoredProject, saveStoredProject, NoteRepositoryError } from "@/server/note-repository";
import { parseProjectInput, type ProjectRequestBody } from "@/server/note-validation";
import { getStoredProjectOverview } from "@/server/project-repository";

export const runtime = "nodejs";

interface ProjectRouteContext {
  readonly params: Promise<{ readonly projectId: string }>;
}

export async function GET(_request: Request, context: ProjectRouteContext) {
  const { projectId } = await context.params;
  try {
    const overview = await getStoredProjectOverview(projectId);
    if (!overview) throw new NoteRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
    return NextResponse.json({ ok: true, overview });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: ProjectRouteContext) {
  const { projectId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectRequestBody | null;
    return NextResponse.json({ ok: true, project: await saveStoredProject(parseProjectInput(body, projectId)) });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: ProjectRouteContext) {
  const { projectId } = await context.params;
  try {
    if (!await deleteStoredProject(projectId)) throw new NoteRepositoryError("PROJECT_NOT_FOUND", "项目不存在", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
