import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import {
  deleteStoredProjectMilestone,
  ProjectRepositoryError,
  saveStoredProjectMilestone,
} from "@/server/project-repository";
import { parseProjectMilestoneInput, type ProjectMilestoneRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface MilestoneRouteContext {
  readonly params: Promise<{ readonly projectId: string; readonly milestoneId: string }>;
}

export async function PATCH(request: Request, context: MilestoneRouteContext) {
  const { projectId, milestoneId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectMilestoneRequestBody | null;
    const milestone = await saveStoredProjectMilestone(parseProjectMilestoneInput(body, projectId, milestoneId));
    return NextResponse.json({ ok: true, milestone });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: MilestoneRouteContext) {
  const { projectId, milestoneId } = await context.params;
  try {
    if (!await deleteStoredProjectMilestone(projectId, milestoneId)) {
      throw new ProjectRepositoryError("MILESTONE_NOT_FOUND", "Meilensteine gibt es nicht", 404);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
