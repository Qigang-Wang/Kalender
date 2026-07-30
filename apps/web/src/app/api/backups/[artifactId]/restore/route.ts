import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { BackupError, createRestoreJob } from "@/server/backup-service";

export const runtime = "nodejs";

interface RestoreRouteContext {
  readonly params: Promise<{ readonly artifactId: string }>;
}

export async function POST(request: Request, context: RestoreRouteContext) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("请先登录", 401);
    const { artifactId } = await context.params;
    const body = await request.json().catch(() => null) as { readonly password?: unknown; readonly confirmed?: unknown } | null;
    if (body?.confirmed !== true) throw new BackupError("恢复前必须明确确认");
    const job = await createRestoreJob(actor, {
      artifactId,
      password: typeof body.password === "string" ? body.password : undefined,
    });
    return NextResponse.json({ ok: true, job }, { status: 202 });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof BackupError ? error : new BackupError("无法创建恢复任务", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
