import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { reorderStoredProjectPlanItem } from "@/server/project-plan-repository";
import { getStoredProjectOverview, reorderStoredProjectMilestone } from "@/server/project-repository";
import {
  parseProjectTimelineReorderInput,
  type ProjectTimelineReorderRequestBody,
} from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectTimelineReorderRouteContext {
  readonly params: Promise<{ readonly projectId: string }>;
}

export async function PATCH(request: Request, context: ProjectTimelineReorderRouteContext) {
  const { projectId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectTimelineReorderRequestBody | null;
    const input = parseProjectTimelineReorderInput(body, projectId);
    if (input.kind === "planItem") {
      await reorderStoredProjectPlanItem(input.projectId, input.itemId, input.phaseId, input.beforeId);
    } else {
      await reorderStoredProjectMilestone(input);
    }
    const overview = await getStoredProjectOverview(projectId);
    return NextResponse.json({ ok: true, overview });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
