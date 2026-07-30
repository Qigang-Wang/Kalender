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
    if (!actor) throw new AuthError("请先登录", 401);
    const { artifactId } = await context.params;
    await deleteBackupArtifact(actor, artifactId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof BackupError ? error : new BackupError("无法删除备份", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
