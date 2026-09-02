import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { deleteStoredProjectPlanItem, saveStoredProjectPlanItem } from "@/server/project-plan-repository";
import { getStoredProjectOverview } from "@/server/project-repository";
import { parseProjectPlanItemInput, type ProjectPlanItemRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectPlanItemRouteContext {
  readonly params: Promise<{ readonly projectId: string; readonly planItemId: string }>;
}

export async function PATCH(request: Request, context: ProjectPlanItemRouteContext) {
  const { projectId, planItemId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectPlanItemRequestBody | null;
    const planItem = await saveStoredProjectPlanItem(parseProjectPlanItemInput(body, projectId, planItemId));
    const overview = await getStoredProjectOverview(projectId);
    return NextResponse.json({ ok: true, planItem, overview });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: ProjectPlanItemRouteContext) {
  const { projectId, planItemId } = await context.params;
  try {
    if (!await deleteStoredProjectPlanItem(projectId, planItemId)) {
      return NextResponse.json({ ok: false, message: "项目计划项不存在" }, { status: 404 });
    }
    const overview = await getStoredProjectOverview(projectId);
    return NextResponse.json({ ok: true, overview });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
