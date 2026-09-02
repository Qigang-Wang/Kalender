import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { reorderStoredProjectPlanItem } from "@/server/project-plan-repository";
import { getStoredProjectOverview, reorderStoredProjectGanttItem } from "@/server/project-repository";
import {
  parseProjectGanttReorderInput,
  type ProjectGanttReorderRequestBody,
} from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectGanttReorderRouteContext {
  readonly params: Promise<{ readonly projectId: string }>;
}

export async function PATCH(request: Request, context: ProjectGanttReorderRouteContext) {
  const { projectId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectGanttReorderRequestBody | null;
    const input = parseProjectGanttReorderInput(body, projectId);
    if (input.kind === "task") {
      await reorderStoredProjectPlanItem(input.projectId, input.itemId, input.phaseId, input.beforeId);
    } else {
      await reorderStoredProjectGanttItem(input);
    }
    const overview = await getStoredProjectOverview(projectId);
    return NextResponse.json({ ok: true, overview });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
