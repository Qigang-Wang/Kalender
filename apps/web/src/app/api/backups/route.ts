import { NextResponse } from "next/server";

import { BackupError, getWorkspaceBackupStatus } from "@/server/backup-service";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, status: await getWorkspaceBackupStatus() });
  } catch (error) {
    return backupErrorResponse(error);
  }
}

function backupErrorResponse(error: unknown) {
  const normalized = error instanceof BackupError ? error : new BackupError("无法读取备份状态", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
