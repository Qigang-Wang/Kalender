import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { BackupError, createBackupJob, createImmediateAutomaticBackupJob, getWorkspaceBackupStatus, saveAutomaticBackupSettings } from "@/server/backup-service";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, status: await getWorkspaceBackupStatus() });
  } catch (error) {
    return backupErrorResponse(error, "read-status");
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("请先登录", 401);
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
    return backupErrorResponse(error, "create");
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("请先登录", 401);
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
    const job = settings.enabled ? await createImmediateAutomaticBackupJob(actor) : undefined;
    return NextResponse.json({ ok: true, settings, job });
  } catch (error) {
    return backupErrorResponse(error, "save-automatic-settings");
  }
}

function backupErrorResponse(error: unknown, operation: "read-status" | "create" | "save-automatic-settings") {
  if (!(error instanceof BackupError) && !(error instanceof AuthError)) {
    console.error(`[Backup API] ${operation} failed`, error);
  }
  const fallbackMessage = operation === "read-status"
    ? "无法读取备份状态"
    : operation === "create"
      ? "无法创建备份任务"
      : "无法保存自动备份设置";
  const normalized = error instanceof BackupError || error instanceof AuthError ? error : new BackupError(fallbackMessage, 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
