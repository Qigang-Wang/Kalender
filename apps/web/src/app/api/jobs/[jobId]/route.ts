import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { cancelJob, deleteJob, getJob, JobError, retryJob } from "@/server/job-service";

export const runtime = "nodejs";

interface JobRouteContext {
  readonly params: Promise<{ readonly jobId: string }>;
}

export async function GET(_request: Request, context: JobRouteContext) {
  try {
    const actor = await requireActor();
    const { jobId } = await context.params;
    return NextResponse.json({ ok: true, job: await getJob(actor, jobId) });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: JobRouteContext) {
  try {
    const actor = await requireActor();
    const { jobId } = await context.params;
    const body = await request.json().catch(() => null) as { readonly action?: unknown } | null;
    if (body?.action === "cancel") return NextResponse.json({ ok: true, job: await cancelJob(actor, jobId) });
    if (body?.action === "retry") return NextResponse.json({ ok: true, job: await retryJob(actor, jobId) });
    throw new JobError("Nicht unterstützte Aufgaben");
  } catch (error) {
    return jobErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: JobRouteContext) {
  try {
    const actor = await requireActor();
    const { jobId } = await context.params;
    await deleteJob(actor, jobId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
  return actor;
}

function jobErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError || error instanceof JobError ? error : new JobError("Aufgabenoperation fehlgeschlagen", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
