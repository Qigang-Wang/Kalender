import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { saveStoredProjectPlanItem } from "@/server/project-plan-repository";
import { getStoredProjectOverview } from "@/server/project-repository";
import { parseProjectPlanItemInput, type ProjectPlanItemRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectPlanItemsRouteContext {
  readonly params: Promise<{ readonly projectId: string }>;
}

export async function POST(request: Request, context: ProjectPlanItemsRouteContext) {
  const { projectId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectPlanItemRequestBody | null;
    const planItem = await saveStoredProjectPlanItem(parseProjectPlanItemInput(body, projectId));
    const overview = await getStoredProjectOverview(projectId);
    return NextResponse.json({ ok: true, planItem, overview }, { status: 201 });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
