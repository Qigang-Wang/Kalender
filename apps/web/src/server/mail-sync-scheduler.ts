import { isMailAccountSyncing, MailSyncAlreadyRunningError } from "./imap-sync";
import { runMailSync } from "./mail-sync";
import { cleanupMailBodyCache, listAccounts } from "./mail-repository";

declare global {
  var kalenderMailSyncTimer: ReturnType<typeof setInterval> | undefined;
  var kalenderMailSyncInitialTimer: ReturnType<typeof setTimeout> | undefined;
  var kalenderMailSyncTickRunning: boolean | undefined;
  var kalenderMailSyncBackoff: Map<string, { failures: number; nextAttemptAt: number }> | undefined;
  var kalenderMailBodyMaintenanceAt: number | undefined;
}

export interface MailSyncSchedulerState {
  readonly enabled: true;
  readonly intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;
const MINIMUM_INTERVAL_MS = 30 * 1000;
const MAXIMUM_BACKOFF_MS = 60 * 60 * 1000;
const BODY_CACHE_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function ensureMailSyncScheduler(): MailSyncSchedulerState {
  const intervalMs = schedulerInterval();
  if (!globalThis.kalenderMailSyncTimer) {
    const timer = setInterval(() => void runScheduledMailSync(), intervalMs);
    timer.unref();
    globalThis.kalenderMailSyncTimer = timer;
  }
  if (!globalThis.kalenderMailSyncInitialTimer) {
    const initialTimer = setTimeout(() => void runScheduledMailSync(), 10_000);
    initialTimer.unref();
    globalThis.kalenderMailSyncInitialTimer = initialTimer;
  }
  return { enabled: true, intervalMs };
}

export async function stopMailSyncScheduler(): Promise<void> {
  if (globalThis.kalenderMailSyncTimer) clearInterval(globalThis.kalenderMailSyncTimer);
  if (globalThis.kalenderMailSyncInitialTimer) clearTimeout(globalThis.kalenderMailSyncInitialTimer);
  globalThis.kalenderMailSyncTimer = undefined;
  globalThis.kalenderMailSyncInitialTimer = undefined;
  const deadline = Date.now() + 15_000;
  while (globalThis.kalenderMailSyncTickRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (globalThis.kalenderMailSyncTickRunning) throw new Error("邮件同步仍在运行，请稍后再恢复备份");
  globalThis.kalenderMailSyncBackoff?.clear();
  globalThis.kalenderMailBodyMaintenanceAt = undefined;
}

export async function runScheduledMailSync(): Promise<void> {
  if (globalThis.kalenderMailSyncTickRunning) return;
  globalThis.kalenderMailSyncTickRunning = true;
  const backoff = globalThis.kalenderMailSyncBackoff ??= new Map();
  try {
    const now = Date.now();
    const accounts = await listAccounts();
    for (const account of accounts) {
      if (account.syncStatus === "paused" || isMailAccountSyncing(account.id)) continue;
      const retry = backoff.get(account.id);
      if (retry && retry.nextAttemptAt > now) continue;
      try {
        await runMailSync(account.id, 100);
        backoff.delete(account.id);
      } catch (error) {
        if (error instanceof MailSyncAlreadyRunningError) continue;
        const failures = (retry?.failures ?? 0) + 1;
        const delay = Math.min(schedulerInterval() * 2 ** Math.min(failures - 1, 5), MAXIMUM_BACKOFF_MS);
        backoff.set(account.id, { failures, nextAttemptAt: Date.now() + delay });
      }
    }
    if (!globalThis.kalenderMailBodyMaintenanceAt || globalThis.kalenderMailBodyMaintenanceAt <= now) {
      try {
        await cleanupMailBodyCache();
      } catch {
        // Cache maintenance must never block account synchronization.
      } finally {
        globalThis.kalenderMailBodyMaintenanceAt = Date.now() + BODY_CACHE_MAINTENANCE_INTERVAL_MS;
      }
    }
  } finally {
    globalThis.kalenderMailSyncTickRunning = false;
  }
}

function schedulerInterval(): number {
  const configured = Number(process.env.KALENDER_SYNC_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(MINIMUM_INTERVAL_MS, configured)
    : DEFAULT_INTERVAL_MS;
}
