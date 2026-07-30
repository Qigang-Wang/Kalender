import { type NextRequest, NextResponse } from "next/server";

import { getMailFolder, listAccounts, listInbox, listMailCorrespondence } from "@/server/mail-repository";
import { ensureMailSyncScheduler } from "@/server/mail-sync-scheduler";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await ensureMailSyncScheduler();
  const folderId = request.nextUrl.searchParams.get("folder")?.trim() || undefined;
  const correspondent = request.nextUrl.searchParams.get("correspondent")?.trim().toLocaleLowerCase() || undefined;
  if (correspondent && (correspondent.length > 320 || !correspondent.includes("@"))) {
    return NextResponse.json({ message: "联系人邮箱地址无效" }, { status: 400 });
  }
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requestedLimit) ? Math.max(20, Math.min(requestedLimit, 100)) : 50;
  const before = request.nextUrl.searchParams.get("before")?.trim();
  const beforeId = request.nextUrl.searchParams.get("beforeId")?.trim();
  if ((before && !beforeId) || (!before && beforeId) || (before && Number.isNaN(Date.parse(before)))) {
    return NextResponse.json({ message: "邮件分页游标无效" }, { status: 400 });
  }
  const [folder, accounts] = await Promise.all([
    folderId ? getMailFolder(folderId) : Promise.resolve(undefined),
    listAccounts(),
  ]);
  if (folderId && !folder) return NextResponse.json({ message: "邮件文件夹不存在" }, { status: 404 });
  const cursor = before && beforeId ? { receivedAt: before, id: beforeId } : undefined;
  const correspondence = correspondent
    ? await listMailCorrespondence(correspondent, limit + 1, cursor)
    : undefined;
  const fetched = correspondence?.items ?? await listInbox(limit + 1, folderId, cursor);
  const items = fetched.slice(0, limit);
  const lastItem = items.at(-1);
  const nextCursor = fetched.length > limit && lastItem
    ? { receivedAt: lastItem.receivedAt, id: lastItem.id }
    : undefined;
  return NextResponse.json({
    items,
    nextCursor,
    hasAccounts: accounts.length > 0,
    folder,
    correspondence: correspondence?.summary,
  });
}
