import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";

import type {
  CalendarEvent,
  CalendarRecurrenceEditScope,
  CalendarRecurrenceRule,
  CalendarSummary,
  ListCalendarEventsInput,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import {
  expandCalendarRecurrenceStarts,
  normalizeCalendarRecurrence,
  shiftRecurrenceWeekDays,
} from "../lib/calendar-recurrence";
import {
  decodeNoteContent,
  encodeNoteContent,
  type PlateNoteValue,
} from "../lib/note-content";
import { getDatabase } from "./database";
import { getUserScope } from "./user-scope";

interface CalendarRow {
  id: string;
  account_id: string | null;
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
  description_content: PlateNoteValue | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  all_day: boolean;
  reminder_minutes_before: CalendarEvent["reminderMinutesBefore"] | null;
  attendees: readonly { address: string; name?: string }[];
  meeting_url: string | null;
  status: CalendarEvent["status"];
  availability: NonNullable<CalendarEvent["availability"]>;
  provider_item_id: string | null;
  provider_change_key: string | null;
  is_meeting: boolean;
  is_recurring: boolean;
  is_organizer: boolean | null;
  recurrence_rule: CalendarRecurrenceRule | null;
  recurrence_series_id: string | null;
  recurrence_id: string | null;
  recurrence_cancelled: boolean;
}

export interface CalendarEventConflict {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

const calendarEventColumns = `
  e.id, e.provider_event_id, e.calendar_id, e.title, e.description, e.description_content, e.location,
  e.starts_at, e.ends_at, e.time_zone, e.all_day, e.reminder_minutes_before, e.attendees, e.meeting_url, e.status, e.availability,
  e.provider_item_id, e.provider_change_key, e.is_meeting, e.is_recurring, e.is_organizer,
  e.recurrence_rule, e.recurrence_series_id, e.recurrence_id, e.recurrence_cancelled
`;

export async function listStoredCalendars(): Promise<readonly CalendarSummary[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  if (scope.active) await ensureLocalCalendarForUser(scope.userId!);
  const result = await database.query<CalendarRow>(
    `SELECT c.id, c.account_id, c.provider_id, c.provider_calendar_id,
            COALESCE(a.display_name, c.name) AS name,
            c.color, c.read_only, c.is_primary, c.time_zone
       FROM calendars c
       LEFT JOIN calendar_accounts a ON a.id = c.account_id
      ${scope.active ? "WHERE c.user_id = $1" : ""}
      ORDER BY c.is_primary DESC, c.created_at, COALESCE(a.display_name, c.name)`,
    scope.active ? [scope.userId] : [],
  );
  return result.rows.map((row) => ({
    id: row.id,
    providerCalendarId: row.provider_calendar_id,
    name: row.name,
    color: row.color,
    readOnly: row.read_only,
    primary: row.is_primary,
    providerData: {
      timeZone: row.time_zone,
      providerId: row.provider_id,
      ...(row.account_id ? { accountId: row.account_id } : {}),
    },
  }));
}

export async function listStoredCalendarEvents(
  input: ListCalendarEventsInput,
): Promise<readonly CalendarEvent[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const calendarIds = input.calendarIds?.filter(Boolean) ?? [];
  const limit = Math.max(1, Math.min(input.limit ?? 500, 1000));
  const ordinary = await database.query<CalendarEventRow>(
    `SELECT ${calendarEventColumns}
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
      WHERE e.ends_at > $1 AND e.starts_at < $2
        AND e.recurrence_rule IS NULL
        AND e.recurrence_series_id IS NULL
        AND ($3::text[] IS NULL OR e.calendar_id = ANY($3::text[]))
        ${scope.active ? "AND c.user_id = $5" : ""}
      ORDER BY starts_at, ends_at, title
      LIMIT $4`,
    scope.active ? [input.from, input.to, calendarIds.length ? calendarIds : null, limit, scope.userId] : [input.from, input.to, calendarIds.length ? calendarIds : null, limit],
  );
  if (ordinary.rows.length >= limit) return ordinary.rows.map((row) => mapCalendarEvent(row));

  const masters = await database.query<CalendarEventRow>(
    `SELECT ${calendarEventColumns}
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
      WHERE e.recurrence_rule IS NOT NULL
        AND e.recurrence_series_id IS NULL
        AND e.starts_at < $1
        AND ($2::text[] IS NULL OR e.calendar_id = ANY($2::text[]))
        ${scope.active ? "AND c.user_id = $4" : ""}
      ORDER BY e.starts_at, e.title
      LIMIT $3`,
    scope.active ? [input.to, calendarIds.length ? calendarIds : null, limit, scope.userId] : [input.to, calendarIds.length ? calendarIds : null, limit],
  );
  if (!masters.rows.length) return ordinary.rows.map((row) => mapCalendarEvent(row));

  const masterIds = masters.rows.map((master) => master.id);
  const exceptions = await database.query<CalendarEventRow>(
    `SELECT ${calendarEventColumns}
       FROM calendar_events e
      WHERE e.recurrence_series_id = ANY($1::text[])
      ORDER BY e.recurrence_id`,
    [masterIds],
  );
  const exceptionsByOccurrence = new Map(
    exceptions.rows
      .filter((row) => row.recurrence_series_id && row.recurrence_id)
      .map((row) => [recurrenceKey(row.recurrence_series_id!, row.recurrence_id!), row]),
  );
  const consumedExceptions = new Set<string>();
  const expanded: CalendarEvent[] = ordinary.rows.map((row) => mapCalendarEvent(row));

  for (const master of masters.rows) {
    if (!master.recurrence_rule || expanded.length >= limit) continue;
    const duration = Math.max(1, new Date(master.ends_at).getTime() - new Date(master.starts_at).getTime());
    const starts = expandCalendarRecurrenceStarts({
      start: master.starts_at,
      timeZone: master.time_zone,
      allDay: master.all_day,
      recurrence: master.recurrence_rule,
      from: new Date(new Date(input.from).getTime() - duration).toISOString(),
      to: input.to,
      limit,
    });
    for (const occurrenceStart of starts) {
      const occurrenceEnd = occurrenceEndForMaster(master, occurrenceStart);
      if (occurrenceEnd <= input.from || occurrenceStart >= input.to) continue;
      const key = recurrenceKey(master.id, occurrenceStart);
      const exception = exceptionsByOccurrence.get(key);
      if (exception) {
        consumedExceptions.add(exception.id);
        if (!exception.recurrence_cancelled && exception.ends_at > input.from && exception.starts_at < input.to) {
          expanded.push(mapCalendarEvent(exception, master.recurrence_rule, master.reminder_minutes_before));
        }
      } else {
        expanded.push(mapExpandedCalendarEvent(master, occurrenceStart, occurrenceEnd));
      }
      if (expanded.length >= limit) break;
    }
  }

  for (const exception of exceptions.rows) {
    if (
      expanded.length >= limit
      || consumedExceptions.has(exception.id)
      || exception.recurrence_cancelled
      || exception.ends_at <= input.from
      || exception.starts_at >= input.to
    ) continue;
    const master = masters.rows.find((row) => row.id === exception.recurrence_series_id);
    if (master?.recurrence_rule) expanded.push(mapCalendarEvent(exception, master.recurrence_rule, master.reminder_minutes_before));
  }

  return expanded
    .sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end) || left.title.localeCompare(right.title))
    .slice(0, limit);
}

export async function getStoredCalendarEvent(eventId: string): Promise<CalendarEvent | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<CalendarEventRow>(
    `SELECT ${calendarEventColumns}
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
      WHERE e.id = $1${scope.active ? " AND c.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [eventId, scope.userId] : [eventId],
  );
  return result.rows[0] ? mapCalendarEvent(result.rows[0]) : undefined;
}

export async function listStoredCalendarEventConflicts(input: {
  readonly calendarId: string;
  readonly start: string;
  readonly end: string;
  readonly excludeEventId?: string;
}): Promise<readonly CalendarEventConflict[]> {
  const events = await listStoredCalendarEvents({
    calendarIds: [input.calendarId],
    from: input.start,
    to: input.end,
    limit: 1_000,
  });
  return events
    .filter((event) => event.status !== "cancelled" && event.id !== input.excludeEventId)
    .map((event) => ({ id: event.id, title: event.title, start: event.start, end: event.end }));
}

export async function upsertStoredCalendarEvent(
  input: UpsertCalendarEventInput,
): Promise<CalendarEvent> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const existingCalendar = await database.query<{ read_only: boolean }>(
    `SELECT read_only FROM calendars WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [input.calendarId, scope.userId] : [input.calendarId],
  );
  const calendar = existingCalendar.rows[0];
  if (!calendar) throw new CalendarRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
  if (calendar.read_only) throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "该日历为只读", 409);

  if (input.recurrenceSeriesId && input.recurrenceId) {
    return upsertRecurringOccurrence(input);
  }

  if (input.id) {
    const existingEvent = await database.query<{ id: string; calendar_id: string }>(
      `SELECT e.id, e.calendar_id FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = $1${scope.active ? " AND c.user_id = $2" : ""} LIMIT 1`,
      scope.active ? [input.id, scope.userId] : [input.id],
    );
    const event = existingEvent.rows[0];
    if (!event) throw new CalendarRepositoryError("EVENT_NOT_FOUND", "日程不存在", 404);
    if (event.calendar_id !== input.calendarId) {
      throw new CalendarRepositoryError("EVENT_CALENDAR_MISMATCH", "不能把日程移动到未知日历", 409);
    }
  } else if (input.idempotencyKey) {
    const existingEvent = await database.query<CalendarEventRow>(
      `SELECT ${calendarEventColumns}
         FROM calendar_events e
        WHERE calendar_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [input.calendarId, input.idempotencyKey],
    );
    if (existingEvent.rows[0]) return mapCalendarEvent(existingEvent.rows[0]);
  }

  const eventId = input.id ?? randomUUID();
  const providerEventId = input.id ?? eventId;
  const recurrence = input.recurrence ? normalizeCalendarRecurrence(input.recurrence) : null;
  const result = await database.query<CalendarEventRow>(
    `INSERT INTO calendar_events (
       id, calendar_id, provider_event_id, title, description, description_content, location,
       starts_at, ends_at, time_zone, all_day, attendees, status,
       idempotency_key, recurrence_rule, is_recurring, reminder_minutes_before, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,'confirmed',$13,$14::jsonb,$15,$16,now())
     ON CONFLICT (id) DO UPDATE SET
       calendar_id = EXCLUDED.calendar_id,
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       description_content = EXCLUDED.description_content,
       location = EXCLUDED.location,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at,
       time_zone = EXCLUDED.time_zone,
       all_day = EXCLUDED.all_day,
       attendees = EXCLUDED.attendees,
       recurrence_rule = EXCLUDED.recurrence_rule,
       is_recurring = EXCLUDED.is_recurring,
       reminder_minutes_before = COALESCE(EXCLUDED.reminder_minutes_before, calendar_events.reminder_minutes_before),
       updated_at = now()
     RETURNING id, provider_event_id, calendar_id, title, description, description_content, location,
               starts_at, ends_at, time_zone, all_day, reminder_minutes_before, attendees, meeting_url, status, availability,
               provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer,
               recurrence_rule, recurrence_series_id, recurrence_id, recurrence_cancelled`,
    [
      eventId,
      input.calendarId,
      providerEventId,
      input.title,
      input.description ?? null,
      calendarDescriptionContentJson(input.descriptionContent),
      input.location ?? null,
      input.start,
      input.end,
      input.timeZone ?? "Europe/Berlin",
      input.allDay ?? false,
      JSON.stringify(input.attendees ?? []),
      input.idempotencyKey ?? null,
      recurrence ? JSON.stringify(recurrence) : null,
      Boolean(recurrence),
      input.reminderMinutesBefore ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "无法保存日程", 500);
  if (!recurrence) return mapCalendarEvent(row);
  return mapExpandedCalendarEvent(row, row.starts_at, row.ends_at);
}

async function upsertRecurringOccurrence(input: UpsertCalendarEventInput): Promise<CalendarEvent> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const masterResult = await database.query<CalendarEventRow>(
    `SELECT ${calendarEventColumns}
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
      WHERE e.id = $1 AND e.calendar_id = $2
        AND e.recurrence_rule IS NOT NULL
        ${scope.active ? "AND c.user_id = $3" : ""}
      LIMIT 1`,
    scope.active ? [input.recurrenceSeriesId, input.calendarId, scope.userId] : [input.recurrenceSeriesId, input.calendarId],
  );
  const master = masterResult.rows[0];
  if (!master?.recurrence_rule) throw new CalendarRepositoryError("RECURRENCE_NOT_FOUND", "重复日程系列不存在", 404);
  const recurrenceId = new Date(input.recurrenceId!).toISOString();
  const scopeMode = input.recurrenceScope ?? "occurrence";

  if (scopeMode === "occurrence") {
    const result = await database.query<CalendarEventRow>(
      `INSERT INTO calendar_events (
         id, calendar_id, provider_event_id, title, description, description_content, location,
         starts_at, ends_at, time_zone, all_day, attendees, status,
         is_recurring, recurrence_series_id, recurrence_id, recurrence_cancelled, reminder_minutes_before, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,'confirmed',true,$13,$14,false,$15,now())
       ON CONFLICT (recurrence_series_id, recurrence_id)
         WHERE recurrence_series_id IS NOT NULL AND recurrence_id IS NOT NULL
       DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         description_content = EXCLUDED.description_content,
         location = EXCLUDED.location,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         time_zone = EXCLUDED.time_zone,
         all_day = EXCLUDED.all_day,
         attendees = EXCLUDED.attendees,
         reminder_minutes_before = COALESCE(EXCLUDED.reminder_minutes_before, calendar_events.reminder_minutes_before),
         recurrence_cancelled = false,
         updated_at = now()
       RETURNING id, provider_event_id, calendar_id, title, description, description_content, location,
                 starts_at, ends_at, time_zone, all_day, reminder_minutes_before, attendees, meeting_url, status, availability,
                 provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer,
                 recurrence_rule, recurrence_series_id, recurrence_id, recurrence_cancelled`,
      [
        randomUUID(),
        input.calendarId,
        recurrenceProviderEventId(master.id, recurrenceId),
        input.title,
        input.description ?? null,
        calendarDescriptionContentJson(input.descriptionContent),
        input.location ?? null,
        input.start,
        input.end,
        input.timeZone ?? master.time_zone,
        input.allDay ?? master.all_day,
        JSON.stringify(input.attendees ?? master.attendees ?? []),
        master.id,
        recurrenceId,
        input.reminderMinutesBefore ?? null,
      ],
    );
    const exception = result.rows[0];
    if (!exception) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "无法保存此次日程", 500);
    return mapCalendarEvent(exception, master.recurrence_rule, master.reminder_minutes_before);
  }

  const delta = new Date(input.start).getTime() - new Date(recurrenceId).getTime();
  const duration = new Date(input.end).getTime() - new Date(input.start).getTime();
  const explicitRecurrence = input.recurrence
    ? normalizeCalendarRecurrence(input.recurrence)
    : undefined;
  const dayShift = localWeekdayDelta(recurrenceId, input.start, input.timeZone ?? master.time_zone);
  const nextRule = explicitRecurrence
    ?? shiftRecurrenceWeekDays(master.recurrence_rule, dayShift);

  if (scopeMode === "series") {
    const masterStart = new Date(new Date(master.starts_at).getTime() + delta);
    const masterEnd = new Date(masterStart.getTime() + duration);
    const result = await database.query<CalendarEventRow>(
      `UPDATE calendar_events e SET
         title = $2, description = $3, location = $4,
         starts_at = $5, ends_at = $6, time_zone = $7, all_day = $8,
         attendees = $9::jsonb, recurrence_rule = $10::jsonb,
         description_content = $11::jsonb,
         reminder_minutes_before = COALESCE($12, reminder_minutes_before),
         is_recurring = true, updated_at = now()
       WHERE e.id = $1
       RETURNING id, provider_event_id, calendar_id, title, description, description_content, location,
                 starts_at, ends_at, time_zone, all_day, reminder_minutes_before, attendees, meeting_url, status, availability,
                 provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer,
                 recurrence_rule, recurrence_series_id, recurrence_id, recurrence_cancelled`,
      [
        master.id,
        input.title,
        input.description ?? null,
        input.location ?? null,
        masterStart.toISOString(),
        masterEnd.toISOString(),
        input.timeZone ?? master.time_zone,
        input.allDay ?? master.all_day,
        JSON.stringify(input.attendees ?? master.attendees ?? []),
        JSON.stringify(nextRule),
        calendarDescriptionContentJson(input.descriptionContent),
        input.reminderMinutesBefore ?? null,
      ],
    );
    const updated = result.rows[0];
    if (!updated) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "无法更新重复日程", 500);
    return mapExpandedCalendarEvent(updated, input.start, input.end);
  }

  return database.transaction(async (transaction) => {
    const oldRule: CalendarRecurrenceRule = {
      ...master.recurrence_rule!,
      end: "until",
      until: new Date(new Date(recurrenceId).getTime() - 1).toISOString(),
      count: undefined,
    };
    await transaction.query(
      `UPDATE calendar_events SET recurrence_rule = $2::jsonb, updated_at = now() WHERE id = $1`,
      [master.id, JSON.stringify(oldRule)],
    );
    await transaction.query(
      `DELETE FROM calendar_events
        WHERE recurrence_series_id = $1 AND recurrence_id >= $2`,
      [master.id, recurrenceId],
    );

    let followingRule = nextRule;
    if (master.recurrence_rule!.end === "count" && master.recurrence_rule!.count) {
      const startsThroughOccurrence = expandCalendarRecurrenceStarts({
        start: master.starts_at,
        timeZone: master.time_zone,
        allDay: master.all_day,
        recurrence: master.recurrence_rule!,
        from: master.starts_at,
        to: new Date(new Date(recurrenceId).getTime() + 1).toISOString(),
        limit: 5_000,
      });
      const precedingCount = Math.max(0, startsThroughOccurrence.length - 1);
      followingRule = {
        ...followingRule,
        end: "count",
        count: Math.max(1, master.recurrence_rule!.count - precedingCount),
        until: undefined,
      };
    }

    const newSeriesId = randomUUID();
    const result = await transaction.query<CalendarEventRow>(
      `INSERT INTO calendar_events (
         id, calendar_id, provider_event_id, title, description, location,
         starts_at, ends_at, time_zone, all_day, attendees, status,
         is_recurring, recurrence_rule, description_content, reminder_minutes_before, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'confirmed',true,$12::jsonb,$13::jsonb,$14,now())
       RETURNING id, provider_event_id, calendar_id, title, description, description_content, location,
                 starts_at, ends_at, time_zone, all_day, reminder_minutes_before, attendees, meeting_url, status, availability,
                 provider_item_id, provider_change_key, is_meeting, is_recurring, is_organizer,
                 recurrence_rule, recurrence_series_id, recurrence_id, recurrence_cancelled`,
      [
        newSeriesId,
        input.calendarId,
        newSeriesId,
        input.title,
        input.description ?? null,
        input.location ?? null,
        input.start,
        input.end,
        input.timeZone ?? master.time_zone,
        input.allDay ?? master.all_day,
        JSON.stringify(input.attendees ?? master.attendees ?? []),
        JSON.stringify(followingRule),
        calendarDescriptionContentJson(input.descriptionContent),
        input.reminderMinutesBefore ?? null,
      ],
    );
    const newMaster = result.rows[0];
    if (!newMaster) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "无法拆分重复日程", 500);
    return mapExpandedCalendarEvent(newMaster, input.start, input.end);
  });
}

export interface DeleteStoredCalendarEventOptions {
  readonly recurrenceSeriesId?: string;
  readonly recurrenceId?: string;
  readonly recurrenceScope?: CalendarRecurrenceEditScope;
}

export async function deleteStoredCalendarEvent(
  calendarId: string,
  eventId: string,
  options: DeleteStoredCalendarEventOptions = {},
): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const calendarResult = await database.query<{ read_only: boolean }>(
    `SELECT read_only FROM calendars WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [calendarId, scope.userId] : [calendarId],
  );
  const calendar = calendarResult.rows[0];
  if (!calendar) throw new CalendarRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
  if (calendar.read_only) throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "该日历当前为只读", 409);

  if (options.recurrenceSeriesId && options.recurrenceId) {
    const masterResult = await database.query<CalendarEventRow>(
      `SELECT ${calendarEventColumns}
         FROM calendar_events e
         JOIN calendars c ON c.id = e.calendar_id
        WHERE e.id = $1 AND e.calendar_id = $2
          AND e.recurrence_rule IS NOT NULL
          ${scope.active ? "AND c.user_id = $3" : ""}
        LIMIT 1`,
      scope.active ? [options.recurrenceSeriesId, calendarId, scope.userId] : [options.recurrenceSeriesId, calendarId],
    );
    const master = masterResult.rows[0];
    if (!master?.recurrence_rule) throw new CalendarRepositoryError("RECURRENCE_NOT_FOUND", "重复日程系列不存在", 404);
    const recurrenceId = new Date(options.recurrenceId).toISOString();
    const recurrenceScope = options.recurrenceScope ?? "occurrence";
    if (recurrenceScope === "series") {
      const result = await database.query<{ id: string }>(
        "DELETE FROM calendar_events WHERE id = $1 AND calendar_id = $2 RETURNING id",
        [master.id, calendarId],
      );
      return Boolean(result.rows[0]);
    }
    if (recurrenceScope === "following") {
      const rule: CalendarRecurrenceRule = {
        ...master.recurrence_rule,
        end: "until",
        until: new Date(new Date(recurrenceId).getTime() - 1).toISOString(),
        count: undefined,
      };
      await database.transaction(async (transaction) => {
        await transaction.query(
          "UPDATE calendar_events SET recurrence_rule = $2::jsonb, updated_at = now() WHERE id = $1",
          [master.id, JSON.stringify(rule)],
        );
        await transaction.query(
          "DELETE FROM calendar_events WHERE recurrence_series_id = $1 AND recurrence_id >= $2",
          [master.id, recurrenceId],
        );
      });
      return true;
    }

    const occurrenceEnd = occurrenceEndForMaster(master, recurrenceId);
    await database.query(
      `INSERT INTO calendar_events (
         id, calendar_id, provider_event_id, title, description, location,
         starts_at, ends_at, time_zone, all_day, attendees, status,
         is_recurring, recurrence_series_id, recurrence_id, recurrence_cancelled, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'cancelled',true,$12,$13,true,now())
       ON CONFLICT (recurrence_series_id, recurrence_id)
         WHERE recurrence_series_id IS NOT NULL AND recurrence_id IS NOT NULL
       DO UPDATE SET recurrence_cancelled = true, status = 'cancelled', updated_at = now()`,
      [
        randomUUID(),
        calendarId,
        recurrenceProviderEventId(master.id, recurrenceId),
        master.title,
        master.description,
        master.location,
        recurrenceId,
        occurrenceEnd,
        master.time_zone,
        master.all_day,
        JSON.stringify(master.attendees ?? []),
        master.id,
        recurrenceId,
      ],
    );
    return true;
  }

  return database.transaction(async (transaction) => {
    await transaction.query(
      `DELETE FROM entity_links WHERE ((source_kind = 'calendar' AND source_id = $1) OR (target_kind = 'calendar' AND target_id = $1))${scope.active ? " AND user_id = $2" : ""}`,
      scope.active ? [eventId, scope.userId] : [eventId],
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

async function ensureLocalCalendarForUser(userId: string): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `INSERT INTO calendars (
       id, user_id, provider_id, provider_calendar_id, name, color,
       read_only, is_primary, time_zone
     ) VALUES ($1, $2, 'local-calendar', 'personal', '个人日历', '#86bdf5', false, true, 'Europe/Berlin')
     ON CONFLICT (user_id, provider_id, provider_calendar_id) WHERE user_id IS NOT NULL DO NOTHING`,
    [`local:${userId}:personal`, userId],
  );
}

export class CalendarRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "CalendarRepositoryError";
  }
}

function mapCalendarEvent(
  row: CalendarEventRow,
  inheritedRecurrence?: CalendarRecurrenceRule,
  inheritedReminderMinutes?: CalendarEvent["reminderMinutesBefore"] | null,
): CalendarEvent {
  const recurrence = row.recurrence_rule ?? inheritedRecurrence;
  return {
    id: row.id,
    providerEventId: row.provider_event_id,
    calendarId: row.calendar_id,
    title: row.title,
    description: row.description ?? undefined,
    descriptionContent: row.description_content ? encodeNoteContent(row.description_content) : undefined,
    location: row.location ?? undefined,
    start: row.starts_at,
    end: row.ends_at,
    timeZone: row.time_zone,
    allDay: row.all_day,
    reminderMinutesBefore: row.reminder_minutes_before ?? inheritedReminderMinutes ?? undefined,
    attendees: row.attendees ?? [],
    meetingUrl: row.meeting_url ?? undefined,
    status: row.status,
    availability: row.availability,
    recurrence: recurrence ?? undefined,
    recurrenceSeriesId: row.recurrence_series_id ?? (row.recurrence_rule ? row.id : undefined),
    recurrenceId: row.recurrence_id ?? undefined,
    recurrenceException: Boolean(row.recurrence_series_id),
    providerData: {
      providerId: row.id.startsWith("caldav-event:")
        ? "caldav"
        : row.id.startsWith("exchange-event:")
          ? "exchange"
          : "local-calendar",
      itemId: row.provider_item_id ?? undefined,
      changeKey: row.provider_change_key ?? undefined,
      isMeeting: row.is_meeting,
      isRecurring: row.is_recurring || Boolean(recurrence),
      isOrganizer: row.is_organizer ?? undefined,
    },
  };
}

function mapExpandedCalendarEvent(
  master: CalendarEventRow,
  occurrenceStart: string,
  occurrenceEnd: string,
): CalendarEvent {
  const recurrence = master.recurrence_rule!;
  return {
    ...mapCalendarEvent(master, recurrence),
    id: recurrenceOccurrenceId(master.id, occurrenceStart),
    providerEventId: recurrenceProviderEventId(master.id, occurrenceStart),
    start: occurrenceStart,
    end: occurrenceEnd,
    recurrence,
    recurrenceSeriesId: master.id,
    recurrenceId: occurrenceStart,
    recurrenceException: false,
    providerData: {
      ...mapCalendarEvent(master).providerData,
      providerId: "local-calendar",
      isRecurring: true,
    },
  };
}

function occurrenceEndForMaster(master: CalendarEventRow, occurrenceStart: string): string {
  const masterStart = new Date(master.starts_at);
  const masterEnd = new Date(master.ends_at);
  if (!master.all_day) {
    return new Date(new Date(occurrenceStart).getTime() + masterEnd.getTime() - masterStart.getTime()).toISOString();
  }
  const localStart = TZDate.tz(master.time_zone, masterStart);
  const localEnd = TZDate.tz(master.time_zone, masterEnd);
  const dayCount = Math.max(1, Math.round((
    Date.UTC(localEnd.getFullYear(), localEnd.getMonth(), localEnd.getDate())
    - Date.UTC(localStart.getFullYear(), localStart.getMonth(), localStart.getDate())
  ) / 86_400_000));
  const occurrence = TZDate.tz(master.time_zone, new Date(occurrenceStart));
  return TZDate.tz(
    master.time_zone,
    occurrence.getFullYear(),
    occurrence.getMonth(),
    occurrence.getDate() + dayCount,
    0,
    0,
    0,
    0,
  ).toISOString();
}

function recurrenceOccurrenceId(seriesId: string, recurrenceId: string): string {
  return `recurrence:${seriesId}:${new Date(recurrenceId).getTime()}`;
}

function recurrenceProviderEventId(seriesId: string, recurrenceId: string): string {
  return `${seriesId}#${new Date(recurrenceId).toISOString()}`;
}

function recurrenceKey(seriesId: string, recurrenceId: string): string {
  return `${seriesId}:${new Date(recurrenceId).getTime()}`;
}

function calendarDescriptionContentJson(content?: string): string | null {
  return content ? JSON.stringify(decodeNoteContent(content)) : null;
}

function localWeekdayDelta(from: string, to: string, timeZone: string): number {
  const fromDate = TZDate.tz(timeZone, new Date(from));
  const toDate = TZDate.tz(timeZone, new Date(to));
  const fromDay = fromDate.getDay();
  const toDay = toDate.getDay();
  return toDay - fromDay;
}
