import { NextResponse } from "next/server";

import { clearMailDraftAttachmentFiles } from "@/server/mail-draft-attachment-service";
import { listMailDraftIdsForAccount } from "@/server/mail-draft-repository";
import {
  deleteAccount,
  getAccount,
  getPublicExchangeSettings,
  getPublicImapSmtpSettings,
  setAccountPaused,
} from "@/server/mail-repository";

export const runtime = "nodejs";

interface AccountRouteContext {
  readonly params: Promise<{ readonly accountId: string }>;
}

export async function GET(_request: Request, context: AccountRouteContext) {
  const { accountId } = await context.params;
  const account = await getAccount(accountId);
  if (!account) return NextResponse.json({ ok: false, message: "邮箱账户不存在" }, { status: 404 });
  try {
    const settings = account.providerId === "exchange-ews"
      ? await getPublicExchangeSettings(accountId)
      : await getPublicImapSmtpSettings(accountId);
    return NextResponse.json({ ok: true, account, settings });
  } catch {
    return NextResponse.json({ ok: false, message: "无法读取账户配置" }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: AccountRouteContext) {
  const { accountId } = await context.params;
  const body = await request.json().catch(() => null) as { readonly action?: unknown } | null;
  if (body?.action !== "pause" && body?.action !== "resume") {
    return NextResponse.json({ ok: false, message: "不支持的账户操作" }, { status: 400 });
  }
  const account = await setAccountPaused(accountId, body.action === "pause");
  if (!account) return NextResponse.json({ ok: false, message: "邮箱账户不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, account });
}

export async function DELETE(_request: Request, context: AccountRouteContext) {
  const { accountId } = await context.params;
  const draftIds = await listMailDraftIdsForAccount(accountId);
  const deleted = await deleteAccount(accountId);
  if (!deleted) return NextResponse.json({ ok: false, message: "邮箱账户不存在" }, { status: 404 });
  await Promise.all(draftIds.map((draftId) => clearMailDraftAttachmentFiles(draftId).catch(() => undefined)));
  return NextResponse.json({ ok: true });
}
