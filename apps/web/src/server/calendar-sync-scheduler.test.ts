import {
  calendarSchedulerInterval,
  ensureCalendarSyncScheduler,
  stopCalendarSyncScheduler,
} from "./calendar-sync-scheduler";
import {
  defaultWorkspaceSyncSettings,
  SyncSettingsError,
  validateWorkspaceSyncSettings,
} from "./sync-settings";

const originalInterval = process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS;

void run();

async function run() {
  try {
    delete process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS;
    assert(calendarSchedulerInterval() === 180_000, "日历同步默认间隔应为 3 分钟");

    process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS = "1000";
    assert(calendarSchedulerInterval() === 30_000, "日历同步间隔不得低于 30 秒");

    process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS = "45000";
    const scheduler = await ensureCalendarSyncScheduler({
      ...defaultWorkspaceSyncSettings(),
      calendarSyncIntervalMs: 60_000,
    });
    assert(scheduler.enabled && scheduler.intervalMs === 60_000, "日历同步调度器应采用保存的工作区间隔");
    const disabled = await ensureCalendarSyncScheduler({
      ...defaultWorkspaceSyncSettings(),
      calendarSyncEnabled: false,
      calendarSyncIntervalMs: 5 * 60_000,
    });
    assert(!disabled.enabled && disabled.intervalMs === 5 * 60_000, "关闭日历同步后应清除后台定时器");
    const valid = validateWorkspaceSyncSettings({
      mailSyncEnabled: true,
      mailSyncIntervalMs: 3 * 60_000,
      calendarSyncEnabled: true,
      calendarSyncIntervalMs: 10 * 60_000,
      clientRefreshEnabled: true,
      clientRefreshIntervalMs: 30_000,
    });
    assert(valid.clientRefreshIntervalMs === 30_000, "同步设置应接受受支持的界面刷新频率");
    let invalidInterval: unknown;
    try {
      validateWorkspaceSyncSettings({ ...valid, calendarSyncIntervalMs: 45_000 });
    } catch (error) {
      invalidInterval = error;
    }
    assert(invalidInterval instanceof SyncSettingsError, "同步设置应拒绝任意频率");
    await stopCalendarSyncScheduler();
    console.log("Calendar sync scheduler tests passed");
  } finally {
    if (originalInterval === undefined) delete process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS;
    else process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS = originalInterval;
    await stopCalendarSyncScheduler();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
