import { NextResponse } from "next/server";

import { toCalDavPublicError } from "@/server/caldav-client";
import { getCalendarAccount } from "@/server/calendar-account-repository";
import { CalendarSyncAlreadyRunningError, syncCalDavAccount } from "@/server/caldav-sync";
import { toIcsSubscriptionPublicError } from "@/server/ics-subscription";
import { toExchangeCalendarPublicError } from "@/server/exchange-calendar";
import { runExchangeMailSync } from "@/server/exchange-mail-sync";
import { getExchangeMailAccountForCalendar } from "@/server/mail-repository";

export const runtime = "nodejs";
export const maxDuration = 60;

interface CalendarSyncRouteContext {
  readonly params: Promise<{ readonly accountId: string }>;
}

export async function POST(_request: Request, context: CalendarSyncRouteContext) {
  const { accountId } = await context.params;
  const account = await getCalendarAccount(accountId);
  if (!account) return NextResponse.json({ ok: false, message: "Kalenderkonten existieren nicht" }, { status: 404 });
  if (account.syncStatus === "syncing") return NextResponse.json({ ok: false, message: "Kalender-Konto synchronisiert sich" }, { status: 409 });
  try {
    const sync = account.calendarEnabled
      ? await syncCalDavAccount(accountId)
      : undefined;
    const mailAccount = account.providerId === "exchange" && account.mailEnabled
      ? await getExchangeMailAccountForCalendar(accountId)
      : undefined;
    const mailSync = mailAccount ? await runExchangeMailSync(mailAccount.id, 100) : undefined;
    return NextResponse.json({ ok: true, sync, mailSync });
  } catch (error) {
    if (error instanceof CalendarSyncAlreadyRunningError) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 409 });
    }
    const normalized = account.providerId === "ics"
      ? toIcsSubscriptionPublicError(error)
      : account.providerId === "exchange"
        ? toExchangeCalendarPublicError(error)
        : toCalDavPublicError(error);
    return NextResponse.json({ ok: false, code: normalized.code, message: normalized.message }, { status: normalized.status });
  }
}
