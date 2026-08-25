import { NextResponse } from "next/server";

import { BackupError, exportWorkspaceBackup } from "@/server/backup-service";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    const backup = await exportWorkspaceBackup();
    return new Response(new Uint8Array(backup.bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${backup.filename}"`,
        "Content-Length": String(backup.bytes.byteLength),
        "Content-Type": "application/zip",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const normalized = error instanceof BackupError ? error : new BackupError("kann kein vollständiges Backup erstellen", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
