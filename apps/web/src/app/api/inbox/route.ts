import { type NextRequest, NextResponse } from "next/server";

import { getMailFolder, listAccounts, listInbox } from "@/server/mail-repository";
import { ensureMailSyncScheduler } from "@/server/mail-sync-scheduler";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  ensureMailSyncScheduler();
  const folderId = request.nextUrl.searchParams.get("folder")?.trim() || undefined;
  const [folder, accounts] = await Promise.all([
    folderId ? getMailFolder(folderId) : Promise.resolve(undefined),
    listAccounts(),
  ]);
  if (folderId && !folder) return NextResponse.json({ message: "邮件文件夹不存在" }, { status: 404 });
  const items = await listInbox(100, folderId);
  return NextResponse.json({ items, hasAccounts: accounts.length > 0, folder });
}
