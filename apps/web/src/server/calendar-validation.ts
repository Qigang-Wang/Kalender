import type {
  CalendarEventReminderMinutes,
  CalendarRecurrenceEditScope,
  CalendarRecurrenceRule,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import { normalizeCalendarRecurrence } from "../lib/calendar-recurrence";
import {
  PLATE_NOTE_PREFIX,
  decodeNoteContent,
  encodeNoteContent,
  noteContentToPlainText,
} from "../lib/note-content";

export interface CalendarEventRequestBody {
  readonly id?: unknown;
  readonly calendarId?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly descriptionContent?: unknown;
  readonly location?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly timeZone?: unknown;
  readonly allDay?: unknown;
  readonly reminderMinutesBefore?: unknown;
  readonly idempotencyKey?: unknown;
  readonly allowConflicts?: unknown;
  readonly recurrence?: unknown;
  readonly recurrenceSeriesId?: unknown;
  readonly recurrenceId?: unknown;
  readonly recurrenceScope?: unknown;
}

export function parseCalendarEventInput(body: CalendarEventRequestBody | null): UpsertCalendarEventInput {
  if (!body || typeof body.calendarId !== "string" || typeof body.title !== "string") {
    throw new CalendarValidationError("Bitte füllen Sie den Kalender-Event- und Kalender-Event-Titel aus");
  }
  const title = body.title.trim();
  if (!title || title.length > 200) throw new CalendarValidationError("Der Titel erfordert 1–200 Zeichen");
  const start = parseDate(body.start, "Startzeit");
  const end = parseDate(body.end, "Endzeit");
  if (end.getTime() <= start.getTime()) throw new CalendarValidationError("Die Endzeit muss später als die Startzeit sein.");
  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new CalendarValidationError("keine einzige Kalenderveranstaltung länger als 366 Tage");
  }
  const timeZone = typeof body.timeZone === "string" && body.timeZone.trim()
    ? body.timeZone.trim()
    : "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(start);
  } catch {
    throw new CalendarValidationError("Zeitzone ungültig");
  }
  const recurrence = parseRecurrence(body.recurrence);
  const recurrenceSeriesId = optionalIdentifier(body.recurrenceSeriesId);
  const recurrenceId = recurrenceSeriesId ? parseDate(body.recurrenceId, "doppelte Kalender-Ereigniszeit").toISOString() : undefined;
  const recurrenceScope = recurrenceSeriesId ? parseRecurrenceScope(body.recurrenceScope) : undefined;
  const descriptionContent = optionalRichText(body.descriptionContent);
  const description = descriptionContent
    ? noteContentToPlainText(descriptionContent) || undefined
    : optionalText(body.description, 100_000, "Beschreibung");
  if ((description?.length ?? 0) > 100_000) throw new CalendarValidationError("Beschreibung der übermäßigen Länge");
  return {
    id: typeof body.id === "string" && body.id ? body.id : undefined,
    calendarId: body.calendarId,
    title,
    description,
    descriptionContent,
    location: optionalText(body.location, 500, "Standort"),
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone,
    allDay: body.allDay === true,
    reminderMinutesBefore: parseReminderMinutes(body.reminderMinutesBefore),
    attendees: [],
    idempotencyKey: typeof body.idempotencyKey === "string" && body.idempotencyKey
      ? body.idempotencyKey.slice(0, 200)
      : undefined,
    recurrence,
    recurrenceSeriesId,
    recurrenceId,
    recurrenceScope,
  };
}

function parseReminderMinutes(value: unknown): CalendarEventReminderMinutes | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || ![0, 5, 15, 30, 60, 1440].includes(value)) {
    throw new CalendarValidationError("Erinnerungszeit ungültig");
  }
  return value as CalendarEventReminderMinutes;
}

function optionalRichText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 500_000 || !value.startsWith(PLATE_NOTE_PREFIX)) {
    throw new CalendarValidationError("das Text-Kommentar-Format ist ungültig");
  }
  return encodeNoteContent(decodeNoteContent(value));
}

export function parseCalendarRange(url: URL): { from: string; to: string; calendarIds?: readonly string[] } {
  const from = parseDate(url.searchParams.get("from"), "Anfangsdatum");
  const to = parseDate(url.searchParams.get("to"), "Enddatum");
  if (to.getTime() <= from.getTime()) throw new CalendarValidationError("Abfrage-Enddatum muss später als Startdatum sein");
  if (to.getTime() - from.getTime() > 370 * 24 * 60 * 60 * 1000) {
    throw new CalendarValidationError("maximal 370 Tage für einzelne Abfragen");
  }
  const calendarIds = url.searchParams.getAll("calendarId").filter(Boolean);
  return { from: from.toISOString(), to: to.toISOString(), calendarIds: calendarIds.length ? calendarIds : undefined };
}

export class CalendarValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "CalendarValidationError";
  }
}

function parseDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || !value) throw new CalendarValidationError(`bitte ausfüllen${label}`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new CalendarValidationError(`${label}ungültig`);
  return date;
}

function optionalText(value: unknown, maximum: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new CalendarValidationError(`${label}zu lang`);
  }
  return value.trim() || undefined;
}

function parseRecurrence(value: unknown): CalendarRecurrenceRule | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalendarValidationError("Duplikate Regeln sind ungültig");
  }
  const rule = value as Partial<CalendarRecurrenceRule>;
  try {
    return normalizeCalendarRecurrence({
      frequency: rule.frequency!,
      interval: rule.interval!,
      weekDays: Array.isArray(rule.weekDays) ? rule.weekDays : undefined,
      end: rule.end!,
      until: typeof rule.until === "string" ? rule.until : undefined,
      count: typeof rule.count === "number" ? rule.count : undefined,
    });
  } catch (error) {
    throw new CalendarValidationError(error instanceof Error ? error.message : "Duplikate Regeln sind ungültig");
  }
}

function optionalIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function parseRecurrenceScope(value: unknown): CalendarRecurrenceEditScope {
  if (value === undefined || value === "occurrence") return "occurrence";
  if (value === "following" || value === "series") return value;
  throw new CalendarValidationError("doppelte Kalender-Ereignisänderungen sind ungültig");
}
