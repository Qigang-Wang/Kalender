import { NextResponse } from "next/server";

import { testImapSmtpConnection } from "@/server/imap-smtp-test";
import { runInitialImapSync } from "@/server/imap-sync";
import {
  assertPublicMailHost,
  isEmail,
  parseServer,
  toPublicError,
  withRetainedPassword,
  type ServerInput,
} from "@/server/mail-account-validation";
import {
  getAccount,
  getLatestSyncRun,
  listAccountSelfAddresses,
  listAccounts,
  loadImapSmtpCredential,
  reopenAccountHistoryBackfill,
  saveImapSmtpAccount,
  type SyncMode,
} from "@/server/mail-repository";
import { ensureMailSyncScheduler } from "@/server/mail-sync-scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SaveAccountBody {
  readonly accountId?: unknown;
  readonly providerId?: unknown;
  readonly displayName?: unknown;
  readonly emailAddress?: unknown;
  readonly syncMode?: unknown;
  readonly imap?: ServerInput;
  readonly smtp?: ServerInput;
}

export async function GET() {
  const scheduler = await ensureMailSyncScheduler();
  const accounts = await listAccounts();
  return NextResponse.json({
    accounts: await Promise.all(accounts.map(async (account) => ({
      ...account,
      aliases: await listAccountSelfAddresses(account.id),
      latestSyncRun: await getLatestSyncRun(account.id),
    }))),
    scheduler,
  });
}

export async function POST(request: Request) {
  let body: SaveAccountBody;
  try {
    body = await request.json() as SaveAccountBody;
  } catch {
    return NextResponse.json({ ok: false, message: "Ungültiges angefordertes Format" }, { status: 400 });
  }
  if (body.providerId !== "imap") {
    return NextResponse.json({ ok: false, message: "Derzeit werden nur IMAP/SMTP-Konten gespeichert" }, { status: 400 });
  }
  if (typeof body.emailAddress !== "string" || !isEmail(body.emailAddress)) {
    return NextResponse.json({ ok: false, message: "Bitte geben Sie eine gültige Postfachadresse ein" }, { status: 400 });
  }
  if (typeof body.displayName !== "string" || !body.displayName.trim()) {
    return NextResponse.json({ ok: false, message: "Bitte geben Sie den Kontonamen ein" }, { status: 400 });
  }
  const syncMode: SyncMode = body.syncMode === "quick" || body.syncMode === "full" ? body.syncMode : "recommended";

  try {
    const accountId = typeof body.accountId === "string" && body.accountId ? body.accountId : undefined;
    const existingAccount = accountId ? await getAccount(accountId) : undefined;
    if (accountId && !existingAccount) {
      return NextResponse.json({ ok: false, message: "Mailbox-Konten existieren nicht" }, { status: 404 });
    }
    const stored = accountId ? await loadImapSmtpCredential(accountId) : undefined;
    const imap = parseServer(withRetainedPassword(body.imap, stored?.imap), "IMAP");
    const smtp = parseServer(withRetainedPassword(body.smtp, stored?.smtp), "SMTP");
    await Promise.all([assertPublicMailHost(imap.host), assertPublicMailHost(smtp.host)]);
    await testImapSmtpConnection(body.emailAddress, imap, smtp, AbortSignal.timeout(30_000));
    const account = await saveImapSmtpAccount({
      accountId,
      displayName: body.displayName.trim(),
      emailAddress: body.emailAddress,
      syncMode,
      credential: { kind: "imap_smtp", imap, smtp },
    });
    if (existingAccount && syncModeRank(syncMode) > syncModeRank(existingAccount.syncMode)) {
      await reopenAccountHistoryBackfill(account.id);
    }
    const sync = await runInitialImapSync(account.id, 100);
    return NextResponse.json({ ok: true, account: { ...account, syncStatus: "ready" }, sync }, { status: 201 });
  } catch (error) {
    const normalized = toPublicError(error);
    return NextResponse.json({ ok: false, code: normalized.code, message: normalized.message }, { status: normalized.status });
  }
}

function syncModeRank(mode: SyncMode): number {
  return { quick: 0, recommended: 1, full: 2 }[mode];
}
