import { NextResponse } from "next/server";

import { projectErrorResponse } from "@/server/project-api";
import { saveStoredProjectPhase } from "@/server/project-repository";
import { parseProjectPhaseInput, type ProjectPhaseRequestBody } from "@/server/project-validation";

export const runtime = "nodejs";

interface ProjectPhaseRouteContext {
  readonly params: Promise<{ readonly projectId: string }>;
}

export async function POST(request: Request, context: ProjectPhaseRouteContext) {
  const { projectId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as ProjectPhaseRequestBody | null;
    const phase = await saveStoredProjectPhase(parseProjectPhaseInput(body, projectId));
    return NextResponse.json({ ok: true, phase }, { status: 201 });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
