"use client";

import { useCallback, useEffect } from "react";

import { useRealtimeRefresh } from "@/components/realtime-context";
import {
  DESKTOP_SETTINGS_CHANGED_EVENT,
  DESKTOP_SYNC_REQUESTED_EVENT,
  invokeDesktop,
  isDesktopApp,
  publishDesktopStatus,
  readDesktopReminderSettings,
  waitForDesktopApp,
  type DesktopStatus,
} from "@/lib/desktop-bridge";
import { createDesktopReminderSyncPayload, desktopReminderRange, type CalendarReminderEvent } from "@/lib/desktop-reminders";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";

const REGULAR_SYNC_INTERVAL_MS = 15 * 60 * 1_000;
const FAILED_SYNC_RETRY_MS = 30_000;

export function DesktopReminderBridge() {
  const synchronize = useCallback(async () => {
    if (!isDesktopApp()) throw new Error("Desktop-Brücke noch nicht fertig");
    const settings = readDesktopReminderSettings();
    const now = new Date();
    const range = desktopReminderRange(now);
    const params = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() });
    const response = await workspaceFetch(`/api/calendar-events?${params}`, {}, 0);
    const payload = await response.json() as { readonly ok?: boolean; readonly events?: readonly CalendarReminderEvent[]; readonly message?: string };
    if (!response.ok || payload.ok !== true || !payload.events) throw new Error(payload.message || "Termine für Desktop-Erinnerungen konnten nicht geladen werden");

    const status = await invokeDesktop<DesktopStatus>("sync_reminders", {
      payload: createDesktopReminderSyncPayload(payload.events, settings, now),
    });
    publishDesktopStatus(status);
  }, []);

  useRealtimeRefresh(["calendar"], synchronize);

  useEffect(() => {
    let disposed = false;
    let running = false;
    let retryTimer: number | undefined;
    let regularTimer: number | undefined;

    const clearRetry = () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const scheduleRetry = () => {
      clearRetry();
      retryTimer = window.setTimeout(run, FAILED_SYNC_RETRY_MS);
    };
    const reportFailure = async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Desktop-Kalender-Synchronisation fehlgeschlagen";
      console.warn("Desktop reminder sync failed", error);
      try {
        const status = await invokeDesktop<DesktopStatus>("report_sync_error", { message });
        publishDesktopStatus(status);
      } catch {
        // The retry below also covers a bridge that is temporarily unavailable.
      }
    };
    const run = () => {
      if (disposed || running) return;
      running = true;
      void synchronize()
        .then(clearRetry)
        .catch(async (error) => {
          await reportFailure(error);
          if (!disposed) scheduleRetry();
        })
        .finally(() => { running = false; });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") run();
    };
    const initialize = async () => {
      if (!await waitForDesktopApp() || disposed) return;
      window.addEventListener(DESKTOP_SYNC_REQUESTED_EVENT, run);
      window.addEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, run);
      window.addEventListener("online", run);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      regularTimer = window.setInterval(run, REGULAR_SYNC_INTERVAL_MS);
      run();
    };
    void initialize();
    return () => {
      disposed = true;
      clearRetry();
      if (regularTimer !== undefined) window.clearInterval(regularTimer);
      window.removeEventListener(DESKTOP_SYNC_REQUESTED_EVENT, run);
      window.removeEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, run);
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [synchronize]);

  return null;
}
