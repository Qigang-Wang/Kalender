import type {
  CalendarEvent,
  CalendarRecurrenceEditScope,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import { normalizeCalendarRecurrence } from "../lib/calendar-recurrence";
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
import { getUserScope } from "./user-scope";

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
  updated_at: string | Date;
}

export async function upsertCalendarEvent(input: UpsertCalendarEventInput): Promise<CalendarEvent> {
  const target = await getCalendarWriteTarget(input.calendarId);
  if (target.provider_id === "local-calendar") {
    return localCalendarProvider.upsertEvent(localCalendarContext, input);
  }
  if (input.recurrence || input.recurrenceSeriesId) {
    throw new CalendarRepositoryError("REMOTE_RECURRENCE_UNSUPPORTED", "当前版本仅支持在个人日历中创建和修改重复日程", 409);
  }
  if (target.provider_id !== "exchange" || !target.account_id) {
    throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "这个远程日历暂不支持写回", 409);
  }

  const credential = await loadExchangeCalendarCredential(target.account_id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    let remoteEvent;
    if (input.id) {
      const existing = await getExchangeEventTarget(input.id, input.calendarId);
      assertExchangeRevision(existing, input.expectedUpdatedAt);
      assertSafeExchangeMutation(existing);
      remoteEvent = await updateExchangeCalendarEvent(credential, {
        itemId: existing.provider_item_id!,
        changeKey: existing.provider_change_key ?? undefined,
      }, { ...input, availability: input.availability ?? existing.availability }, controller.signal);
    } else {
      const folderId = target.provider_calendar_id.startsWith(`${target.account_id}:`)
        ? target.provider_calendar_id.slice(target.account_id.length + 1)
        : target.provider_calendar_id;
      const folder: ExchangeCalendarFolder = { folderId, name: "Exchange 日历" };
      remoteEvent = await createExchangeCalendarEvent(credential, folder, input, controller.signal);
    }
    const eventId = await saveExchangeCalendarMutation(
      input.calendarId,
      remoteEvent,
      input.id,
      input.descriptionContent,
      input.reminderMinutesBefore,
      input.expectedUpdatedAt,
    );
    const saved = await getStoredCalendarEvent(eventId);
    if (!saved) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "RWTH 已保存日程，但本地索引更新失败", 500);
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
  expectedUpdatedAt?: string,
): Promise<void> {
  const target = await getCalendarWriteTarget(calendarId);
  if (target.provider_id === "local-calendar") {
    await deleteStoredCalendarEvent(calendarId, eventId, {
      ...(recurrence ? {
        recurrenceSeriesId: recurrence.seriesId,
        recurrenceId: recurrence.recurrenceId,
        recurrenceScope: recurrence.scope,
      } : {}),
      expectedUpdatedAt,
    });
    return;
  }
  if (target.provider_id !== "exchange" || !target.account_id) {
    throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "这个远程日历暂不支持删除", 409);
  }
  const existing = await getExchangeEventTarget(eventId, calendarId);
  assertExchangeRevision(existing, expectedUpdatedAt);
  assertSafeExchangeMutation(existing);
  const credential = await loadExchangeCalendarCredential(target.account_id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    await deleteExchangeCalendarEvent(credential, {
      itemId: existing.provider_item_id!,
      changeKey: existing.provider_change_key ?? undefined,
    }, controller.signal);
    await deleteStoredCalendarEvent(calendarId, eventId, { expectedUpdatedAt });
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateCalendarEventUpsert(input: UpsertCalendarEventInput): Promise<void> {
  const target = await getCalendarWriteTarget(input.calendarId);
  if (target.provider_id === "local-calendar") {
    if (input.recurrence) normalizeCalendarRecurrence(input.recurrence);
    await validateLocalCalendarEvent(input.calendarId, input.id, input.recurrenceSeriesId);
    return;
  }
  if (input.recurrence || input.recurrenceSeriesId) {
    throw new CalendarRepositoryError("REMOTE_RECURRENCE_UNSUPPORTED", "当前版本仅支持在个人日历中创建和修改重复日程", 409);
  }
  if (target.provider_id !== "exchange" || !target.account_id) {
    throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "这个远程日历暂不支持写回", 409);
  }
  if (input.id) {
    const existing = await getExchangeEventTarget(input.id, input.calendarId);
    assertSafeExchangeMutation(existing);
  }
  await loadExchangeCalendarCredential(target.account_id);
}

export async function validateCalendarEventDelete(calendarId: string, eventId: string): Promise<void> {
  const target = await getCalendarWriteTarget(calendarId);
  if (target.provider_id === "local-calendar") {
    await validateLocalCalendarEvent(calendarId, eventId);
    return;
  }
  if (target.provider_id !== "exchange" || !target.account_id) {
    throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "这个远程日历暂不支持删除", 409);
  }
  const existing = await getExchangeEventTarget(eventId, calendarId);
  assertSafeExchangeMutation(existing);
  await loadExchangeCalendarCredential(target.account_id);
}

async function getCalendarWriteTarget(calendarId: string): Promise<CalendarWriteTargetRow> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<CalendarWriteTargetRow>(
    `SELECT provider_id, provider_calendar_id, account_id, read_only
       FROM calendars WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [calendarId, scope.userId] : [calendarId],
  );
  const target = result.rows[0];
  if (!target) throw new CalendarRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
  if (target.read_only) throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "这个日历当前为只读", 409);
  return target;
}

async function getExchangeEventTarget(eventId: string, calendarId: string): Promise<ExchangeEventTargetRow> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<ExchangeEventTargetRow>(
    `SELECT e.provider_item_id, e.provider_change_key, e.is_meeting, e.is_recurring, e.availability, e.updated_at
       FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
      WHERE e.id = $1 AND e.calendar_id = $2${scope.active ? " AND c.user_id = $3" : ""}
      LIMIT 1`,
    scope.active ? [eventId, calendarId, scope.userId] : [eventId, calendarId],
  );
  const event = result.rows[0];
  if (!event) throw new CalendarRepositoryError("EVENT_NOT_FOUND", "日程不存在", 404);
  return event;
}

async function validateLocalCalendarEvent(calendarId: string, eventId?: string, recurrenceSeriesId?: string): Promise<void> {
  if (!eventId && !recurrenceSeriesId) return;
  const database = await getDatabase();
  const scope = await getUserScope();
  const id = recurrenceSeriesId ?? eventId!;
  const result = await database.query<{ calendar_id: string; recurrence_rule: unknown }>(
    `SELECT e.calendar_id, e.recurrence_rule
       FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
      WHERE e.id = $1${scope.active ? " AND c.user_id = $2" : ""} LIMIT 1`,
    scope.active ? [id, scope.userId] : [id],
  );
  const event = result.rows[0];
  if (!event) throw new CalendarRepositoryError(recurrenceSeriesId ? "RECURRENCE_NOT_FOUND" : "EVENT_NOT_FOUND", recurrenceSeriesId ? "重复日程系列不存在" : "日程不存在", 404);
  if (event.calendar_id !== calendarId) throw new CalendarRepositoryError("EVENT_CALENDAR_MISMATCH", "不能把日程移动到未知日历", 409);
  if (recurrenceSeriesId && !event.recurrence_rule) throw new CalendarRepositoryError("RECURRENCE_NOT_FOUND", "重复日程系列不存在", 404);
}

function assertExchangeRevision(event: ExchangeEventTargetRow, expectedUpdatedAt: string | undefined): void {
  const current = event.updated_at instanceof Date ? event.updated_at.toISOString() : new Date(event.updated_at).toISOString();
  if (!expectedUpdatedAt || current !== expectedUpdatedAt) {
    throw new CalendarRepositoryError("VERSION_CONFLICT", "日程已被更新，请读取最新版本后重试", 409);
  }
}

function assertSafeExchangeMutation(event: ExchangeEventTargetRow): void {
  if (!event.provider_item_id) {
    throw new CalendarRepositoryError("REMOTE_ID_MISSING", "请先立即同步 RWTH 日历，再尝试修改", 409);
  }
  if (event.is_recurring) {
    throw new CalendarRepositoryError("RECURRING_EVENT_PROTECTED", "当前版本暂不修改重复日程，请在 RWTH 网页端处理", 409);
  }
  if (event.is_meeting) {
    throw new CalendarRepositoryError("MEETING_EVENT_PROTECTED", "当前版本暂不修改含参会人的会议，避免误发会议通知", 409);
  }
}
