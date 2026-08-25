import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser, listRecentAuditEvents } from "@/server/auth";
import {
  assignUnownedWorkspaceData,
  getWorkspaceIsolationDiagnostic,
  getWorkspaceOperationsDiagnostic,
} from "@/server/workspace-diagnostics";

export const runtime = "nodejs";

interface AssignBody {
  readonly targetUserId?: unknown;
}

export async function GET() {
  try {
    const actor = await requireActor();
    const [diagnostic, operations, auditEvents] = await Promise.all([
      getWorkspaceIsolationDiagnostic(actor),
      getWorkspaceOperationsDiagnostic(actor),
      listRecentAuditEvents(actor, 25),
    ]);
    return NextResponse.json({ ok: true, diagnostic, operations, auditEvents });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor();
    const body = await request.json().catch(() => null) as AssignBody | null;
    const diagnostic = await assignUnownedWorkspaceData(actor, stringValue(body?.targetUserId));
    return NextResponse.json({ ok: true, diagnostic });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
  return actor;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function adminErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("Administrator-Operation fehlgeschlagen", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
