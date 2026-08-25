import { createHash } from "node:crypto";
import ICAL from "ical.js";

import type { CalDavEventRecord } from "./caldav-client";
import { assertPublicMailHost, PublicConnectionError } from "./mail-account-validation";

export interface IcsSubscriptionCredential {
  readonly kind: "ics";
  readonly feedUrl: string;
}

export interface IcsSubscriptionSnapshot {
  readonly calendarName?: string;
  readonly events: readonly CalDavEventRecord[];
  readonly etag?: string;
  readonly lastModified?: string;
}

interface IcsSubscriptionRange {
  readonly from: string;
  readonly to: string;
}

export class IcsSubscriptionError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "IcsSubscriptionError";
  }
}

export function parseIcsSubscriptionCredential(input: unknown): IcsSubscriptionCredential {
  if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).feedUrl !== "string") {
    throw new PublicConnectionError("INVALID_REQUEST", "Bitte geben Sie den ICS Kalender-Abonnement-Link ein", 400);
  }
  let url: URL;
  try {
    const rawUrl = (input as { feedUrl: string }).feedUrl.trim().replace(/^webcal:/i, "https:");
    url = new URL(rawUrl);
  } catch {
    throw new PublicConnectionError("INVALID_URL", "Ungültiger ICS-Kalender-Abonnement-Link", 400);
  }
  if (url.protocol !== "https:" && process.env.KALENDER_ALLOW_INSECURE_CALDAV !== "1") {
    throw new PublicConnectionError("HTTPS_REQUIRED", "ICS Kalender-Abonnement-Links müssen HTTPS verwenden", 400);
  }
  url.hash = "";
  return { kind: "ics", feedUrl: url.toString() };
}

export async function fetchIcsSubscription(
  credential: IcsSubscriptionCredential,
  signal?: AbortSignal,
): Promise<IcsSubscriptionSnapshot> {
  let url = new URL(credential.feedUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (url.protocol !== "https:" && process.env.KALENDER_ALLOW_INSECURE_CALDAV !== "1") {
      throw new IcsSubscriptionError("HTTPS_REQUIRED", "ICS Kalender-Abonnement-Links müssen HTTPS verwenden", 400);
    }
    await assertPublicMailHost(url.hostname);
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new IcsSubscriptionError("INVALID_REDIRECT", "ICS Server gab ungültigen Sprung zurück", 502);
      url = new URL(location, url);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new IcsSubscriptionError("ACCESS_DENIED", "Kalenderlinks sind deaktiviert oder der Server verweigert Zugriff", 401);
    }
    if (!response.ok) {
      throw new IcsSubscriptionError("REMOTE_ERROR", `ICS-Server gibt HTTP zurück ${response.status}`, 502);
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 5_000_000) throw new IcsSubscriptionError("FEED_TOO_LARGE", "ICS-Kalenderdatei größer als 5 MB", 413);
    const content = await response.text();
    if (Buffer.byteLength(content, "utf8") > 5_000_000) {
      throw new IcsSubscriptionError("FEED_TOO_LARGE", "ICS-Kalenderdatei größer als 5 MB", 413);
    }
    return parseIcsSubscriptionContent(
      content,
      icsSourceId(credential.feedUrl),
      response.headers.get("etag") ?? undefined,
      response.headers.get("last-modified") ?? undefined,
    );
  }
  throw new IcsSubscriptionError("TOO_MANY_REDIRECTS", "ICS-Server springt zu oft", 502);
}

export function parseIcsSubscriptionContent(
  content: string,
  sourceId: string,
  etag?: string,
  lastModified?: string,
  range: IcsSubscriptionRange = defaultSubscriptionRange(),
): IcsSubscriptionSnapshot {
  if (!/BEGIN:VCALENDAR/i.test(content) || !/END:VCALENDAR/i.test(content)) {
    throw new IcsSubscriptionError("INVALID_ICS", "Der vom Link zurückgegebene Inhalt ist kein gültiger ICS-Kalender", 422);
  }
  const unfolded = content.replace(/\r?\n[ \t]/g, "");
  const nameMatch = unfolded.match(/^(?:X-WR-CALNAME|NAME)(?:;[^:]*)?:(.+)$/im);
  const calendarName = nameMatch?.[1]?.trim().replace(/\\,/g, ",").replace(/\\[nN]/g, " ");
  try {
    const calendar = new ICAL.Component(ICAL.parse(content));
    const sourceUrl = `https://subscription.invalid/${sourceId}/calendar.ics`;
    const events = expandIcsEvents(calendar, sourceUrl, etag, range);
    return { calendarName: calendarName || undefined, events, etag, lastModified };
  } catch (error) {
    if (error instanceof IcsSubscriptionError) throw error;
    throw new IcsSubscriptionError("INVALID_ICS", "ICS-Kalenderinhalt kann nicht parsiert werden", 422);
  }
}

export function icsSubscriptionFingerprint(feedUrl: string): string {
  return createHash("sha256").update(feedUrl).digest("hex");
}

export function safeIcsSubscriptionLabel(feedUrl: string): string {
  const url = new URL(feedUrl);
  const filename = url.pathname.split("/").filter(Boolean).at(-1) || "calendar.ics";
  return `${url.origin}/…/${filename}`;
}

export function toIcsSubscriptionPublicError(error: unknown): { readonly code: string; readonly message: string; readonly status: number } {
  if (error instanceof IcsSubscriptionError || error instanceof PublicConnectionError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "TIMEOUT", message: "ICS-Kalenderverbindung oder Synchronisations-Timeout", status: 504 };
  }
  return { code: "ICS_ERROR", message: "ICS-Kalender-Abonnement kann nicht gelesen werden", status: 502 };
}

function icsSourceId(feedUrl: string): string {
  return icsSubscriptionFingerprint(feedUrl).slice(0, 24);
}

function expandIcsEvents(
  calendar: InstanceType<typeof ICAL.Component>,
  sourceUrl: string,
  etag: string | undefined,
  range: IcsSubscriptionRange,
): readonly CalDavEventRecord[] {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const components = calendar.getAllSubcomponents("vevent");
  const events = components.map((component) => new ICAL.Event(component));
  const masters = events.filter((event) => !event.isRecurrenceException());
  const expanded: CalDavEventRecord[] = [];
  for (const master of masters) {
    for (const exception of events.filter((event) => event.isRecurrenceException() && event.uid === master.uid)) {
      try { master.relateException(exception); } catch { /* Ignore malformed unrelated exceptions. */ }
    }
    if (!master.isRecurring()) {
      const event = mapIcalOccurrence(master, master.startDate, master.startDate, master.endDate, sourceUrl, etag);
      if (event.end > range.from && event.start < range.to) expanded.push(event);
      continue;
    }
    const iterator = master.iterator();
    for (let count = 0; count < 5_000; count += 1) {
      const occurrence = iterator.next();
      if (!occurrence) break;
      const occurrenceDate = occurrence.toJSDate();
      if (occurrenceDate >= to) break;
      const details = master.getOccurrenceDetails(occurrence);
      if (details.endDate.toJSDate() <= from) continue;
      expanded.push(mapIcalOccurrence(details.item, details.recurrenceId, details.startDate, details.endDate, sourceUrl, etag));
    }
  }
  return expanded;
}

function mapIcalOccurrence(
  event: InstanceType<typeof ICAL.Event>,
  recurrenceId: InstanceType<typeof ICAL.Time>,
  startDate: InstanceType<typeof ICAL.Time>,
  endDate: InstanceType<typeof ICAL.Time>,
  sourceUrl: string,
  etag?: string,
): CalDavEventRecord {
  const providerEventId = `${sourceUrl}#${event.uid || "event"}:${recurrenceId.toString()}`;
  const status = String(event.component.getFirstPropertyValue("status") ?? "").toUpperCase();
  const meetingUrl = stringValue(event.component.getFirstPropertyValue("url"));
  return {
    id: providerEventId,
    providerEventId,
    calendarId: sourceUrl.slice(0, sourceUrl.lastIndexOf("/") + 1),
    title: event.summary || "Kein Titel",
    description: event.description || undefined,
    location: event.location || undefined,
    start: startDate.toJSDate().toISOString(),
    end: endDate.toJSDate().toISOString(),
    timeZone: startDate.zone?.tzid || "Europe/Berlin",
    allDay: startDate.isDate,
    attendees: event.attendees.map((attendee) => ({
      address: String(attendee.getFirstValue() ?? "").replace(/^mailto:/i, ""),
      name: stringValue(attendee.getParameter("cn")),
    })).filter((attendee) => attendee.address),
    meetingUrl,
    status: status === "CANCELLED" ? "cancelled" : status === "TENTATIVE" ? "tentative" : "confirmed",
    etag,
    sourceUrl,
    providerData: { providerId: "ics", sourceUrl, etag },
  };
}

function defaultSubscriptionRange(): IcsSubscriptionRange {
  const from = new Date();
  from.setDate(from.getDate() - 180);
  const to = new Date();
  to.setFullYear(to.getFullYear() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return undefined;
}
