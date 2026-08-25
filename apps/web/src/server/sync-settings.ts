import { recordAuditEvent, type AppUser } from "./auth";
import { getDatabase } from "./database";

export const BACKGROUND_SYNC_INTERVAL_OPTIONS_MS = [
  60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const;

export const CLIENT_REFRESH_INTERVAL_OPTIONS_MS = [
  15_000,
  30_000,
  60_000,
  2 * 60_000,
] as const;

export interface WorkspaceSyncSettings {
  readonly mailSyncEnabled: boolean;
  readonly mailSyncIntervalMs: number;
  readonly calendarSyncEnabled: boolean;
  readonly calendarSyncIntervalMs: number;
  readonly clientRefreshEnabled: boolean;
  readonly clientRefreshIntervalMs: number;
  readonly updatedAt?: string;
}

export type WorkspaceSyncSettingsInput = Omit<WorkspaceSyncSettings, "updatedAt">;

interface SyncSettingsRow {
  readonly mail_sync_enabled: boolean;
  readonly mail_sync_interval_seconds: number;
  readonly calendar_sync_enabled: boolean;
  readonly calendar_sync_interval_seconds: number;
  readonly client_refresh_enabled: boolean;
  readonly client_refresh_interval_seconds: number;
  readonly updated_at: string;
}

export class SyncSettingsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SyncSettingsError";
  }
}

export function defaultWorkspaceSyncSettings(): WorkspaceSyncSettings {
  return {
    mailSyncEnabled: true,
    mailSyncIntervalMs: configuredInterval(
      process.env.KALENDER_SYNC_INTERVAL_MS,
      3 * 60_000,
      BACKGROUND_SYNC_INTERVAL_OPTIONS_MS,
    ),
    calendarSyncEnabled: true,
    calendarSyncIntervalMs: configuredInterval(
      process.env.KALENDER_CALENDAR_SYNC_INTERVAL_MS,
      3 * 60_000,
      BACKGROUND_SYNC_INTERVAL_OPTIONS_MS,
    ),
    clientRefreshEnabled: true,
    clientRefreshIntervalMs: 15_000,
  };
}

export async function getWorkspaceSyncSettings(): Promise<WorkspaceSyncSettings> {
  const database = await getDatabase();
  const result = await database.query<SyncSettingsRow>(
    `SELECT mail_sync_enabled, mail_sync_interval_seconds,
            calendar_sync_enabled, calendar_sync_interval_seconds,
            client_refresh_enabled, client_refresh_interval_seconds, updated_at
       FROM sync_settings
      WHERE id = 'workspace'
      LIMIT 1`,
  );
  if (result.rows[0]) return mapSyncSettings(result.rows[0]);

  const defaults = defaultWorkspaceSyncSettings();
  await database.query(
    `INSERT INTO sync_settings (
       id, mail_sync_enabled, mail_sync_interval_seconds,
       calendar_sync_enabled, calendar_sync_interval_seconds,
       client_refresh_enabled, client_refresh_interval_seconds
     ) VALUES ('workspace', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      defaults.mailSyncEnabled,
      defaults.mailSyncIntervalMs / 1000,
      defaults.calendarSyncEnabled,
      defaults.calendarSyncIntervalMs / 1000,
      defaults.clientRefreshEnabled,
      defaults.clientRefreshIntervalMs / 1000,
    ],
  );
  return getWorkspaceSyncSettings();
}

export async function saveWorkspaceSyncSettings(
  actor: AppUser,
  input: WorkspaceSyncSettingsInput,
): Promise<WorkspaceSyncSettings> {
  if (actor.role !== "admin") throw new SyncSettingsError("Nur Administratoren können die Workspace-Synchronisierung ändern", 403);
  const settings = validateWorkspaceSyncSettings(input);
  const database = await getDatabase();
  const result = await database.query<SyncSettingsRow>(
    `INSERT INTO sync_settings (
       id, mail_sync_enabled, mail_sync_interval_seconds,
       calendar_sync_enabled, calendar_sync_interval_seconds,
       client_refresh_enabled, client_refresh_interval_seconds, updated_by_user_id, updated_at
     ) VALUES ('workspace', $1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (id) DO UPDATE SET
       mail_sync_enabled = EXCLUDED.mail_sync_enabled,
       mail_sync_interval_seconds = EXCLUDED.mail_sync_interval_seconds,
       calendar_sync_enabled = EXCLUDED.calendar_sync_enabled,
       calendar_sync_interval_seconds = EXCLUDED.calendar_sync_interval_seconds,
       client_refresh_enabled = EXCLUDED.client_refresh_enabled,
       client_refresh_interval_seconds = EXCLUDED.client_refresh_interval_seconds,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()
     RETURNING mail_sync_enabled, mail_sync_interval_seconds,
               calendar_sync_enabled, calendar_sync_interval_seconds,
               client_refresh_enabled, client_refresh_interval_seconds, updated_at`,
    [
      settings.mailSyncEnabled,
      settings.mailSyncIntervalMs / 1000,
      settings.calendarSyncEnabled,
      settings.calendarSyncIntervalMs / 1000,
      settings.clientRefreshEnabled,
      settings.clientRefreshIntervalMs / 1000,
      actor.id,
    ],
  );
  await recordAuditEvent({
    actorUserId: actor.id,
    action: "sync.settings.update",
    metadata: settings,
  });
  return mapSyncSettings(result.rows[0]!);
}

export function validateWorkspaceSyncSettings(input: WorkspaceSyncSettingsInput): WorkspaceSyncSettingsInput {
  return {
    mailSyncEnabled: input.mailSyncEnabled === true,
    mailSyncIntervalMs: allowedInterval(
      input.mailSyncIntervalMs,
      BACKGROUND_SYNC_INTERVAL_OPTIONS_MS,
      "Häufigkeit der Synchronisierung von Mails",
    ),
    calendarSyncEnabled: input.calendarSyncEnabled === true,
    calendarSyncIntervalMs: allowedInterval(
      input.calendarSyncIntervalMs,
      BACKGROUND_SYNC_INTERVAL_OPTIONS_MS,
      "Kalender Synchronisationshäufigkeit",
    ),
    clientRefreshEnabled: input.clientRefreshEnabled === true,
    clientRefreshIntervalMs: allowedInterval(
      input.clientRefreshIntervalMs,
      CLIENT_REFRESH_INTERVAL_OPTIONS_MS,
      "Frequenz des Schnittstellenauffrischers",
    ),
  };
}

function mapSyncSettings(row: SyncSettingsRow): WorkspaceSyncSettings {
  return {
    mailSyncEnabled: Boolean(row.mail_sync_enabled),
    mailSyncIntervalMs: Number(row.mail_sync_interval_seconds) * 1000,
    calendarSyncEnabled: Boolean(row.calendar_sync_enabled),
    calendarSyncIntervalMs: Number(row.calendar_sync_interval_seconds) * 1000,
    clientRefreshEnabled: Boolean(row.client_refresh_enabled),
    clientRefreshIntervalMs: Number(row.client_refresh_interval_seconds) * 1000,
    updatedAt: row.updated_at,
  };
}

function configuredInterval(
  value: string | undefined,
  fallback: number,
  options: readonly number[],
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && options.includes(parsed) ? parsed : fallback;
}

function allowedInterval(value: number, options: readonly number[], label: string): number {
  if (!Number.isInteger(value) || !options.includes(value)) {
    throw new SyncSettingsError(`${label}nicht unterstützt`);
  }
  return value;
}
