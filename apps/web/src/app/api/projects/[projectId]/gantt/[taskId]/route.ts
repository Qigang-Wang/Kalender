import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { deleteStoredProjectPlanItem, saveStoredProjectPlanItem } from "@/server/project-plan-repository";
import { getStoredProjectOverview } from "@/server/project-repository";
import { parseProjectPlanItemInput, type ProjectTaskPlanRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectGanttTaskRouteContext {
  readonly params: Promise<{ readonly projectId: string; readonly taskId: string }>;
}

export async function PATCH(request: Request, context: ProjectGanttTaskRouteContext) {
  const { projectId, taskId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectTaskPlanRequestBody | null;
    const planItem = await saveStoredProjectPlanItem(parseProjectPlanItemInput(body, projectId, taskId));
    const overview = await getStoredProjectOverview(projectId);
    return NextResponse.json({ ok: true, task: planItem, planItem, overview });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: ProjectGanttTaskRouteContext) {
  const { projectId, taskId } = await context.params;
  try {
    if (!await deleteStoredProjectPlanItem(projectId, taskId)) {
      return NextResponse.json({ ok: false, message: "项目计划项不存在" }, { status: 404 });
    }
    const overview = await getStoredProjectOverview(projectId);
    return NextResponse.json({ ok: true, overview });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
