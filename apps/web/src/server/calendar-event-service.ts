import type {
  CalendarEvent,
  CalendarRecurrenceEditScope,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import { normalizeCalendarRecurrence } from "../lib/calendar-recurrence";
import {
  loadCalDavCredential,
  loadExchangeCalendarCredential,
  saveCalDavCalendarMutation,
  saveExchangeCalendarMutation,
} from "./calendar-account-repository";
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
  respondToExchangeMeeting,
  getExchangeAvailability,
  type ExchangeCalendarFolder,
} from "./exchange-calendar";
import { createCalDavEvent, deleteCalDavEvent, updateCalDavEvent } from "./caldav-client";
import { localCalendarContext, localCalendarProvider } from "./local-calendar-provider";
import { getUserScope } from "./user-scope";

interface CalendarWriteTargetRow {
  provider_id: string;
  provider_calendar_id: string;
  account_id: string | null;
  read_only: boolean;
  source_url: string | null;
}

interface CalDavEventTargetRow {
  provider_event_id: string;
  etag: string | null;
  updated_at: string | Date;
}

interface ExchangeEventTargetRow {
  provider_item_id: string | null;
  provider_change_key: string | null;
  is_meeting: boolean;
  is_recurring: boolean;
  is_organizer: boolean | null;
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
  if (target.provider_id === "caldav" && target.account_id && target.source_url) {
    const credential = await loadCalDavCredential(target.account_id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const existing = input.id ? await getCalDavEventTarget(input.id, input.calendarId) : undefined;
      if (existing) assertRemoteRevision(existing.updated_at, input.expectedUpdatedAt);
      const remoteEvent = existing
        ? await updateCalDavEvent(
          credential,
          calDavSourceUrl(existing.provider_event_id),
          existing.etag ?? undefined,
          { ...input, calendarId: target.source_url },
          controller.signal,
          calDavUid(existing.provider_event_id),
        )
        : await createCalDavEvent(credential, target.source_url, { ...input, calendarId: target.source_url }, controller.signal);
      const eventId = await saveCalDavCalendarMutation(
        input.calendarId,
        remoteEvent,
        input.id,
        input.descriptionContent,
        input.reminderMinutesBefore,
        input.expectedUpdatedAt,
      );
      const saved = await getStoredCalendarEvent(eventId);
      if (!saved) throw new CalendarRepositoryError("EVENT_SAVE_FAILED", "CalDAV 已保存日程，但本地索引更新失败", 500);
      return saved;
    } finally {
      clearTimeout(timeout);
    }
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
      if ((existing.is_meeting || input.attendees?.length) && !input.sendInvitations) throw new CalendarRepositoryError("MEETING_NOTIFICATION_REQUIRED", "请确认向参与者发送会议更新", 409);
      remoteEvent = await updateExchangeCalendarEvent(credential, {
        itemId: existing.provider_item_id!,
        changeKey: existing.provider_change_key ?? undefined,
      }, { ...input, availability: input.availability ?? existing.availability }, controller.signal);
    } else {
      if (input.attendees?.length && !input.sendInvitations) throw new CalendarRepositoryError("MEETING_NOTIFICATION_REQUIRED", "请确认发送会议邀请", 409);
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
  if (target.provider_id === "caldav" && target.account_id) {
    const existing = await getCalDavEventTarget(eventId, calendarId);
    assertRemoteRevision(existing.updated_at, expectedUpdatedAt);
    const credential = await loadCalDavCredential(target.account_id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      await deleteCalDavEvent(credential, calDavSourceUrl(existing.provider_event_id), existing.etag ?? undefined, controller.signal);
      await deleteStoredCalendarEvent(calendarId, eventId, { expectedUpdatedAt });
    } finally {
      clearTimeout(timeout);
    }
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
    const identity = {
      itemId: existing.provider_item_id!,
      changeKey: existing.provider_change_key ?? undefined,
    };
    if (existing.is_meeting) await respondToExchangeMeeting(credential, identity, "cancel");
    else await deleteExchangeCalendarEvent(credential, identity, controller.signal);
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
  if (target.provider_id === "caldav" && target.account_id) {
    if (input.id) await getCalDavEventTarget(input.id, input.calendarId);
    await loadCalDavCredential(target.account_id);
    return;
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
  if (target.provider_id === "caldav" && target.account_id) {
    await getCalDavEventTarget(eventId, calendarId);
    await loadCalDavCredential(target.account_id);
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
    `SELECT provider_id, provider_calendar_id, account_id, read_only, source_url
       FROM calendars WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [calendarId, scope.userId] : [calendarId],
  );
  const target = result.rows[0];
  if (!target) throw new CalendarRepositoryError("CALENDAR_NOT_FOUND", "日历不存在", 404);
  if (target.read_only) throw new CalendarRepositoryError("CALENDAR_READ_ONLY", "这个日历当前为只读", 409);
  return target;
}

async function getCalDavEventTarget(eventId: string, calendarId: string): Promise<CalDavEventTargetRow> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<CalDavEventTargetRow>(
    `SELECT e.provider_event_id, e.etag, e.updated_at
       FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
      WHERE e.id = $1 AND e.calendar_id = $2${scope.active ? " AND c.user_id = $3" : ""}
      LIMIT 1`,
    scope.active ? [eventId, calendarId, scope.userId] : [eventId, calendarId],
  );
  const event = result.rows[0];
  if (!event) throw new CalendarRepositoryError("EVENT_NOT_FOUND", "日程不存在", 404);
  return event;
}

async function getExchangeEventTarget(eventId: string, calendarId: string): Promise<ExchangeEventTargetRow> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<ExchangeEventTargetRow>(
    `SELECT e.provider_item_id, e.provider_change_key, e.is_meeting, e.is_recurring, e.is_organizer, e.availability, e.updated_at
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
  assertRemoteRevision(event.updated_at, expectedUpdatedAt);
}

function assertRemoteRevision(updatedAt: string | Date, expectedUpdatedAt: string | undefined): void {
  const current = updatedAt instanceof Date ? updatedAt.toISOString() : new Date(updatedAt).toISOString();
  if (!expectedUpdatedAt || current !== expectedUpdatedAt) {
    throw new CalendarRepositoryError("VERSION_CONFLICT", "日程已被更新，请读取最新版本后重试", 409);
  }
}

function calDavSourceUrl(providerEventId: string): string {
  const sourceUrl = providerEventId.split("#")[0];
  if (!sourceUrl) throw new CalendarRepositoryError("REMOTE_ID_MISSING", "CalDAV 日程缺少远端地址，请先同步", 409);
  return sourceUrl;
}

function calDavUid(providerEventId: string): string {
  return providerEventId.split("#")[1]?.split(":")[0] || calDavSourceUrl(providerEventId).split("/").pop()?.replace(/\.ics$/i, "") || crypto.randomUUID();
}

function assertSafeExchangeMutation(event: ExchangeEventTargetRow): void {
  if (!event.provider_item_id) {
    throw new CalendarRepositoryError("REMOTE_ID_MISSING", "请先立即同步 RWTH 日历，再尝试修改", 409);
  }
  if (event.is_recurring) {
    throw new CalendarRepositoryError("RECURRING_EVENT_PROTECTED", "当前版本暂不修改重复日程，请在 RWTH 网页端处理", 409);
  }
  if (event.is_meeting && event.is_organizer !== true) {
    throw new CalendarRepositoryError("MEETING_EVENT_PROTECTED", "只有组织者可以修改或取消会议；你可以回复邀请", 409);
  }
}

export async function respondToCalendarMeeting(calendarId: string, eventId: string, response: "accept" | "tentative" | "decline", expectedUpdatedAt?: string, comment?: string) {
  const calendar = await getCalendarWriteTarget(calendarId);
  if (calendar.provider_id !== "exchange" || !calendar.account_id) throw new CalendarRepositoryError("NOT_EXCHANGE", "仅支持 Exchange 会议", 400);
  const event = await getExchangeEventTarget(eventId, calendarId);
  assertExchangeRevision(event, expectedUpdatedAt);
  if (!event.is_meeting || event.is_organizer !== false || !event.provider_item_id) throw new CalendarRepositoryError("MEETING_RESPONSE_UNAVAILABLE", "这个事件不能回复会议邀请", 409);
  const credential = await loadExchangeCalendarCredential(calendar.account_id);
  await respondToExchangeMeeting(credential, { itemId: event.provider_item_id, changeKey: event.provider_change_key ?? undefined }, response, comment);
  const database = await getDatabase();
  // The provider changes item identities on responses; the next sync reconciles them.
  await database.query(`UPDATE calendar_events SET exchange_metadata = exchange_metadata || $2::jsonb, status = $3, updated_at = clock_timestamp() WHERE id = $1`, [eventId, JSON.stringify({ myResponseType: { accept: "Accept", tentative: "Tentative", decline: "Decline" }[response] }), response === "decline" ? "cancelled" : response === "tentative" ? "tentative" : "confirmed"]);
  return getStoredCalendarEvent(eventId);
}

export async function calendarParticipantAvailability(calendarId: string, addresses: readonly string[], start: string, end: string) {
  const calendar = await getCalendarWriteTarget(calendarId);
  if (calendar.provider_id !== "exchange" || !calendar.account_id) throw new CalendarRepositoryError("NOT_EXCHANGE", "请选择 Exchange 日历", 400);
  return getExchangeAvailability(await loadExchangeCalendarCredential(calendar.account_id), addresses, start, end);
}
