import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { reorderStoredProjectGanttItem } from "@/server/project-repository";
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
    const overview = await reorderStoredProjectGanttItem(parseProjectGanttReorderInput(body, projectId));
    return NextResponse.json({ ok: true, overview });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
