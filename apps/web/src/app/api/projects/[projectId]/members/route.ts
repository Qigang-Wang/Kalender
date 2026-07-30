import { NextResponse } from "next/server";

import { AuthError } from "@/server/auth";
import { listProjectMembers, saveProjectMembers, type ProjectAccessLevel } from "@/server/project-collaboration";

export const runtime = "nodejs";

interface ProjectMembersRouteProps {
  readonly params: Promise<{ readonly projectId: string }>;
}

interface MembersBody {
  readonly members?: unknown;
}

export async function GET(_request: Request, { params }: ProjectMembersRouteProps) {
  try {
    const { projectId } = await params;
    return NextResponse.json({ ok: true, members: await listProjectMembers(projectId) });
  } catch (error) {
    return memberErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: ProjectMembersRouteProps) {
  try {
    const { projectId } = await params;
    const body = await request.json().catch(() => null) as MembersBody | null;
    return NextResponse.json({ ok: true, members: await saveProjectMembers(projectId, parseMembers(body?.members)) });
  } catch (error) {
    return memberErrorResponse(error);
  }
}

function parseMembers(value: unknown): readonly { readonly userId: string; readonly accessLevel: ProjectAccessLevel }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.userId !== "string" || !candidate.userId.trim()) return [];
    return [{
      userId: candidate.userId,
      accessLevel: candidate.accessLevel === "editor" ? "editor" as const : "viewer" as const,
    }];
  });
}

function memberErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("项目成员操作失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
