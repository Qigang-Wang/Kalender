import { randomUUID } from "node:crypto";

import type {
  CalendarEvent,
  CalendarSummary,
  ListCalendarEventsInput,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import { getDatabase } from "./database";

interface CalendarRow {
  id: string;
  provider_id: string;
  provider_calendar_id: string;
  name: string;
  color: string;
  read_only: boolean;
  is_primary: boolean;
  time_zone: string;
}

interface CalendarEventRow {
  id: string;
  provider_event_id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  all_day: boolean;
  attendees: readonly { address: string; name?: string }[];
  meeting_url: string | null;
  status: CalendarEvent["status"];
  provider_item_id: string | null;
  provider_change_key: string | null;
  is_meeting: boolean;
  is_recurring: boolean;
  is_organizer: boolean | null;
}

export interface CalendarEventConflict {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

export async function listStoredCalendars(): Promise<readonly CalendarSummary[]> {
  const database = await getDatabase();
  const result = await database.query<CalendarRow>(
    `SELECT c.id, c.provider_id, c.provider_calendar_id,
            COALESCE(a.display_name, c.name) AS name,
            c.color, c.read_only, c.is_primary, c.time_zone
       FROM calendars c
       LEFT JOIN calendar_accounts a ON a.id = c.account_id
      ORDER BY c.is_primary DESC, c.created_at, COALESCE(a.display_name, c.name)`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    providerCalendarId: row.provider_calendar_id,
    name: row.name,
    color: row.color,
    readOnly: row.read_only,
    primary: row.is_primary,
    providerData: { timeZone: row.time_zone, providerId: row.provider_id },
  }));
}

export async function listStoredCalendarEvents(
  input: ListCalendarEventsInput,
): Promise<readonly CalendarEvent[]> {
  const database = await getDatabase();
  const calendarIds = input.calendarIds?.filter(Boolean) ?? [];
  const limit = Math.max(1, Math.min(input.limit ?? 500, 1000));
  const result = await database.query<CalendarEventRow>(
    `SELECT id, provider_event_id, calendar_id, title, description, location,
            starts_at, ends_at, time_zone, all_day, attendees, meeting_url, status,
            provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer
       FROM calendar_events
      WHERE ends_at > $1 AND starts_at < $2
        AND ($3::text[] IS NULL OR calendar_id = ANY($3::text[]))
      ORDER BY starts_at, ends_at, title
      LIMIT $4`,
    [input.from, input.to, calendarIds.length ? calendarIds : null, limit],
  );
  return result.rows.map(mapCalendarEvent);
}

export async function getStoredCalendarEvent(eventId: string): Promise<CalendarEvent | undefined> {
  const database = await getDatabase();
  const result = await database.query<CalendarEventRow>(
    `SELECT id, provider_event_id, calendar_id, title, description, location,
            starts_at, ends_at, time_zone, all_day, attendees, meeting_url, status,
            provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer
       FROM calendar_events
      WHERE id = $1
      LIMIT 1`,
    [eventId],
  );
  return result.rows[0] ? mapCalendarEvent(result.rows[0]) : undefined;
}

export async function listStoredCalendarEventConflicts(input: {
  readonly calendarId: string;
  readonly start: string;
  readonly end: string;
  readonly excludeEventId?: string;
}): Promise<readonly CalendarEventConflict[]> {
  const database = await getDatabase();
  const result = await database.query<Pick<CalendarEventRow, "id" | "title" | "starts_at" | "ends_at">>(
    `SELECT id, title, starts_at, ends_at
       FROM calendar_events
      WHERE calendar_id = $1 AND status <> 'cancelled'
        AND starts_at < $3 AND ends_at > $2
        AND ($4::text IS NULL OR id <> $4)
      ORDER BY starts_at, ends_at, title`,
    [input.calendarId, input.start, input.end, input.excludeEventId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    start: new Date(row.starts_at).toISOString(),
    end: new Date(row.ends_at).toISOString(),
  }));
}

export async function upsertStoredCalendarEvent(
  input: UpsertCalendarEventInput,
): Promise<CalendarEvent> {
  const database = await getDatabase();
  const existingCalendar = await database.query<{ read_only: boolean }>(
    "SELECT read_only FROM calendars WHERE id = $1 LIMIT 1",
    [input.calendarId],
  );
  const calendar = existingCalendar.rows[0];
  if (!calendar) throw new CalendarRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
  if (calendar.read_only) throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "该日历为只读", 409);

  if (input.id) {
    const existingEvent = await database.query<{ id: string; calendar_id: string }>(
      "SELECT id, calendar_id FROM calendar_events WHERE id = $1 LIMIT 1",
      [input.id],
    );
    const event = existingEvent.rows[0];
    if (!event) throw new CalendarRepositoryError("EVENT_NOT_FOUND", "日程不存在", 404);
    if (event.calendar_id !== input.calendarId) {
      throw new CalendarRepositoryError("EVENT_CALENDAR_MISMATCH", "不能把日程移动到未知日历", 409);
    }
  } else if (input.idempotencyKey) {
    const existingEvent = await database.query<CalendarEventRow>(
      `SELECT id, provider_event_id, calendar_id, title, description, location,
              starts_at, ends_at, time_zone, all_day, attendees, meeting_url, status,
              provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer
         FROM calendar_events
        WHERE calendar_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [input.calendarId, input.idempotencyKey],
    );
    if (existingEvent.rows[0]) return mapCalendarEvent(existingEvent.rows[0]);
  }

  const eventId = input.id ?? randomUUID();
  const providerEventId = input.id ?? eventId;
  const result = await database.query<CalendarEventRow>(
    `INSERT INTO calendar_events (
       id, calendar_id, provider_event_id, title, description, location,
       starts_at, ends_at, time_zone, all_day, attendees, status,
       idempotency_key, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'confirmed',$12,now())
     ON CONFLICT (id) DO UPDATE SET
       calendar_id = EXCLUDED.calendar_id,
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       location = EXCLUDED.location,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at,
       time_zone = EXCLUDED.time_zone,
       all_day = EXCLUDED.all_day,
       attendees = EXCLUDED.attendees,
       updated_at = now()
     RETURNING id, provider_event_id, calendar_id, title, description, location,
               starts_at, ends_at, time_zone, all_day, attendees, meeting_url, status,
               provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer`,
    [
      eventId,
      input.calendarId,
      providerEventId,
      input.title,
      input.description ?? null,
      input.location ?? null,
      input.start,
      input.end,
      input.timeZone ?? "Europe/Berlin",
      input.allDay ?? false,
      JSON.stringify(input.attendees ?? []),
      input.idempotencyKey ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "无法保存日程", 500);
  return mapCalendarEvent(row);
}

export async function deleteStoredCalendarEvent(calendarId: string, eventId: string): Promise<boolean> {
  const database = await getDatabase();
  const calendarResult = await database.query<{ read_only: boolean }>(
    "SELECT read_only FROM calendars WHERE id = $1 LIMIT 1",
    [calendarId],
  );
  const calendar = calendarResult.rows[0];
  if (!calendar) throw new CalendarRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
  if (calendar.read_only) throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "该日历当前为只读", 409);
  return database.transaction(async (transaction) => {
    await transaction.query(
      "DELETE FROM entity_links WHERE (source_kind = 'calendar' AND source_id = $1) OR (target_kind = 'calendar' AND target_id = $1)",
      [eventId],
    );
    const result = await transaction.query<{ id: string }>(
      `DELETE FROM calendar_events
        WHERE id = $1 AND calendar_id = $2
        RETURNING id`,
      [eventId, calendarId],
    );
    return Boolean(result.rows[0]);
  });
}

export class CalendarRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "CalendarRepositoryError";
  }
}

function mapCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    providerEventId: row.provider_event_id,
    calendarId: row.calendar_id,
    title: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    start: row.starts_at,
    end: row.ends_at,
    timeZone: row.time_zone,
    allDay: row.all_day,
    attendees: row.attendees ?? [],
    meetingUrl: row.meeting_url ?? undefined,
    status: row.status,
    providerData: {
      providerId: row.id.startsWith("caldav-event:")
        ? "caldav"
        : row.id.startsWith("exchange-event:")
          ? "exchange"
          : "local-calendar",
      itemId: row.provider_item_id ?? undefined,
      changeKey: row.provider_change_key ?? undefined,
      isMeeting: row.is_meeting,
      isRecurring: row.is_recurring,
      isOrganizer: row.is_organizer ?? undefined,
    },
  };
}
