import { CalendarSyncAlreadyRunningError, isCalendarAccountSyncing, syncCalDavAccount } from "./caldav-sync";
import { listCalendarAccounts } from "./calendar-account-repository";
import { getWorkspaceSyncSettings, type WorkspaceSyncSettings } from "./sync-settings";

declare global {
  var kalenderCalendarSyncTimer: ReturnType<typeof setInterval> | undefined;
  var kalenderCalendarSyncInitialTimer: ReturnType<typeof setTimeout> | undefined;
  var kalenderCalendarSyncTickRunning: boolean | undefined;
  var kalenderCalendarSyncStopping: boolean | undefined;
  var kalenderCalendarSyncEnabled: boolean | undefined;
  var kalenderCalendarSyncIntervalMs: number | undefined;
  var kalenderCalendarSyncBackoff: Map<string, { failures: number; nextAttemptAt: number }> | undefined;
}

export interface CalendarSyncSchedulerState {
  readonly enabled: boolean;
  readonly intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;
const MINIMUM_ENVIRONMENT_INTERVAL_MS = 30 * 1000;
const MAXIMUM_BACKOFF_MS = 60 * 60 * 1000;

export async function ensureCalendarSyncScheduler(
  settingsInput?: WorkspaceSyncSettings,
): Promise<CalendarSyncSchedulerState> {
  const settings = settingsInput ?? await getWorkspaceSyncSettings();
  const intervalMs = settings.calendarSyncIntervalMs;
  const wasEnabled = globalThis.kalenderCalendarSyncEnabled === true;
  globalThis.kalenderCalendarSyncStopping = false;
  globalThis.kalenderCalendarSyncEnabled = settings.calendarSyncEnabled;

  if (!settings.calendarSyncEnabled) {
    clearCalendarSyncTimers();
    globalThis.kalenderCalendarSyncIntervalMs = intervalMs;
    return { enabled: false, intervalMs };
  }

  if (!globalThis.kalenderCalendarSyncTimer || globalThis.kalenderCalendarSyncIntervalMs !== intervalMs) {
    if (globalThis.kalenderCalendarSyncTimer) clearInterval(globalThis.kalenderCalendarSyncTimer);
    const timer = setInterval(() => void runScheduledCalendarSync(), intervalMs);
    timer.unref();
    globalThis.kalenderCalendarSyncTimer = timer;
  }
  globalThis.kalenderCalendarSyncIntervalMs = intervalMs;
  if (!wasEnabled && !globalThis.kalenderCalendarSyncInitialTimer) {
    const initialTimer = setTimeout(() => void runScheduledCalendarSync(), 10_000);
    initialTimer.unref();
    globalThis.kalenderCalendarSyncInitialTimer = initialTimer;
  }
  return { enabled: true, intervalMs };
}

export async function stopCalendarSyncScheduler(): Promise<void> {
  globalThis.kalenderCalendarSyncStopping = true;
  clearCalendarSyncTimers();
  globalThis.kalenderCalendarSyncEnabled = false;
  globalThis.kalenderCalendarSyncIntervalMs = undefined;
  const deadline = Date.now() + 60_000;
  while (globalThis.kalenderCalendarSyncTickRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (globalThis.kalenderCalendarSyncTickRunning) {
    throw new Error("日历同步仍在运行，请稍后再恢复备份");
  }
  globalThis.kalenderCalendarSyncBackoff?.clear();
  globalThis.kalenderCalendarSyncStopping = false;
}

export async function runScheduledCalendarSync(): Promise<void> {
  if (!globalThis.kalenderCalendarSyncEnabled || globalThis.kalenderCalendarSyncTickRunning) return;
  globalThis.kalenderCalendarSyncTickRunning = true;
  const backoff = globalThis.kalenderCalendarSyncBackoff ??= new Map();
  try {
    const now = Date.now();
    const accounts = await listCalendarAccounts();
    for (const account of accounts) {
      if (globalThis.kalenderCalendarSyncStopping) break;
      if (!account.calendarEnabled || account.syncStatus === "paused" || isCalendarAccountSyncing(account.id)) continue;
      const retry = backoff.get(account.id);
      if (retry && retry.nextAttemptAt > now) continue;
      try {
        await syncCalDavAccount(account.id);
        backoff.delete(account.id);
      } catch (error) {
        if (error instanceof CalendarSyncAlreadyRunningError) continue;
        const failures = (retry?.failures ?? 0) + 1;
        const delay = Math.min(currentCalendarSchedulerInterval() * 2 ** Math.min(failures - 1, 5), MAXIMUM_BACKOFF_MS);
        backoff.set(account.id, { failures, nextAttemptAt: Date.now() + delay });
      }
    }
  } finally {
    globalThis.kalenderCalendarSyncTickRunning = false;
  }
}

export function calendarSchedulerInterval(): number {
  const configured = Number(process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(MINIMUM_ENVIRONMENT_INTERVAL_MS, configured)
    : DEFAULT_INTERVAL_MS;
}

function currentCalendarSchedulerInterval(): number {
  return globalThis.kalenderCalendarSyncIntervalMs ?? calendarSchedulerInterval();
}

function clearCalendarSyncTimers(): void {
  if (globalThis.kalenderCalendarSyncTimer) clearInterval(globalThis.kalenderCalendarSyncTimer);
  if (globalThis.kalenderCalendarSyncInitialTimer) clearTimeout(globalThis.kalenderCalendarSyncInitialTimer);
  globalThis.kalenderCalendarSyncTimer = undefined;
  globalThis.kalenderCalendarSyncInitialTimer = undefined;
}
