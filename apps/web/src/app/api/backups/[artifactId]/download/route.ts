import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { BackupError, readBackupArtifactFile } from "@/server/backup-service";

export const runtime = "nodejs";
export const maxDuration = 120;

interface DownloadRouteContext {
  readonly params: Promise<{ readonly artifactId: string }>;
}

export async function GET(_request: Request, context: DownloadRouteContext) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
    if (actor.role !== "admin") throw new AuthError("Administrator-Rechte erfordern", 403);
    const { artifactId } = await context.params;
    const { artifact, bytes } = await readBackupArtifactFile(artifactId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof BackupError ? error : new BackupError("Backup kann nicht heruntergeladen werden", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
