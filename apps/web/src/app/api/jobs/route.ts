import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { enqueueJob, JobError, listJobs, type AppJobKind, type AppJobStatus } from "@/server/job-service";

export const runtime = "nodejs";

const jobKinds = new Set<AppJobKind>(["backup.create", "backup.restore", "mail.sync", "calendar.sync", "ai.action", "maintenance"]);
const jobStatuses = new Set<AppJobStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor();
    const url = new URL(request.url);
    const status = safeStatus(url.searchParams.get("status"));
    const kind = safeKind(url.searchParams.get("kind"));
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return NextResponse.json({ ok: true, jobs: await listJobs(actor, { status, kind, limit }) });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor();
    if (actor.role !== "admin") throw new AuthError("Administrator-Rechte erfordern", 403);
    const body = await request.json().catch(() => null) as {
      readonly kind?: unknown;
      readonly title?: unknown;
      readonly payload?: unknown;
      readonly idempotencyKey?: unknown;
    } | null;
    const kind = safeKind(typeof body?.kind === "string" ? body.kind : undefined);
    if (!kind) throw new JobError("Ungültiger Aufgabentyp");
    const job = await enqueueJob({
      kind,
      actor,
      title: typeof body?.title === "string" ? body.title : defaultJobTitle(kind),
      payload: body?.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {},
      idempotencyKey: typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      maxAttempts: kind === "maintenance" ? 2 : 1,
    });
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
  return actor;
}

function safeKind(value: string | null | undefined): AppJobKind | undefined {
  return value && jobKinds.has(value as AppJobKind) ? value as AppJobKind : undefined;
}

function safeStatus(value: string | null): AppJobStatus | undefined {
  return value && jobStatuses.has(value as AppJobStatus) ? value as AppJobStatus : undefined;
}

function defaultJobTitle(kind: AppJobKind): string {
  return {
    "backup.create": "Backup erstellen",
    "backup.restore": "Sicherung wiederherstellen",
    "mail.sync": "Mail synchronisieren",
    "calendar.sync": "Kalender synchronisieren",
    "ai.action": "AI-Maßnahmen durchführen",
    maintenance: "Wartung des Systems",
  }[kind];
}

function jobErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError || error instanceof JobError ? error : new JobError("Aufgabenoperation fehlgeschlagen", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
