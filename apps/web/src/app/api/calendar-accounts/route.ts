import { NextResponse } from "next/server";

import {
  CalDavCalendarProvider,
  parseCalDavCredential,
  toCalDavPublicError,
} from "@/server/caldav-client";
import { listCalendarAccounts, saveCalDavAccount, saveExchangeCalendarAccount } from "@/server/calendar-account-repository";
import { syncCalDavAccount } from "@/server/caldav-sync";
import { saveIcsSubscription } from "@/server/calendar-account-repository";
import {
  fetchIcsSubscription,
  parseIcsSubscriptionCredential,
  toIcsSubscriptionPublicError,
} from "@/server/ics-subscription";
import {
  discoverExchangeCalendar,
  parseExchangeCalendarCredential,
  toExchangeCalendarPublicError,
} from "@/server/exchange-calendar";
import { discoverExchangeMailbox } from "@/server/exchange-mail";
import { runExchangeMailSync } from "@/server/exchange-mail-sync";
import { getExchangeMailAccountForCalendar } from "@/server/mail-repository";
import { ensureCalendarSyncScheduler } from "@/server/calendar-sync-scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const scheduler = await ensureCalendarSyncScheduler();
  return NextResponse.json({ ok: true, accounts: await listCalendarAccounts(), scheduler });
}

export async function POST(request: Request) {
  let providerId = "caldav";
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.displayName !== "string" || !body.displayName.trim()) {
      return NextResponse.json({ ok: false, message: "请输入日历账户名称" }, { status: 400 });
    }
    providerId = body.providerId === "ics" ? "ics" : body.providerId === "exchange" ? "exchange" : "caldav";
    if (providerId === "ics") {
      const credential = parseIcsSubscriptionCredential(body);
      await fetchIcsSubscription(credential, AbortSignal.timeout(30_000));
      const account = await saveIcsSubscription(body.displayName.trim(), credential);
      const sync = await syncCalDavAccount(account.id);
      return NextResponse.json({ ok: true, account: await listCalendarAccounts().then((accounts) => accounts.find((item) => item.id === account.id)), sync }, { status: 201 });
    }
    if (providerId === "exchange") {
      const credential = parseExchangeCalendarCredential(body);
      const emailAddress = typeof body.emailAddress === "string" ? body.emailAddress.trim().toLocaleLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
        return NextResponse.json({ ok: false, message: "请输入正式的 Exchange 邮箱地址（可与登录用户名不同）" }, { status: 400 });
      }
      await Promise.all([
        discoverExchangeCalendar(credential, AbortSignal.timeout(30_000)),
        discoverExchangeMailbox(credential, AbortSignal.timeout(30_000)),
      ]);
      const account = await saveExchangeCalendarAccount(body.displayName.trim(), credential, emailAddress);
      const mailAccount = await getExchangeMailAccountForCalendar(account.id);
      const [sync, mailSync] = await Promise.all([
        syncCalDavAccount(account.id),
        mailAccount ? runExchangeMailSync(mailAccount.id, 100) : Promise.resolve(undefined),
      ]);
      return NextResponse.json({
        ok: true,
        account: await listCalendarAccounts().then((accounts) => accounts.find((item) => item.id === account.id)),
        sync,
        mailSync,
      }, { status: 201 });
    }
    const credential = parseCalDavCredential(body);
    const provider = new CalDavCalendarProvider(credential.serverUrl);
    await provider.testConnection({
      account: {
        id: "caldav-save-test",
        providerId: "caldav",
        emailAddress: credential.username,
        displayName: body.displayName.trim(),
        enabled: true,
      },
      session: { kind: "basic", username: credential.username, password: credential.password },
      signal: AbortSignal.timeout(30_000),
    });
    const account = await saveCalDavAccount(body.displayName.trim(), credential);
    const sync = await syncCalDavAccount(account.id);
    return NextResponse.json({ ok: true, account: await listCalendarAccounts().then((accounts) => accounts.find((item) => item.id === account.id)), sync }, { status: 201 });
  } catch (error) {
    const normalized = providerId === "ics"
      ? toIcsSubscriptionPublicError(error)
      : providerId === "exchange"
        ? toExchangeCalendarPublicError(error)
        : toCalDavPublicError(error);
    return NextResponse.json({ ok: false, code: normalized.code, message: normalized.message }, { status: normalized.status });
  }
}
