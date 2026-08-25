import type {
  CalendarEvent,
  CalendarRecurrenceEditScope,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import { loadExchangeCalendarCredential, saveExchangeCalendarMutation } from "./calendar-account-repository";
import {
  CalendarRepositoryError,
  deleteStoredCalendarEvent,
  getStoredCalendarEvent,
} from "./calendar-repository";
import { getDatabase } from "./database";
import {
  createExchangeCalendarEvent,
  deleteExchangeCalendarEvent,
  updateExchangeCalendarEvent,
  type ExchangeCalendarFolder,
} from "./exchange-calendar";
import { localCalendarContext, localCalendarProvider } from "./local-calendar-provider";

interface CalendarWriteTargetRow {
  provider_id: string;
  provider_calendar_id: string;
  account_id: string | null;
  read_only: boolean;
}

interface ExchangeEventTargetRow {
  provider_item_id: string | null;
  provider_change_key: string | null;
  is_meeting: boolean;
  is_recurring: boolean;
  availability: NonNullable<CalendarEvent["availability"]>;
}

export async function upsertCalendarEvent(input: UpsertCalendarEventInput): Promise<CalendarEvent> {
  const target = await getCalendarWriteTarget(input.calendarId);
  if (target.provider_id === "local-calendar") {
    return localCalendarProvider.upsertEvent(localCalendarContext, input);
  }
  if (input.recurrence || input.recurrenceSeriesId) {
    throw new CalendarRepositoryError("REMOTE_RECURRENCE_UNSUPPORTED", "Die aktuelle Version unterstützt nur das Erstellen und Ändern von doppelten Kalenderereignissen in einzelnen Kalenderereignissen", 409);
  }
  if (target.provider_id !== "exchange" || !target.account_id) {
    throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "Dieser Remote-Kalender wird für das Zurückschreiben nicht unterstützt", 409);
  }

  const credential = await loadExchangeCalendarCredential(target.account_id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    let remoteEvent;
    if (input.id) {
      const existing = await getExchangeEventTarget(input.id, input.calendarId);
      assertSafeExchangeMutation(existing);
      remoteEvent = await updateExchangeCalendarEvent(credential, {
        itemId: existing.provider_item_id!,
        changeKey: existing.provider_change_key ?? undefined,
      }, { ...input, availability: existing.availability }, controller.signal);
    } else {
      const folderId = target.provider_calendar_id.startsWith(`${target.account_id}:`)
        ? target.provider_calendar_id.slice(target.account_id.length + 1)
        : target.provider_calendar_id;
      const folder: ExchangeCalendarFolder = { folderId, name: "Austauschkalender" };
      remoteEvent = await createExchangeCalendarEvent(credential, folder, input, controller.signal);
    }
    const eventId = await saveExchangeCalendarMutation(
      input.calendarId,
      remoteEvent,
      input.id,
      input.descriptionContent,
      input.reminderMinutesBefore,
    );
    const saved = await getStoredCalendarEvent(eventId);
    if (!saved) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "RWTH gespeichert Kalender-Ereignis, aber lokale Index-Update fehlgeschlagen", 500);
    return saved;
  } finally {
    clearTimeout(timeout);
  }
}

export async function deleteCalendarEvent(
  calendarId: string,
  eventId: string,
  recurrence?: {
    readonly seriesId: string;
    readonly recurrenceId: string;
    readonly scope: CalendarRecurrenceEditScope;
  },
): Promise<void> {
  const target = await getCalendarWriteTarget(calendarId);
  if (target.provider_id === "local-calendar") {
    await deleteStoredCalendarEvent(calendarId, eventId, recurrence ? {
      recurrenceSeriesId: recurrence.seriesId,
      recurrenceId: recurrence.recurrenceId,
      recurrenceScope: recurrence.scope,
    } : undefined);
    return;
  }
  if (target.provider_id !== "exchange" || !target.account_id) {
    throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "Dieser Remote-Kalender wird nicht zum Löschen unterstützt", 409);
  }
  const existing = await getExchangeEventTarget(eventId, calendarId);
  assertSafeExchangeMutation(existing);
  const credential = await loadExchangeCalendarCredential(target.account_id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    await deleteExchangeCalendarEvent(credential, {
      itemId: existing.provider_item_id!,
      changeKey: existing.provider_change_key ?? undefined,
    }, controller.signal);
    await localCalendarProvider.deleteEvent(localCalendarContext, calendarId, eventId);
  } finally {
    clearTimeout(timeout);
  }
}

async function getCalendarWriteTarget(calendarId: string): Promise<CalendarWriteTargetRow> {
  const database = await getDatabase();
  const result = await database.query<CalendarWriteTargetRow>(
    `SELECT provider_id, provider_calendar_id, account_id, read_only
       FROM calendars WHERE id = $1 LIMIT 1`,
    [calendarId],
  );
  const target = result.rows[0];
  if (!target) throw new CalendarRepositoryError("CALENDAR_NOT_FOUND", "Kalender existiert nicht", 404);
  if (target.read_only) throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "Dieser Kalender ist derzeit nur lesbar", 409);
  return target;
}

async function getExchangeEventTarget(eventId: string, calendarId: string): Promise<ExchangeEventTargetRow> {
  const database = await getDatabase();
  const result = await database.query<ExchangeEventTargetRow>(
    `SELECT provider_item_id, provider_change_key, is_meeting, is_recurring, availability
       FROM calendar_events
      WHERE id = $1 AND calendar_id = $2
      LIMIT 1`,
    [eventId, calendarId],
  );
  const event = result.rows[0];
  if (!event) throw new CalendarRepositoryError("EVENT_NOT_FOUND", "Das Kalenderereignis existiert nicht", 404);
  return event;
}

function assertSafeExchangeMutation(event: ExchangeEventTargetRow): void {
  if (!event.provider_item_id) {
    throw new CalendarRepositoryError("REMOTE_ID_MISSING", "Bitte synchronisieren Sie den RWTH-Kalender sofort, bevor Sie versuchen, ihn zu ändern", 409);
  }
  if (event.is_recurring) {
    throw new CalendarRepositoryError("RECURRING_EVENT_PROTECTED", "Die aktuelle Version ändert die doppelte Kalenderveranstaltung nicht, bitte verarbeiten Sie sie auf der RWTH-Webseite Ende", 409);
  }
  if (event.is_meeting) {
    throw new CalendarRepositoryError("MEETING_EVENT_PROTECTED", "die aktuelle Version ändert das Treffen mit den Teilnehmern nicht und vermeidet missbräuchliche Ankündigung der Sitzung", 409);
  }
}
