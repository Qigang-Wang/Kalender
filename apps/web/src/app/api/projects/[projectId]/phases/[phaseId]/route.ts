import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { deleteStoredProjectPhase, ProjectRepositoryError, saveStoredProjectPhase } from "@/server/project-repository";
import { parseProjectPhaseInput, type ProjectPhaseRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectPhaseRouteContext {
  readonly params: Promise<{ readonly projectId: string; readonly phaseId: string }>;
}

export async function PATCH(request: Request, context: ProjectPhaseRouteContext) {
  const { projectId, phaseId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectPhaseRequestBody | null;
    const phase = await saveStoredProjectPhase(parseProjectPhaseInput(body, projectId, phaseId));
    return NextResponse.json({ ok: true, phase });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: ProjectPhaseRouteContext) {
  const { projectId, phaseId } = await context.params;
  try {
    if (!await deleteStoredProjectPhase(projectId, phaseId)) {
      throw new ProjectRepositoryError("PHASE_NOT_FOUND", "项目阶段不存在", 404);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
