import { NextResponse } from "next/server";

import {
  CalDavCalendarProvider,
  parseCalDavCredential,
  toCalDavPublicError,
} from "@/server/caldav-client";
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

export const runtime = "nodejs";

export async function POST(request: Request) {
  let providerId = "caldav";
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    providerId = body?.providerId === "ics" ? "ics" : body?.providerId === "exchange" ? "exchange" : "caldav";
    if (providerId === "ics") {
      const credential = parseIcsSubscriptionCredential(body);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const startedAt = performance.now();
        const snapshot = await fetchIcsSubscription(credential, controller.signal);
        return NextResponse.json({
          ok: true,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - startedAt),
          message: `Verbindung erfolgreich getestet: ${snapshot.events.length} Termin(e) gelesen${snapshot.calendarName ? ` · ${snapshot.calendarName}` : ""}`,
          calendars: [{ name: snapshot.calendarName || "ICS-Abonnement", readOnly: true }],
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    if (providerId === "exchange") {
      const credential = parseExchangeCalendarCredential(body);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const startedAt = performance.now();
        const [calendar, folders] = await Promise.all([
          discoverExchangeCalendar(credential, controller.signal),
          discoverExchangeMailbox(credential, controller.signal),
        ]);
        const inbox = folders.find((folder) => folder.role === "inbox");
        return NextResponse.json({
          ok: true,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - startedAt),
          message: `Austausch erfolgreich verbunden . Kalender:${calendar.name} . Postfach:${inbox?.name ?? "Posteingang"}`,
          calendars: [{ name: calendar.name, readOnly: true }],
          mail: { enabled: true, folders: folders.length, inboxUnread: inbox?.unreadCount ?? 0 },
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    const credential = parseCalDavCredential(body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const provider = new CalDavCalendarProvider(credential.serverUrl);
      const context = {
        account: {
          id: "caldav-connection-test",
          providerId: "caldav",
          emailAddress: credential.username,
          displayName: typeof body?.displayName === "string" ? body.displayName : "CalDAV",
          enabled: true,
        },
        session: { kind: "basic" as const, username: credential.username, password: credential.password },
        signal: controller.signal,
      };
      const [result, calendars] = await Promise.all([
        provider.testConnection(context),
        provider.listCalendars(context),
      ]);
      return NextResponse.json({
        ...result,
        message: `erfolgreich verbunden, gefunden ${calendars.length} einen Kalender`,
        calendars: calendars.map((calendar) => ({ name: calendar.name, color: calendar.color, readOnly: calendar.readOnly })),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const normalized = providerId === "ics"
      ? toIcsSubscriptionPublicError(error)
      : providerId === "exchange"
        ? toExchangeCalendarPublicError(error)
        : toCalDavPublicError(error);
    return NextResponse.json({ ok: false, code: normalized.code, message: normalized.message }, { status: normalized.status });
  }
}
