import { NextResponse } from "next/server";

import { MailSyncAlreadyRunningError } from "@/server/imap-sync";
import { runMailSync } from "@/server/mail-sync";
import { toPublicError } from "@/server/mail-account-validation";
import { getAccount } from "@/server/mail-repository";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SyncRouteContext {
  readonly params: Promise<{ readonly accountId: string }>;
}

export async function POST(_request: Request, context: SyncRouteContext) {
  const { accountId } = await context.params;
  const account = await getAccount(accountId);
  if (!account) return NextResponse.json({ ok: false, message: "Mailbox-Konten existieren nicht" }, { status: 404 });
  if (account.syncStatus === "paused") {
    return NextResponse.json({ ok: false, message: "bitte aktivieren Sie zuerst das Postfach-Konto" }, { status: 409 });
  }
  if (account.syncStatus === "syncing") {
    return NextResponse.json({ ok: false, message: "dieses Konto synchronisiert" }, { status: 409 });
  }
  try {
    const sync = await runMailSync(accountId, 100);
    return NextResponse.json({ ok: true, sync });
  } catch (error) {
    if (error instanceof MailSyncAlreadyRunningError) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 409 });
    }
    const normalized = toPublicError(error);
    return NextResponse.json(
      { ok: false, code: normalized.code, message: normalized.message },
      { status: normalized.status },
    );
  }
}
