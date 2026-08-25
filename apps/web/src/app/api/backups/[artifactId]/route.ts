import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { BackupError, deleteBackupArtifact } from "@/server/backup-service";

export const runtime = "nodejs";

interface BackupArtifactRouteContext {
  readonly params: Promise<{ readonly artifactId: string }>;
}

export async function DELETE(_request: Request, context: BackupArtifactRouteContext) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
    const { artifactId } = await context.params;
    await deleteBackupArtifact(actor, artifactId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof BackupError ? error : new BackupError("Backup kann nicht gelöscht werden", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
