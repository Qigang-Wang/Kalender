export const DESKTOP_SETTINGS_STORAGE_KEY = "kalender.desktop.reminder-settings.v1";
const DESKTOP_AUTOSTART_DEFAULT_MIGRATION_KEY = "kalender.desktop.autostart-default-enabled.v1";
export const DESKTOP_SETTINGS_CHANGED_EVENT = "kalender:desktop-settings-changed";
export const DESKTOP_SYNC_REQUESTED_EVENT = "kalender:desktop-sync-requested";
export const DESKTOP_STATUS_CHANGED_EVENT = "kalender:desktop-status-changed";

export interface DesktopReminderSettings {
  readonly enabled: boolean;
  readonly reminderMinutesBefore: number;
  readonly allDayReminderHour: number;
  readonly launchAtLogin: boolean;
  readonly minimizeToTray: boolean;
  readonly showEventTitle: boolean;
  readonly missedReminderWindowMinutes: number;
}
export interface DesktopStatus {
  readonly available: boolean;
  readonly pauseUntil?: number;
  readonly queuedReminderCount: number;
  readonly lastSyncedAt?: number;
  readonly lastSyncAttemptAt?: number;
  readonly lastSyncError?: string;
}

export const DEFAULT_DESKTOP_REMINDER_SETTINGS: DesktopReminderSettings = {
  enabled: true,
  reminderMinutesBefore: 10,
  allDayReminderHour: 9,
  launchAtLogin: true,
  minimizeToTray: true,
  showEventTitle: true,
  missedReminderWindowMinutes: 30,
};

interface TauriCoreApi {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI__?: { readonly core?: TauriCoreApi };
    __KALENDER_NATIVE_FRAME__?: boolean;
  }
}

export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && typeof window.__TAURI__?.core?.invoke === "function";
}

export function usesNativeDesktopFrame(): boolean {
  return typeof window !== "undefined" && window.__KALENDER_NATIVE_FRAME__ === true;
}

export async function waitForDesktopApp(timeoutMs = 5_000): Promise<boolean> {
  if (isDesktopApp()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    if (isDesktopApp()) return true;
  }
  return false;
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("当前页面未运行在 Kalender 桌面客户端中");
  return invoke<T>(command, args);
}

export function publishDesktopStatus(status: DesktopStatus): void {
  window.dispatchEvent(new CustomEvent(DESKTOP_STATUS_CHANGED_EVENT, { detail: status }));
}

export function readDesktopReminderSettings(): DesktopReminderSettings {
  if (typeof window === "undefined") return DEFAULT_DESKTOP_REMINDER_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY) || "null") as Partial<DesktopReminderSettings> | null;
    const settings = normalizeDesktopReminderSettings({ ...DEFAULT_DESKTOP_REMINDER_SETTINGS, ...parsed });
    if (window.localStorage.getItem(DESKTOP_AUTOSTART_DEFAULT_MIGRATION_KEY) === "1") return settings;
    const migrated = { ...settings, launchAtLogin: true };
    window.localStorage.setItem(DESKTOP_SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
    window.localStorage.setItem(DESKTOP_AUTOSTART_DEFAULT_MIGRATION_KEY, "1");
    return migrated;
  } catch {
    return DEFAULT_DESKTOP_REMINDER_SETTINGS;
  }
}

export function saveDesktopReminderSettings(settings: DesktopReminderSettings): DesktopReminderSettings {
  const normalized = normalizeDesktopReminderSettings(settings);
  window.localStorage.setItem(DESKTOP_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(DESKTOP_SETTINGS_CHANGED_EVENT, { detail: normalized }));
  return normalized;
}

function normalizeDesktopReminderSettings(settings: DesktopReminderSettings): DesktopReminderSettings {
  return {
    enabled: settings.enabled === true,
    reminderMinutesBefore: allowedNumber(settings.reminderMinutesBefore, [0, 5, 10, 15, 30, 60], 10),
    allDayReminderHour: allowedNumber(settings.allDayReminderHour, [7, 8, 9, 10, 12], 9),
    launchAtLogin: settings.launchAtLogin === true,
    minimizeToTray: settings.minimizeToTray !== false,
    showEventTitle: settings.showEventTitle !== false,
    missedReminderWindowMinutes: allowedNumber(settings.missedReminderWindowMinutes, [0, 15, 30, 60, 180], 30),
  };
}

function allowedNumber(value: number, allowed: readonly number[], fallback: number): number {
  return Number.isFinite(value) && allowed.includes(value) ? value : fallback;
}
