import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { BackupError, createBackupJob, getWorkspaceBackupStatus, saveAutomaticBackupSettings } from "@/server/backup-service";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, status: await getWorkspaceBackupStatus() });
  } catch (error) {
    return backupErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
    const body = await request.json().catch(() => null) as {
      readonly encrypted?: unknown;
      readonly mailPolicy?: unknown;
      readonly password?: unknown;
    } | null;
    const job = await createBackupJob(actor, {
      encrypted: body?.encrypted !== false,
      mailPolicy: typeof body?.mailPolicy === "string" ? body.mailPolicy as "lightweight" | "full-archive" | "configuration-only" : undefined,
      password: typeof body?.password === "string" ? body.password : undefined,
    });
    return NextResponse.json({ ok: true, job }, { status: 202 });
  } catch (error) {
    return backupErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
    const body = await request.json().catch(() => null) as {
      readonly enabled?: unknown;
      readonly intervalHours?: unknown;
      readonly retentionCount?: unknown;
      readonly encryptAutomatic?: unknown;
    } | null;
    const settings = await saveAutomaticBackupSettings(actor, {
      enabled: body?.enabled === true,
      intervalHours: Number(body?.intervalHours ?? 24),
      retentionCount: Number(body?.retentionCount ?? 3),
      encryptAutomatic: body?.encryptAutomatic === true,
    });
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return backupErrorResponse(error);
  }
}

function backupErrorResponse(error: unknown) {
  const normalized = error instanceof BackupError || error instanceof AuthError ? error : new BackupError("Sicherungsoperation fehlgeschlagen", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
