import type { ProviderContext } from "../../../../src/mail/types";

import { CalDavCalendarProvider, fetchCalDavEvents } from "./caldav-client";
import {
  getCalendarAccount,
  loadCalDavCredential,
  loadExchangeCalendarCredential,
  loadIcsSubscriptionCredential,
  saveCalDavEvents,
  saveDiscoveredCalendar,
  saveExchangeCalendar,
  saveExchangeCalendarEvents,
  saveIcsSubscriptionCalendar,
  setCalendarAccountSyncStatus,
} from "./calendar-account-repository";
import { discoverExchangeCalendar, fetchExchangeCalendarEvents } from "./exchange-calendar";
import { fetchIcsSubscription, safeIcsSubscriptionLabel } from "./ics-subscription";

declare global {
  var kalenderActiveCalendarSyncs: Set<string> | undefined;
}

export interface CalDavSyncResult {
  readonly calendarsProcessed: number;
  readonly eventsProcessed: number;
  readonly from: string;
  readonly to: string;
}

export async function syncCalDavAccount(accountId: string): Promise<CalDavSyncResult> {
  const activeSyncs = globalThis.kalenderActiveCalendarSyncs ??= new Set();
  if (activeSyncs.has(accountId)) throw new CalendarSyncAlreadyRunningError();
  activeSyncs.add(accountId);
  try {
    const account = await getCalendarAccount(accountId);
    if (!account) throw new Error("日历账户不存在");
    if (account.providerId === "ics") return syncIcsSubscriptionAccount(accountId);
    if (account.providerId === "exchange") return syncExchangeCalendarAccount(accountId);
    const credential = await loadCalDavCredential(accountId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    await setCalendarAccountSyncStatus(accountId, "syncing");
    try {
      const context: ProviderContext = {
        account: {
          id: account.id,
          providerId: "caldav",
          emailAddress: account.username,
          displayName: account.displayName,
          enabled: true,
        },
        session: { kind: "basic", username: credential.username, password: credential.password },
        signal: controller.signal,
      };
      const provider = new CalDavCalendarProvider(credential.serverUrl);
      const calendars = await provider.listCalendars(context);
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 180);
      const toDate = new Date();
      toDate.setFullYear(toDate.getFullYear() + 1);
      const from = fromDate.toISOString();
      const to = toDate.toISOString();
      let eventsProcessed = 0;
      for (const [index, calendar] of calendars.entries()) {
        const sourceUrl = String(calendar.providerData?.sourceUrl ?? calendar.providerCalendarId);
        const storedCalendarId = await saveDiscoveredCalendar(accountId, {
          url: sourceUrl,
          name: calendar.name,
          color: account.colorOverride ?? calendar.color ?? account.color,
          readOnly: true,
        }, index === 0);
        const events = await fetchCalDavEvents(credential, sourceUrl, { from, to }, controller.signal);
        eventsProcessed += await saveCalDavEvents(storedCalendarId, events, from, to);
      }
      await setCalendarAccountSyncStatus(accountId, "ready");
      return { calendarsProcessed: calendars.length, eventsProcessed, from, to };
    } catch (error) {
      const message = error instanceof Error ? error.message : "CalDAV 同步失败";
      await setCalendarAccountSyncStatus(accountId, "error", message);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    activeSyncs.delete(accountId);
  }
}

export function isCalendarAccountSyncing(accountId: string): boolean {
  return globalThis.kalenderActiveCalendarSyncs?.has(accountId) ?? false;
}

export class CalendarSyncAlreadyRunningError extends Error {
  constructor() {
    super("该日历账户正在同步");
    this.name = "CalendarSyncAlreadyRunningError";
  }
}

export async function syncExchangeCalendarAccount(accountId: string): Promise<CalDavSyncResult> {
  const account = await getCalendarAccount(accountId);
  if (!account || account.providerId !== "exchange") throw new Error("Exchange 日历账户不存在");
  const credential = await loadExchangeCalendarCredential(accountId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  await setCalendarAccountSyncStatus(accountId, "syncing");
  try {
    const folder = await discoverExchangeCalendar(credential, controller.signal);
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 180);
    const toDate = new Date();
    toDate.setFullYear(toDate.getFullYear() + 1);
    const from = fromDate.toISOString();
    const to = toDate.toISOString();
    const calendarId = await saveExchangeCalendar(accountId, folder, credential.serverUrl, account.color);
    const events = await fetchExchangeCalendarEvents(credential, folder, { from, to }, controller.signal);
    const eventsProcessed = await saveExchangeCalendarEvents(calendarId, events, from, to);
    await setCalendarAccountSyncStatus(accountId, "ready");
    return { calendarsProcessed: 1, eventsProcessed, from, to };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Exchange 日历同步失败";
    await setCalendarAccountSyncStatus(accountId, "error", message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncIcsSubscriptionAccount(accountId: string): Promise<CalDavSyncResult> {
  const account = await getCalendarAccount(accountId);
  if (!account || account.providerId !== "ics") throw new Error("ICS 日历订阅不存在");
  const credential = await loadIcsSubscriptionCredential(accountId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  await setCalendarAccountSyncStatus(accountId, "syncing");
  try {
    const snapshot = await fetchIcsSubscription(credential, controller.signal);
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 180);
    const toDate = new Date();
    toDate.setFullYear(toDate.getFullYear() + 1);
    const from = fromDate.toISOString();
    const to = toDate.toISOString();
    const calendarId = await saveIcsSubscriptionCalendar(
      accountId,
      snapshot.calendarName || account.displayName,
      safeIcsSubscriptionLabel(credential.feedUrl),
      account.color,
    );
    const events = snapshot.events.filter((event) => event.end > from && event.start < to);
    const eventsProcessed = await saveCalDavEvents(calendarId, events, from, to);
    await setCalendarAccountSyncStatus(accountId, "ready");
    return { calendarsProcessed: 1, eventsProcessed, from, to };
  } catch (error) {
    const message = error instanceof Error ? error.message : "ICS 日历同步失败";
    await setCalendarAccountSyncStatus(accountId, "error", message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
