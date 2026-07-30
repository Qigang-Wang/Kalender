import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { BackupError, MAX_BACKUP_BYTES, saveUploadedBackup } from "@/server/backup-service";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("请先登录", 401);
    if (actor.role !== "admin") throw new AuthError("需要管理员权限", 403);
    const declaredSize = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BACKUP_BYTES) {
      throw new BackupError("备份文件不能超过 512 MB", 413);
    }
    const filename = request.headers.get("x-backup-filename") ?? "uploaded.backup";
    const artifact = await saveUploadedBackup(new Uint8Array(await request.arrayBuffer()), { actor, filename });
    return NextResponse.json({ ok: true, artifact }, { status: 201 });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof BackupError ? error : new BackupError("无法上传备份", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
