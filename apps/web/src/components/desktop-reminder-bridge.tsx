"use client";

import { useCallback, useEffect } from "react";

import { useRealtimeRefresh } from "@/components/realtime-context";
import {
  DESKTOP_SETTINGS_CHANGED_EVENT,
  DESKTOP_SYNC_REQUESTED_EVENT,
  invokeDesktop,
  isDesktopApp,
  readDesktopReminderSettings,
  type DesktopReminderSettings,
} from "@/lib/desktop-bridge";

interface CalendarReminderEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
}
interface NativeReminderInput {
  readonly id: string;
  readonly title: string;
  readonly startAt: number;
  readonly remindAt: number;
  readonly allDay: boolean;
  readonly route: string;
}

export function DesktopReminderBridge() {
  const synchronize = useCallback(async () => {
    if (!isDesktopApp()) return;
    const settings = readDesktopReminderSettings();
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const rangeEnd = new Date(now);
    rangeEnd.setDate(rangeEnd.getDate() + 30);

    const params = new URLSearchParams({ from: todayStart.toISOString(), to: rangeEnd.toISOString() });
    const response = await fetch(`/api/calendar-events?${params}`, { cache: "no-store" });
    const payload = await response.json() as { readonly events?: readonly CalendarReminderEvent[]; readonly message?: string };
    if (!response.ok || !payload.events) throw new Error(payload.message || "无法读取桌面提醒日程");

    const events = payload.events
      .filter((event) => event.status !== "cancelled")
      .filter((event) => Number.isFinite(new Date(event.start).getTime()));
    const reminders = events.map((event) => toNativeReminder(event, settings));
    const todayEvents = events.filter((event) => {
      const startAt = new Date(event.start).getTime();
      const endAt = new Date(event.end).getTime();
      return startAt < tomorrowStart.getTime() && endAt > todayStart.getTime();
    });
    const nextEvent = events
      .filter((event) => new Date(event.end).getTime() > now.getTime())
      .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime())[0];

    await invokeDesktop("sync_reminders", {
      payload: {
        settings,
        reminders,
        summary: {
          todayCount: todayEvents.length,
          nextTitle: nextEvent?.title,
          nextStartAt: nextEvent ? new Date(nextEvent.start).getTime() : undefined,
          syncedAt: Date.now(),
        },
      },
    });
  }, []);

  useRealtimeRefresh(["calendar"], synchronize);

  useEffect(() => {
    if (!isDesktopApp()) return;
    const run = () => { void synchronize().catch((error) => console.warn("Desktop reminder sync failed", error)); };
    run();
    window.addEventListener(DESKTOP_SYNC_REQUESTED_EVENT, run);
    window.addEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, run);
    window.addEventListener("online", run);
    const timer = window.setInterval(run, 15 * 60 * 1000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(DESKTOP_SYNC_REQUESTED_EVENT, run);
      window.removeEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, run);
      window.removeEventListener("online", run);
    };
  }, [synchronize]);

  return null;
}

function toNativeReminder(event: CalendarReminderEvent, settings: DesktopReminderSettings): NativeReminderInput {
  const start = new Date(event.start);
  let remindAt: number;
  if (event.allDay) {
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
