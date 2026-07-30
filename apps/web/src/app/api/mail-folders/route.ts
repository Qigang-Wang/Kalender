import { NextResponse } from "next/server";

import { createMailFolder, MailFolderActionError } from "@/server/mail-folder-actions";
import { listMailFolders } from "@/server/mail-repository";
import { ensureMailSyncScheduler } from "@/server/mail-sync-scheduler";

export const runtime = "nodejs";

export async function GET() {
  await ensureMailSyncScheduler();
  return NextResponse.json({ folders: await listMailFolders() });
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as {
    readonly accountId?: unknown;
    readonly parentFolderId?: unknown;
    readonly name?: unknown;
  } | null;
  if (typeof input?.accountId !== "string" || typeof input.name !== "string" ||
      (input.parentFolderId !== undefined && typeof input.parentFolderId !== "string")) {
    return NextResponse.json({ message: "文件夹参数无效" }, { status: 400 });
  }
  try {
    const result = await createMailFolder({
      accountId: input.accountId,
      parentFolderId: input.parentFolderId,
      name: input.name,
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return folderErrorResponse(error);
  }
}

function folderErrorResponse(error: unknown) {
  if (error instanceof MailFolderActionError) {
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
  }
  return NextResponse.json({ ok: false, message: "邮件文件夹操作失败" }, { status: 500 });
}
