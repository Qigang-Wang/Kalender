import { NextResponse } from "next/server";

import { BackupError, MAX_BACKUP_BYTES, restoreWorkspaceBackup } from "@/server/backup-service";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const declaredSize = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BACKUP_BYTES) {
      throw new BackupError("Sicherungsdatei darf 512 MB nicht überschreiten", 413);
    }
    const input = new Uint8Array(await request.arrayBuffer());
    const restored = await restoreWorkspaceBackup(input);
    return NextResponse.json({
      ok: true,
      message: "Backup ist komplett, Seite wird gleich neu geladen",
      restored,
    });
  } catch (error) {
    const normalized = error instanceof BackupError ? error : new BackupError("kein Backup wiederhergestellt werden kann", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
