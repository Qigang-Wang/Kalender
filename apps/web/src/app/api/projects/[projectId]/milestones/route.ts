import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { listStoredProjectMilestones, saveStoredProjectMilestone } from "@/server/project-repository";
import { parseProjectMilestoneInput, type ProjectMilestoneRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface MilestonesRouteContext {
  readonly params: Promise<{ readonly projectId: string }>;
}

export async function GET(_request: Request, context: MilestonesRouteContext) {
  const { projectId } = await context.params;
  try {
    return NextResponse.json({ ok: true, milestones: await listStoredProjectMilestones(projectId) });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function POST(request: Request, context: MilestonesRouteContext) {
  const { projectId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectMilestoneRequestBody | null;
    const milestone = await saveStoredProjectMilestone(parseProjectMilestoneInput(body, projectId));
    return NextResponse.json({ ok: true, milestone }, { status: 201 });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
