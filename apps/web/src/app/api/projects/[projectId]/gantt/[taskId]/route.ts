import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { saveStoredProjectTaskPlan } from "@/server/project-repository";
import { parseProjectTaskPlanInput, type ProjectTaskPlanRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectGanttTaskRouteContext {
  readonly params: Promise<{ readonly projectId: string; readonly taskId: string }>;
}

export async function PATCH(request: Request, context: ProjectGanttTaskRouteContext) {
  const { projectId, taskId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectTaskPlanRequestBody | null;
    const result = await saveStoredProjectTaskPlan(parseProjectTaskPlanInput(body, projectId, taskId));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
