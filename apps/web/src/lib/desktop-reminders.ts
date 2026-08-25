import type { DesktopReminderSettings } from "./desktop-bridge";

export interface CalendarReminderEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly reminderMinutesBefore?: number;
}

export interface NativeReminderInput {
  readonly id: string;
  readonly title: string;
  readonly startAt: number;
  readonly remindAt: number;
  readonly allDay: boolean;
  readonly route: string;
}

export interface DesktopReminderSyncPayload {
  readonly settings: DesktopReminderSettings;
  readonly reminders: readonly NativeReminderInput[];
  readonly summary: {
    readonly todayCount: number;
    readonly nextTitle?: string;
    readonly nextStartAt?: number;
    readonly syncedAt: number;
  };
}

export function desktopReminderRange(now = new Date()): {
  readonly from: Date;
  readonly to: Date;
  readonly tomorrow: Date;
} {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const to = new Date(now);
  to.setDate(to.getDate() + 30);
  return { from, to, tomorrow };
}

export function createDesktopReminderSyncPayload(
  sourceEvents: readonly CalendarReminderEvent[],
  settings: DesktopReminderSettings,
  now = new Date(),
): DesktopReminderSyncPayload {
  const range = desktopReminderRange(now);
  const events = sourceEvents
    .filter((event) => event.status !== "cancelled")
    .filter((event) => isValidEventRange(event));
  const todayEvents = events.filter((event) => {
    const startAt = new Date(event.start).getTime();
    const endAt = new Date(event.end).getTime();
    return startAt < range.tomorrow.getTime() && endAt > range.from.getTime();
  });
  const nextEvent = events
    .filter((event) => new Date(event.end).getTime() > now.getTime())
    .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime())[0];

  return {
    settings,
    reminders: events
      .filter((event) => event.reminderMinutesBefore !== 0)
      .map((event) => toNativeReminder(event, settings)),
    summary: {
      todayCount: todayEvents.length,
      nextTitle: nextEvent?.title,
      nextStartAt: nextEvent ? new Date(nextEvent.start).getTime() : undefined,
      syncedAt: now.getTime(),
    },
  };
}

function isValidEventRange(event: CalendarReminderEvent): boolean {
  const startAt = new Date(event.start).getTime();
  const endAt = new Date(event.end).getTime();
  return Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt;
}

function toNativeReminder(event: CalendarReminderEvent, settings: DesktopReminderSettings): NativeReminderInput {
  const start = new Date(event.start);
  let remindAt: number;
  if (event.reminderMinutesBefore !== undefined) {
    remindAt = start.getTime() - event.reminderMinutesBefore * 60_000;
  } else if (event.allDay) {
    const allDayReminder = new Date(start);
    allDayReminder.setHours(settings.allDayReminderHour, 0, 0, 0);
    remindAt = allDayReminder.getTime();
  } else {
    remindAt = start.getTime() - settings.reminderMinutesBefore * 60_000;
  }
  return {
    id: event.id,
    title: event.title,
    startAt: start.getTime(),
    remindAt,
    allDay: event.allDay,
    route: `/calendar?event=${encodeURIComponent(event.id)}&date=${encodeURIComponent(event.start)}`,
  };
}
