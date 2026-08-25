import type {
  CalendarEvent,
  CalendarProvider,
  CalendarSummary,
  ListCalendarEventsInput,
  ProviderConnectionTestResult,
  ProviderContext,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import { assertPublicMailHost, PublicConnectionError } from "./mail-account-validation";

export interface CalDavCredential {
  readonly kind: "caldav";
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
}

export interface DiscoveredCalDavCalendar {
  readonly url: string;
  readonly name: string;
  readonly color: string;
  readonly readOnly: boolean;
}

export interface CalDavEventRecord extends CalendarEvent {
  readonly etag?: string;
  readonly sourceUrl: string;
}

export class CalDavCalendarProvider implements CalendarProvider {
  constructor(private readonly serverUrl: string) {}

  async testConnection(context: ProviderContext): Promise<ProviderConnectionTestResult> {
    const startedAt = performance.now();
    const credential = credentialFromContext(context, this.serverUrl);
    const calendars = await discoverCalDavCalendars(credential, context.signal);
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - startedAt),
      identity: context.account.emailAddress,
      checks: [{
        name: "calendar_read",
        status: "passed",
        message: `gefunden ${calendars.length} einen Kalender`,
      }],
    };
  }

  async listCalendars(context: ProviderContext): Promise<readonly CalendarSummary[]> {
    const credential = credentialFromContext(context, this.serverUrl);
    const calendars = await discoverCalDavCalendars(credential, context.signal);
    return calendars.map((calendar, index) => ({
      id: calendar.url,
      providerCalendarId: calendar.url,
      name: calendar.name,
      color: calendar.color,
      readOnly: calendar.readOnly,
      primary: index === 0,
      providerData: { providerId: "caldav", sourceUrl: calendar.url },
    }));
  }

  async listEvents(context: ProviderContext, input: ListCalendarEventsInput) {
    const credential = credentialFromContext(context, this.serverUrl);
    const calendars = await discoverCalDavCalendars(credential, context.signal);
    const selected = input.calendarIds?.length
      ? calendars.filter((calendar) => input.calendarIds?.includes(calendar.url))
      : calendars;
    const pages = await Promise.all(selected.map((calendar) => fetchCalDavEvents(
      credential,
      calendar.url,
      input,
      context.signal,
    )));
    return { items: pages.flat().slice(0, input.limit ?? 1000) };
  }

  async upsertEvent(_context: ProviderContext, _input: UpsertCalendarEventInput): Promise<CalendarEvent> {
    throw new CalDavError("READ_ONLY_PHASE", "CalDAV-Schreiben wird nach schreibgeschützter Synchronisierung aktiviert", 501);
  }

  async deleteEvent(_context: ProviderContext, _calendarId: string, _eventId: string): Promise<void> {
    throw new CalDavError("READ_ONLY_PHASE", "CalDAV-Schreiben wird nach schreibgeschützter Synchronisierung aktiviert", 501);
  }
}

export function parseCalDavCredential(input: unknown): CalDavCredential {
  if (!input || typeof input !== "object") {
    throw new PublicConnectionError("INVALID_REQUEST", "Bitte füllen Sie CalDAV-Server, Benutzername und Passwort aus", 400);
  }
  const value = input as Record<string, unknown>;
  if (typeof value.serverUrl !== "string" || typeof value.username !== "string" || typeof value.password !== "string") {
    throw new PublicConnectionError("INVALID_REQUEST", "Bitte füllen Sie CalDAV-Server, Benutzername und Passwort aus", 400);
  }
  let url: URL;
  try {
    url = new URL(value.serverUrl.trim());
  } catch {
    throw new PublicConnectionError("INVALID_URL", "CalDAV-Serveradresse ist nicht gültig", 400);
  }
  if (url.protocol !== "https:" && process.env.KALENDER_ALLOW_INSECURE_CALDAV !== "1") {
    throw new PublicConnectionError("HTTPS_REQUIRED", "CalDAV-Server muss HTTPS verwenden", 400);
  }
  if (!value.username.trim() || !value.password) {
    throw new PublicConnectionError("INVALID_REQUEST", "Bitte füllen Sie CalDAV Benutzername und Passwort aus", 400);
  }
  url.hash = "";
  return { kind: "caldav", serverUrl: url.toString(), username: value.username.trim(), password: value.password };
}

export async function discoverCalDavCalendars(
  credential: CalDavCredential,
  signal?: AbortSignal,
): Promise<readonly DiscoveredCalDavCalendar[]> {
  const rootXml = await propfind(credential, credential.serverUrl, "0", discoveryProperties, signal);
  let homeUrl = nestedHref(rootXml, "calendar-home-set");
  if (!homeUrl) {
    const principalHref = nestedHref(rootXml, "current-user-principal");
    if (principalHref) {
      const principalUrl = new URL(principalHref, credential.serverUrl).toString();
      const principalXml = await propfind(credential, principalUrl, "0", discoveryProperties, signal);
      homeUrl = nestedHref(principalXml, "calendar-home-set");
    }
  }
  const calendarHome = new URL(homeUrl ?? credential.serverUrl, credential.serverUrl).toString();
  const calendarsXml = await propfind(credential, calendarHome, "1", calendarProperties, signal);
  const calendars = parseCalendarDiscoveryResponse(calendarsXml, calendarHome);
  if (!calendars.length) {
    throw new CalDavError("NO_CALENDARS", "Erfolgreich verbunden, aber kein lesbarer CalDAV-Kalender wurde im Konto gefunden", 409);
  }
  return calendars;
}

export async function fetchCalDavEvents(
  credential: CalDavCredential,
  calendarUrl: string,
  input: Pick<ListCalendarEventsInput, "from" | "to">,
  signal?: AbortSignal,
): Promise<readonly CalDavEventRecord[]> {
  const rangeStart = toCalDavTime(input.from);
  const rangeEnd = toCalDavTime(input.to);
  const body = `<?xml version="1.0" encoding="utf-8" ?>
    <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop><d:getetag/><c:calendar-data><c:expand start="${rangeStart}" end="${rangeEnd}"/></c:calendar-data></d:prop>
      <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
        <c:time-range start="${rangeStart}" end="${rangeEnd}"/>
      </c:comp-filter></c:comp-filter></c:filter>
    </c:calendar-query>`;
  const response = await calDavFetch(credential, calendarUrl, {
    method: "REPORT",
    headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
    body,
    signal,
  });
  const xml = await response.text();
  return parseCalendarEventResponse(xml, calendarUrl);
}

export function parseCalendarDiscoveryResponse(xml: string, baseUrl: string): readonly DiscoveredCalDavCalendar[] {
  return xmlResponses(xml).flatMap((response) => {
    const resourceType = tagContent(response, "resourcetype") ?? "";
    if (!/<(?:[\w-]+:)?calendar(?:\s[^>]*)?\s*\/?\s*>/i.test(resourceType)) return [];
    const href = xmlText(response, "href");
    if (!href) return [];
    const status = xmlText(response, "status") ?? "";
    const readOnly = /403|404/.test(status) || !/<(?:[\w-]+:)?write(?:\s|\/|>)/i.test(tagContent(response, "current-user-privilege-set") ?? "");
    return [{
      url: new URL(href, baseUrl).toString(),
      name: xmlText(response, "displayname") || "unbenannter Kalender",
      color: normalizeCalendarColor(xmlText(response, "calendar-color")),
      readOnly,
    }];
  });
}

export function parseCalendarEventResponse(xml: string, calendarUrl: string): readonly CalDavEventRecord[] {
  return xmlResponses(xml).flatMap((response) => {
    const sourceHref = xmlText(response, "href");
    const calendarData = xmlText(response, "calendar-data");
    if (!calendarData) return [];
    return parseIcsEvents(calendarData, sourceHref ? new URL(sourceHref, calendarUrl).toString() : calendarUrl, xmlText(response, "getetag"));
  });
}

export function parseIcsEvents(ics: string, sourceUrl: string, etag?: string): readonly CalDavEventRecord[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const blocks = [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/gi)].map((match) => match[1] ?? "");
  return blocks.flatMap((block) => {
    const properties = parseIcsProperties(block);
    const startProperty = properties.find((property) => property.name === "DTSTART");
    if (!startProperty) return [];
    const endProperty = properties.find((property) => property.name === "DTEND");
    const allDay = startProperty.parameters.VALUE === "DATE" || /^\d{8}$/.test(startProperty.value);
    const start = parseIcsDate(startProperty.value, startProperty.parameters.TZID);
    const end = endProperty
      ? parseIcsDate(endProperty.value, endProperty.parameters.TZID)
      : new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));
    if (end <= start) return [];
    const uid = propertyValue(properties, "UID") || sourceUrl;
    const recurrenceId = propertyValue(properties, "RECURRENCE-ID");
    const statusValue = propertyValue(properties, "STATUS").toUpperCase();
    const attendees = properties.filter((property) => property.name === "ATTENDEE").map((property) => ({
      address: property.value.replace(/^mailto:/i, ""),
      name: property.parameters.CN,
    }));
    return [{
      id: `${sourceUrl}#${uid}${recurrenceId ? `:${recurrenceId}` : ""}`,
      providerEventId: `${sourceUrl}#${uid}${recurrenceId ? `:${recurrenceId}` : ""}`,
      calendarId: calendarUrlFromEventSource(sourceUrl),
      title: propertyValue(properties, "SUMMARY") || "Kein Titel",
      description: optionalPropertyValue(properties, "DESCRIPTION"),
      location: optionalPropertyValue(properties, "LOCATION"),
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: startProperty.parameters.TZID || "Europe/Berlin",
      allDay,
      attendees,
      meetingUrl: optionalPropertyValue(properties, "URL"),
      status: statusValue === "CANCELLED" ? "cancelled" : statusValue === "TENTATIVE" ? "tentative" : "confirmed",
      availability: propertyValue(properties, "TRANSP").toUpperCase() === "TRANSPARENT" ? "free" : "busy",
      etag,
      sourceUrl,
      providerData: { providerId: "caldav", sourceUrl, etag },
    }];
  });
}

export class CalDavError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "CalDavError";
  }
}

export function toCalDavPublicError(error: unknown): { readonly code: string; readonly message: string; readonly status: number } {
  if (error instanceof CalDavError || error instanceof PublicConnectionError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "TIMEOUT", message: "CalDAV-Verbindung oder Synchronisations-Timeout", status: 504 };
  }
  return { code: "CALDAV_ERROR", message: "CalDAV-Server kann nicht angeschlossen werden", status: 502 };
}

const discoveryProperties = `
  <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/></d:prop>
  </d:propfind>`;

const calendarProperties = `
  <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
    <d:prop><d:displayname/><d:resourcetype/><a:calendar-color/><d:current-user-privilege-set/></d:prop>
  </d:propfind>`;

async function propfind(
  credential: CalDavCredential,
  url: string,
  depth: "0" | "1",
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await calDavFetch(credential, url, {
    method: "PROPFIND",
    headers: { "Content-Type": "application/xml; charset=utf-8", Depth: depth },
    body,
    signal,
  });
  return response.text();
}

async function calDavFetch(
  credential: CalDavCredential,
  initialUrl: string,
  init: RequestInit,
): Promise<Response> {
  let url = new URL(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (url.protocol !== "https:" && process.env.KALENDER_ALLOW_INSECURE_CALDAV !== "1") {
      throw new CalDavError("HTTPS_REQUIRED", "CalDAV-Server muss HTTPS verwenden", 400);
    }
    await assertPublicMailHost(url.hostname);
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        ...init.headers,
        Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`,
      },
    });
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new CalDavError("INVALID_REDIRECT", "CalDAV Server gab ungültigen Sprung", 502);
      url = new URL(location, url);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new CalDavError("AUTH_REQUIRED", "CalDAV Server abgelehnt Benutzername oder Anwendung eines speziellen Passworts", 401);
    }
    if (!response.ok && response.status !== 207) {
      throw new CalDavError("REMOTE_ERROR", `CalDAV Server gibt HTTP zurück ${response.status}`, 502);
    }
    return response;
  }
  throw new CalDavError("TOO_MANY_REDIRECTS", "CalDAV Server springt zu oft", 502);
}

function credentialFromContext(context: ProviderContext, serverUrl: string): CalDavCredential {
  if (context.session.kind !== "basic") throw new CalDavError("AUTH_REQUIRED", "CalDAV benötigt Benutzername und Passwort", 401);
  return { kind: "caldav", serverUrl, username: context.session.username, password: context.session.password };
}

function xmlResponses(xml: string): readonly string[] {
  return [...xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)].map((match) => match[1] ?? "");
}

function tagContent(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, "i"))?.[1];
}

function xmlText(xml: string, name: string): string | undefined {
  const content = tagContent(xml, name);
  return content === undefined ? undefined : decodeXml(content.replace(/<[^>]+>/g, "").trim());
}

function nestedHref(xml: string, container: string): string | undefined {
  const content = tagContent(xml, container);
  return content ? xmlText(content, "href") : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeCalendarColor(value?: string): string {
  const candidate = value?.trim().slice(0, 7);
  return candidate && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : "#86bdf5";
}

interface IcsProperty {
  readonly name: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly value: string;
}

function parseIcsProperties(block: string): readonly IcsProperty[] {
  return block.split(/\r?\n/).flatMap((line) => {
    const colon = line.indexOf(":");
    if (colon < 1) return [];
    const [name, ...parameterParts] = line.slice(0, colon).split(";");
    const parameters = Object.fromEntries(parameterParts.map((part) => {
      const separator = part.indexOf("=");
      return separator > 0 ? [part.slice(0, separator).toUpperCase(), part.slice(separator + 1).replace(/^"|"$/g, "")] : [part.toUpperCase(), ""];
    }));
    return [{ name: name?.toUpperCase() ?? "", parameters, value: unescapeIcs(line.slice(colon + 1)) }];
  });
}

function propertyValue(properties: readonly IcsProperty[], name: string): string {
  return properties.find((property) => property.name === name)?.value ?? "";
}

function optionalPropertyValue(properties: readonly IcsProperty[], name: string): string | undefined {
  return propertyValue(properties, name) || undefined;
}

function unescapeIcs(value: string): string {
  return value.replace(/\\[nN]/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseIcsDate(value: string, timeZone?: string): Date {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) throw new CalDavError("INVALID_EVENT", "CalDAV-Kalenderveranstaltung enthält unerkennbare Termine", 502);
  const parts = match.slice(1, 7).map((part) => Number(part ?? 0));
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = parts;
  if (match[7] === "Z" || !timeZone) return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return zonedDateToUtc({ year, month, day, hour, minute, second }, timeZone);
}

function zonedDateToUtc(
  parts: { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly second: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  try {
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const value = Object.fromEntries(formatted.map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second));
    return new Date(guess - (represented - guess));
  } catch {
    return new Date(guess);
  }
}

function toCalDavTime(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function calendarUrlFromEventSource(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  url.search = "";
  url.hash = "";
  return url.toString();
}
