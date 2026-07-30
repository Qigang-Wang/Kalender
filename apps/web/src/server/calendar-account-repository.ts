import { randomUUID } from "node:crypto";

import type { CalDavCredential, CalDavEventRecord, DiscoveredCalDavCalendar } from "./caldav-client";
import { decryptCredential, encryptCredential } from "./credential-crypto";
import { getDatabase } from "./database";
import { decodeNoteContent } from "../lib/note-content";
import type { ExchangeCalendarCredential, ExchangeCalendarEvent, ExchangeCalendarFolder } from "./exchange-calendar";
import {
  icsSubscriptionFingerprint,
  safeIcsSubscriptionLabel,
  type IcsSubscriptionCredential,
} from "./ics-subscription";
import { getUserScope } from "./user-scope";

export interface StoredCalendarAccount {
  readonly id: string;
  readonly providerId: "caldav" | "ics" | "exchange";
  readonly displayName: string;
  readonly serverUrl: string;
  readonly username: string;
  readonly emailAddress?: string;
  readonly color: string;
  readonly colorOverride?: string;
  readonly syncStatus: "idle" | "syncing" | "ready" | "error" | "paused";
  readonly syncError?: string;
  readonly lastSyncAt?: string;
  readonly calendarsCount: number;
  readonly mailEnabled: boolean;
  readonly calendarEnabled: boolean;
  readonly mailSyncStatus?: StoredCalendarAccount["syncStatus"];
  readonly mailSyncError?: string;
  readonly mailLastSyncAt?: string;
  readonly mailHistoryFoldersComplete: number;
  readonly mailHistoryFoldersTotal: number;
}

interface CalendarAccountRow {
  id: string;
  provider_id: "caldav" | "ics" | "exchange";
  display_name: string;
  server_url: string;
  username: string;
  email_address: string | null;
  color: string;
  color_override: string | null;
  sync_status: StoredCalendarAccount["syncStatus"];
  sync_error: string | null;
  last_sync_at: string | null;
  calendars_count: number;
  mail_enabled: boolean;
  calendar_enabled: boolean;
  mail_sync_status: StoredCalendarAccount["syncStatus"] | null;
  mail_sync_error: string | null;
  mail_last_sync_at: string | null;
  mail_history_folders_complete: number;
  mail_history_folders_total: number;
}

export async function saveCalDavAccount(
  displayName: string,
  credential: CalDavCredential,
): Promise<StoredCalendarAccount> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const existing = await database.query<{ id: string; color: string }>(
    `SELECT id, color FROM calendar_accounts
      WHERE provider_id = 'caldav' AND server_url = $1 AND username = $2${scope.active ? " AND user_id = $3" : ""} LIMIT 1`,
    scope.active ? [credential.serverUrl, credential.username, scope.userId] : [credential.serverUrl, credential.username],
  );
  const accountId = existing.rows[0]?.id ?? randomUUID();
  const color = existing.rows[0]?.color ?? accountColor(accountId);
  const encryptedPayload = await encryptCredential(accountId, credential);
  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO calendar_accounts (
         id, user_id, provider_id, display_name, server_url, username, color,
         enabled, sync_status, sync_error, last_tested_at, updated_at
       ) VALUES ($1, $2, 'caldav', $3, $4, $5, $6, true, 'idle', NULL, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         enabled = true,
         sync_status = 'idle',
         sync_error = NULL,
         last_tested_at = now(),
         updated_at = now()`,
      [accountId, scope.valueOrNull(), displayName, credential.serverUrl, credential.username, color],
    );
    await transaction.query(
      `INSERT INTO calendar_encrypted_credentials (account_id, encrypted_payload, key_version, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (account_id) DO UPDATE SET
         encrypted_payload = EXCLUDED.encrypted_payload,
         key_version = 1,
         updated_at = now()`,
      [accountId, encryptedPayload],
    );
  });
  return (await getCalendarAccount(accountId))!;
}

export async function saveIcsSubscription(
  displayName: string,
  credential: IcsSubscriptionCredential,
): Promise<StoredCalendarAccount> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const fingerprint = icsSubscriptionFingerprint(credential.feedUrl);
  const existing = await database.query<{ id: string; color: string }>(
    `SELECT id, color FROM calendar_accounts
      WHERE provider_id = 'ics' AND username = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [fingerprint, scope.userId] : [fingerprint],
  );
  const accountId = existing.rows[0]?.id ?? randomUUID();
  const color = existing.rows[0]?.color ?? accountColor(accountId);
  const encryptedPayload = await encryptCredential(accountId, credential);
  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO calendar_accounts (
         id, user_id, provider_id, display_name, server_url, username, color,
         enabled, sync_status, sync_error, last_tested_at, updated_at
       ) VALUES ($1, $2, 'ics', $3, $4, $5, $6, true, 'idle', NULL, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         enabled = true,
         sync_status = 'idle',
         sync_error = NULL,
         last_tested_at = now(),
         updated_at = now()`,
      [accountId, scope.valueOrNull(), displayName, safeIcsSubscriptionLabel(credential.feedUrl), fingerprint, color],
    );
    await transaction.query(
      `INSERT INTO calendar_encrypted_credentials (account_id, encrypted_payload, key_version, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (account_id) DO UPDATE SET
         encrypted_payload = EXCLUDED.encrypted_payload,
         key_version = 1,
         updated_at = now()`,
      [accountId, encryptedPayload],
    );
  });
  return (await getCalendarAccount(accountId))!;
}

export async function saveExchangeCalendarAccount(
  displayName: string,
  credential: ExchangeCalendarCredential,
  emailAddress = credential.username,
): Promise<StoredCalendarAccount> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const existing = await database.query<{ id: string; color: string; connection_id: string | null }>(
    `SELECT id, color, exchange_connection_id AS connection_id FROM calendar_accounts
      WHERE provider_id = 'exchange' AND server_url = $1 AND username = $2${scope.active ? " AND user_id = $3" : ""} LIMIT 1`,
    scope.active ? [credential.serverUrl, credential.username, scope.userId] : [credential.serverUrl, credential.username],
  );
  const existingConnection = await database.query<{ id: string; color: string }>(
    `SELECT id, color FROM exchange_connections WHERE server_url = $1 AND username = $2${scope.active ? " AND user_id = $3" : ""} LIMIT 1`,
    scope.active ? [credential.serverUrl, credential.username, scope.userId] : [credential.serverUrl, credential.username],
  );
  const connectionId = existing.rows[0]?.connection_id ?? existingConnection.rows[0]?.id ?? existing.rows[0]?.id ?? randomUUID();
  const accountId = existing.rows[0]?.id ?? connectionId;
  const color = existing.rows[0]?.color ?? accountColor(accountId);
  const encryptedPayload = await encryptCredential(connectionId, credential);
  const mailAccountId = `exchange-mail:${connectionId}`;
  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO exchange_connections (
         id, user_id, display_name, server_url, username, email_address, color,
         mail_enabled, calendar_enabled, last_tested_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,true,now(),now())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email_address = EXCLUDED.email_address,
         mail_enabled = true,
         calendar_enabled = true,
         last_tested_at = now(),
         updated_at = now()`,
      [connectionId, scope.valueOrNull(), displayName, credential.serverUrl, credential.username, emailAddress.toLocaleLowerCase(), color],
    );
    await transaction.query(
      `INSERT INTO exchange_connection_credentials (connection_id, encrypted_payload, key_version, updated_at)
       VALUES ($1,$2,1,now())
       ON CONFLICT (connection_id) DO UPDATE SET
         encrypted_payload = EXCLUDED.encrypted_payload,
         key_version = 1,
         updated_at = now()`,
      [connectionId, encryptedPayload],
    );
    await transaction.query(
      `INSERT INTO calendar_accounts (
         id, user_id, provider_id, display_name, server_url, username, color,
         enabled, sync_status, sync_error, last_tested_at, exchange_connection_id, updated_at
       ) VALUES ($1, $2, 'exchange', $3, $4, $5, $6, true, 'idle', NULL, now(), $7, now())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         exchange_connection_id = EXCLUDED.exchange_connection_id,
         enabled = true,
         sync_status = 'idle',
         sync_error = NULL,
         last_tested_at = now(),
         updated_at = now()`,
      [accountId, scope.valueOrNull(), displayName, credential.serverUrl, credential.username, color, connectionId],
    );
    await transaction.query(
      `INSERT INTO accounts (
         id, user_id, provider_id, display_name, email_address, color, enabled,
         sync_mode, sync_status, sync_error, last_tested_at, exchange_connection_id, updated_at
       ) VALUES ($1,$2,'exchange-ews',$3,$4,$5,true,'recommended','idle',NULL,now(),$6,now())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         exchange_connection_id = EXCLUDED.exchange_connection_id,
         enabled = true,
         last_tested_at = now(),
         updated_at = now()`,
      [mailAccountId, scope.valueOrNull(), displayName, emailAddress.toLocaleLowerCase(), color, connectionId],
    );
  });
  return (await getCalendarAccount(accountId))!;
}

export async function listCalendarAccounts(): Promise<readonly StoredCalendarAccount[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<CalendarAccountRow>(
    `SELECT a.id, a.provider_id, a.display_name, a.server_url, a.username, ec.email_address,
            a.color, a.color_override, a.sync_status, a.sync_error, a.last_sync_at,
            COUNT(DISTINCT c.id)::integer AS calendars_count,
            COALESCE(ec.mail_enabled, false) AS mail_enabled,
            COALESCE(ec.calendar_enabled, true) AS calendar_enabled,
            MAX(ma.sync_status) AS mail_sync_status,
            MAX(ma.sync_error) AS mail_sync_error,
            MAX(ma.last_sync_at) AS mail_last_sync_at,
            COUNT(DISTINCT ms.provider_folder_id) FILTER (WHERE ms.initial_complete)::integer AS mail_history_folders_complete,
            COUNT(DISTINCT ms.provider_folder_id)::integer AS mail_history_folders_total
       FROM calendar_accounts a
       LEFT JOIN calendars c ON c.account_id = a.id
       LEFT JOIN exchange_connections ec ON ec.id = a.exchange_connection_id
       LEFT JOIN accounts ma ON ma.exchange_connection_id = a.exchange_connection_id
                            AND ma.provider_id = 'exchange-ews'
       LEFT JOIN exchange_mail_sync_state ms ON ms.account_id = ma.id
      WHERE a.enabled = true
        ${scope.active ? "AND a.user_id = $1" : ""}
      GROUP BY a.id, a.provider_id, a.display_name, a.server_url, a.username,
               a.color, a.color_override, a.sync_status, a.sync_error, a.last_sync_at, a.created_at,
               ec.email_address, ec.mail_enabled, ec.calendar_enabled
      ORDER BY a.created_at`,
    scope.active ? [scope.userId] : [],
  );
  return result.rows.map(mapCalendarAccount);
}

export async function getCalendarAccount(id: string): Promise<StoredCalendarAccount | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<CalendarAccountRow>(
    `SELECT a.id, a.provider_id, a.display_name, a.server_url, a.username, ec.email_address,
            a.color, a.color_override, a.sync_status, a.sync_error, a.last_sync_at,
            COUNT(DISTINCT c.id)::integer AS calendars_count,
            COALESCE(ec.mail_enabled, false) AS mail_enabled,
            COALESCE(ec.calendar_enabled, true) AS calendar_enabled,
            MAX(ma.sync_status) AS mail_sync_status,
            MAX(ma.sync_error) AS mail_sync_error,
            MAX(ma.last_sync_at) AS mail_last_sync_at,
            COUNT(DISTINCT ms.provider_folder_id) FILTER (WHERE ms.initial_complete)::integer AS mail_history_folders_complete,
            COUNT(DISTINCT ms.provider_folder_id)::integer AS mail_history_folders_total
       FROM calendar_accounts a
       LEFT JOIN calendars c ON c.account_id = a.id
       LEFT JOIN exchange_connections ec ON ec.id = a.exchange_connection_id
       LEFT JOIN accounts ma ON ma.exchange_connection_id = a.exchange_connection_id
                            AND ma.provider_id = 'exchange-ews'
       LEFT JOIN exchange_mail_sync_state ms ON ms.account_id = ma.id
      WHERE a.id = $1 AND a.enabled = true${scope.active ? " AND a.user_id = $2" : ""}
      GROUP BY a.id, a.provider_id, a.display_name, a.server_url, a.username,
               a.color, a.color_override, a.sync_status, a.sync_error, a.last_sync_at,
               ec.email_address, ec.mail_enabled, ec.calendar_enabled
      LIMIT 1`,
    scope.active ? [id, scope.userId] : [id],
  );
  return result.rows[0] ? mapCalendarAccount(result.rows[0]) : undefined;
}

export async function loadCalDavCredential(accountId: string): Promise<CalDavCredential> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ encrypted_payload: string }>(
    `SELECT c.encrypted_payload
       FROM calendar_encrypted_credentials c
       JOIN calendar_accounts a ON a.id = c.account_id
      WHERE c.account_id = $1${scope.active ? " AND a.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  const payload = result.rows[0]?.encrypted_payload;
  if (!payload) throw new Error("Calendar account credentials were not found");
  return decryptCredential<CalDavCredential>(accountId, payload);
}

export async function loadIcsSubscriptionCredential(accountId: string): Promise<IcsSubscriptionCredential> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ encrypted_payload: string }>(
    `SELECT c.encrypted_payload
       FROM calendar_encrypted_credentials c
       JOIN calendar_accounts a ON a.id = c.account_id
      WHERE c.account_id = $1${scope.active ? " AND a.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  const payload = result.rows[0]?.encrypted_payload;
  if (!payload) throw new Error("ICS subscription credentials were not found");
  return decryptCredential<IcsSubscriptionCredential>(accountId, payload);
}

export async function loadExchangeCalendarCredential(accountId: string): Promise<ExchangeCalendarCredential> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ encrypted_payload: string }>(
    `SELECT COALESCE(ecc.encrypted_payload, cec.encrypted_payload) AS encrypted_payload
       FROM calendar_accounts ca
       LEFT JOIN exchange_connection_credentials ecc ON ecc.connection_id = ca.exchange_connection_id
       LEFT JOIN calendar_encrypted_credentials cec ON cec.account_id = ca.id
      WHERE ca.id = $1${scope.active ? " AND ca.user_id = $2" : ""} LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  const payload = result.rows[0]?.encrypted_payload;
  if (!payload) throw new Error("Exchange calendar credentials were not found");
  const identity = await database.query<{ identity: string }>(
    `SELECT COALESCE(exchange_connection_id, id) AS identity FROM calendar_accounts WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  return decryptCredential<ExchangeCalendarCredential>(identity.rows[0]?.identity ?? accountId, payload);
}

export async function setCalendarAccountSyncStatus(
  accountId: string,
  status: StoredCalendarAccount["syncStatus"],
  error?: string,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE calendar_accounts SET sync_status = $2, sync_error = $3,
       last_sync_at = CASE WHEN $2 = 'ready' THEN now() ELSE last_sync_at END,
       updated_at = now() WHERE id = $1`,
    [accountId, status, error ?? null],
  );
}

export async function updateCalendarAccountSettings(
  accountId: string,
  input: { readonly displayName: string; readonly color: string; readonly emailAddress?: string },
): Promise<StoredCalendarAccount | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const updated = await database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      `UPDATE calendar_accounts
          SET display_name = $2, color_override = $3, updated_at = now()
        WHERE id = $1 AND enabled = true${scope.active ? " AND user_id = $4" : ""}
        RETURNING id`,
      scope.active ? [accountId, input.displayName, input.color, scope.userId] : [accountId, input.displayName, input.color],
    );
    if (!result.rows[0]) return false;
    await transaction.query(
      `UPDATE calendars SET color = $2, updated_at = now() WHERE account_id = $1${scope.active ? " AND user_id = $3" : ""}`,
      scope.active ? [accountId, input.color, scope.userId] : [accountId, input.color],
    );
    await transaction.query(
      `UPDATE exchange_connections ec
          SET display_name = $2, color = $3,
              email_address = COALESCE($4, ec.email_address), updated_at = now()
         FROM calendar_accounts ca
        WHERE ca.id = $1 AND ca.exchange_connection_id = ec.id${scope.active ? " AND ca.user_id = $5 AND ec.user_id = $5" : ""}`,
      scope.active ? [accountId, input.displayName, input.color, input.emailAddress?.toLocaleLowerCase() ?? null, scope.userId] : [accountId, input.displayName, input.color, input.emailAddress?.toLocaleLowerCase() ?? null],
    );
    await transaction.query(
      `UPDATE accounts a
          SET display_name = $2, color = $3,
              email_address = COALESCE($4, a.email_address), updated_at = now()
         FROM calendar_accounts ca
        WHERE ca.id = $1 AND ca.exchange_connection_id = a.exchange_connection_id${scope.active ? " AND ca.user_id = $5 AND a.user_id = $5" : ""}`,
      scope.active ? [accountId, input.displayName, input.color, input.emailAddress?.toLocaleLowerCase() ?? null, scope.userId] : [accountId, input.displayName, input.color, input.emailAddress?.toLocaleLowerCase() ?? null],
    );
    return true;
  });
  return updated ? getCalendarAccount(accountId) : undefined;
}

export async function updateExchangeFeatureSettings(
  accountId: string,
  input: { readonly mailEnabled: boolean; readonly calendarEnabled: boolean },
): Promise<StoredCalendarAccount | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const updated = await database.transaction(async (transaction) => {
    const connection = await transaction.query<{
      connection_id: string;
      display_name: string;
      username: string;
      email_address: string;
      color: string;
    }>(
      `SELECT ca.exchange_connection_id AS connection_id, ca.display_name, ca.username,
              ec.email_address, COALESCE(ca.color_override, ca.color) AS color
        FROM calendar_accounts ca
         JOIN exchange_connections ec ON ec.id = ca.exchange_connection_id
        WHERE ca.id = $1 AND ca.provider_id = 'exchange' AND ca.exchange_connection_id IS NOT NULL
          ${scope.active ? "AND ca.user_id = $2 AND ec.user_id = $2" : ""}
        LIMIT 1`,
      scope.active ? [accountId, scope.userId] : [accountId],
    );
    const row = connection.rows[0];
    if (!row) return false;
    await transaction.query(
      `UPDATE exchange_connections SET mail_enabled = $2, calendar_enabled = $3, updated_at = now()
        WHERE id = $1${scope.active ? " AND user_id = $4" : ""}`,
      scope.active ? [row.connection_id, input.mailEnabled, input.calendarEnabled, scope.userId] : [row.connection_id, input.mailEnabled, input.calendarEnabled],
    );
    if (input.mailEnabled) {
      await transaction.query(
        `INSERT INTO accounts (
           id, user_id, provider_id, display_name, email_address, color, enabled,
           sync_mode, sync_status, sync_error, last_tested_at, exchange_connection_id, updated_at
         ) VALUES ($1,$2,'exchange-ews',$3,$4,$5,true,'recommended','idle',NULL,now(),$6,now())
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           color = EXCLUDED.color,
           exchange_connection_id = EXCLUDED.exchange_connection_id,
           enabled = true,
           sync_status = CASE WHEN accounts.last_sync_at IS NULL THEN 'idle' ELSE 'ready' END,
           sync_error = NULL,
           updated_at = now()`,
        [`exchange-mail:${row.connection_id}`, scope.valueOrNull(), row.display_name, row.email_address, row.color, row.connection_id],
      );
    } else {
      await transaction.query(
        `UPDATE accounts SET enabled = false, sync_status = 'paused', updated_at = now() WHERE exchange_connection_id = $1${scope.active ? " AND user_id = $2" : ""}`,
        scope.active ? [row.connection_id, scope.userId] : [row.connection_id],
      );
    }
    await transaction.query(
      `UPDATE calendar_accounts SET
         sync_status = CASE
           WHEN $2 = false THEN 'paused'
           WHEN last_sync_at IS NULL THEN 'idle'
           ELSE 'ready'
         END,
         sync_error = NULL,
         updated_at = now()
       WHERE id = $1${scope.active ? " AND user_id = $3" : ""}`,
      scope.active ? [accountId, input.calendarEnabled, scope.userId] : [accountId, input.calendarEnabled],
    );
    return true;
  });
  return updated ? getCalendarAccount(accountId) : undefined;
}

export async function saveDiscoveredCalendar(
  accountId: string,
  calendar: DiscoveredCalDavCalendar,
  primary: boolean,
): Promise<string> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const existing = await database.query<{ id: string }>(
    "SELECT id FROM calendars WHERE account_id = $1 AND source_url = $2 LIMIT 1",
    [accountId, calendar.url],
  );
  const id = existing.rows[0]?.id ?? `caldav:${randomUUID()}`;
  await database.query(
    `INSERT INTO calendars (
       id, user_id, account_id, provider_id, provider_calendar_id, source_url,
       name, color, read_only, is_primary, time_zone, updated_at
     ) VALUES ($1,COALESCE($2, (SELECT user_id FROM calendar_accounts WHERE id = $3)),$3,'caldav',$4,$5,$6,$7,true,$8,'Europe/Berlin',now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       color = EXCLUDED.color,
       read_only = true,
       is_primary = EXCLUDED.is_primary,
       source_url = EXCLUDED.source_url,
       updated_at = now()`,
    [id, scope.valueOrNull(), accountId, `${accountId}:${calendar.url}`, calendar.url, calendar.name, calendar.color, primary],
  );
  return id;
}

export async function saveIcsSubscriptionCalendar(
  accountId: string,
  name: string,
  sourceLabel: string,
  color: string,
): Promise<string> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const existing = await database.query<{ id: string }>(
    "SELECT id FROM calendars WHERE account_id = $1 LIMIT 1",
    [accountId],
  );
  const id = existing.rows[0]?.id ?? `ics:${randomUUID()}`;
  await database.query(
    `INSERT INTO calendars (
       id, user_id, account_id, provider_id, provider_calendar_id, source_url,
       name, color, read_only, is_primary, time_zone, updated_at
     ) VALUES ($1,COALESCE($2, (SELECT user_id FROM calendar_accounts WHERE id = $3)),$3,'ics',$4,$5,$6,$7,true,false,'Europe/Berlin',now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       color = EXCLUDED.color,
       read_only = true,
       source_url = EXCLUDED.source_url,
       updated_at = now()`,
    [id, scope.valueOrNull(), accountId, `${accountId}:feed`, sourceLabel, name, color],
  );
  return id;
}

export async function saveExchangeCalendar(
  accountId: string,
  folder: ExchangeCalendarFolder,
  sourceUrl: string,
  color: string,
): Promise<string> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const providerCalendarId = `${accountId}:${folder.folderId}`;
  const existing = await database.query<{ id: string }>(
    "SELECT id FROM calendars WHERE provider_id = 'exchange' AND provider_calendar_id = $1 LIMIT 1",
    [providerCalendarId],
  );
  const id = existing.rows[0]?.id ?? `exchange:${randomUUID()}`;
  await database.query(
    `INSERT INTO calendars (
       id, user_id, account_id, provider_id, provider_calendar_id, source_url,
       name, color, read_only, is_primary, time_zone, updated_at
     ) VALUES ($1,COALESCE($2, (SELECT user_id FROM calendar_accounts WHERE id = $3)),$3,'exchange',$4,$5,$6,$7,false,false,'Europe/Berlin',now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       color = EXCLUDED.color,
       read_only = false,
       source_url = EXCLUDED.source_url,
       updated_at = now()`,
    [id, scope.valueOrNull(), accountId, providerCalendarId, sourceUrl, folder.name, color],
  );
  return id;
}

export async function saveCalDavEvents(
  calendarId: string,
  events: readonly CalDavEventRecord[],
  from: string,
  to: string,
): Promise<number> {
  return saveRemoteCalendarEvents(calendarId, events, from, to, "caldav-event");
}

export async function saveExchangeCalendarEvents(
  calendarId: string,
  events: readonly ExchangeCalendarEvent[],
  from: string,
  to: string,
): Promise<number> {
  return saveRemoteCalendarEvents(calendarId, events, from, to, "exchange-event");
}

export async function saveExchangeCalendarMutation(
  calendarId: string,
  event: ExchangeCalendarEvent,
  localEventId?: string,
  descriptionContent?: string,
): Promise<string> {
  const database = await getDatabase();
  const id = localEventId ?? `exchange-event:${randomUUID()}`;
  await database.query(
    `INSERT INTO calendar_events (
       id, calendar_id, provider_event_id, title, description, description_content, location,
       starts_at, ends_at, time_zone, all_day, attendees, meeting_url,
       status, etag, provider_item_id, provider_change_key,
       is_meeting, is_recurring, is_organizer, availability, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,now())
     ON CONFLICT (id) DO UPDATE SET
       provider_event_id = EXCLUDED.provider_event_id,
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       description_content = EXCLUDED.description_content,
       location = EXCLUDED.location,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at,
       time_zone = EXCLUDED.time_zone,
       all_day = EXCLUDED.all_day,
       attendees = EXCLUDED.attendees,
       meeting_url = EXCLUDED.meeting_url,
       status = EXCLUDED.status,
       etag = EXCLUDED.etag,
       provider_item_id = EXCLUDED.provider_item_id,
       provider_change_key = EXCLUDED.provider_change_key,
       is_meeting = EXCLUDED.is_meeting,
       is_recurring = EXCLUDED.is_recurring,
       is_organizer = EXCLUDED.is_organizer,
       availability = EXCLUDED.availability,
       updated_at = now()`,
    [
      id,
      calendarId,
      event.providerEventId,
      event.title,
      event.description ?? null,
      descriptionContent ? JSON.stringify(decodeNoteContent(descriptionContent)) : null,
      event.location ?? null,
      event.start,
      event.end,
      event.timeZone ?? "Europe/Berlin",
      event.allDay,
      JSON.stringify(event.attendees),
      event.meetingUrl ?? null,
      event.status,
      event.etag ?? null,
      event.itemId,
      event.changeKey ?? null,
      event.isMeeting,
      event.isRecurring,
      event.isOrganizer ?? null,
      event.availability ?? "busy",
    ],
  );
  return id;
}

async function saveRemoteCalendarEvents(
  calendarId: string,
  events: readonly CalDavEventRecord[],
  from: string,
  to: string,
  idPrefix: "caldav-event" | "exchange-event",
): Promise<number> {
  const database = await getDatabase();
  const providerIds: string[] = [];
  for (const event of events) {
    const exchangeEvent = idPrefix === "exchange-event" ? event as ExchangeCalendarEvent : undefined;
    providerIds.push(event.providerEventId);
    await database.query(
      `INSERT INTO calendar_events (
         id, calendar_id, provider_event_id, title, description, location,
         starts_at, ends_at, time_zone, all_day, attendees, meeting_url,
         status, etag, provider_item_id, provider_change_key,
         is_meeting, is_recurring, is_organizer, availability, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
       ON CONFLICT (calendar_id, provider_event_id) DO UPDATE SET
         title = EXCLUDED.title,
         description_content = CASE
           WHEN calendar_events.description IS DISTINCT FROM EXCLUDED.description THEN NULL
           ELSE calendar_events.description_content
         END,
         description = EXCLUDED.description,
         location = EXCLUDED.location,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         time_zone = EXCLUDED.time_zone,
         all_day = EXCLUDED.all_day,
         attendees = EXCLUDED.attendees,
         meeting_url = EXCLUDED.meeting_url,
         status = EXCLUDED.status,
         etag = EXCLUDED.etag,
         provider_item_id = EXCLUDED.provider_item_id,
         provider_change_key = EXCLUDED.provider_change_key,
         is_meeting = EXCLUDED.is_meeting,
         is_recurring = EXCLUDED.is_recurring,
         is_organizer = EXCLUDED.is_organizer,
         availability = EXCLUDED.availability,
         updated_at = now()`,
      [
        `${idPrefix}:${randomUUID()}`,
        calendarId,
        event.providerEventId,
        event.title,
        event.description ?? null,
        event.location ?? null,
        event.start,
        event.end,
        event.timeZone ?? "Europe/Berlin",
        event.allDay,
        JSON.stringify(event.attendees),
        event.meetingUrl ?? null,
        event.status,
        event.etag ?? null,
        exchangeEvent?.itemId ?? null,
        exchangeEvent?.changeKey ?? null,
        exchangeEvent?.isMeeting ?? false,
        exchangeEvent?.isRecurring ?? false,
        exchangeEvent?.isOrganizer ?? null,
        event.availability ?? "busy",
      ],
    );
  }
  await database.query(
    `DELETE FROM calendar_events
      WHERE calendar_id = $1 AND ends_at > $2 AND starts_at < $3
        AND (cardinality($4::text[]) = 0 OR NOT (provider_event_id = ANY($4::text[])))`,
    [calendarId, from, to, providerIds],
  );
  return events.length;
}

export async function deleteCalendarAccount(accountId: string): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  return database.transaction(async (transaction) => {
    const existing = await transaction.query<{ exchange_connection_id: string | null }>(
      `SELECT exchange_connection_id FROM calendar_accounts WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [accountId, scope.userId] : [accountId],
    );
    const connectionId = existing.rows[0]?.exchange_connection_id;
    await transaction.query(
      `DELETE FROM calendars WHERE account_id = $1${scope.active ? " AND user_id = $2" : ""}`,
      scope.active ? [accountId, scope.userId] : [accountId],
    );
    const result = await transaction.query<{ id: string }>(
      `DELETE FROM calendar_accounts WHERE id = $1${scope.active ? " AND user_id = $2" : ""} RETURNING id`,
      scope.active ? [accountId, scope.userId] : [accountId],
    );
    if (connectionId) {
      await transaction.query(
        `UPDATE exchange_connections SET calendar_enabled = false, updated_at = now() WHERE id = $1${scope.active ? " AND user_id = $2" : ""}`,
        scope.active ? [connectionId, scope.userId] : [connectionId],
      );
      await transaction.query(
        `DELETE FROM exchange_connections WHERE id = $1 AND mail_enabled = false AND calendar_enabled = false${scope.active ? " AND user_id = $2" : ""}`,
        scope.active ? [connectionId, scope.userId] : [connectionId],
      );
    }
    return Boolean(result.rows[0]);
  });
}

function mapCalendarAccount(row: CalendarAccountRow): StoredCalendarAccount {
  return {
    id: row.id,
    providerId: row.provider_id,
    displayName: row.display_name,
    serverUrl: row.server_url,
    username: row.provider_id === "ics" ? "" : row.username,
    emailAddress: row.email_address ?? undefined,
    color: row.color_override ?? row.color,
    colorOverride: row.color_override ?? undefined,
    syncStatus: row.sync_status,
    syncError: row.sync_error ?? undefined,
    lastSyncAt: row.last_sync_at ?? undefined,
    calendarsCount: Number(row.calendars_count ?? 0),
    mailEnabled: row.mail_enabled === true,
    calendarEnabled: row.calendar_enabled !== false,
    mailSyncStatus: row.mail_sync_status ?? undefined,
    mailSyncError: row.mail_sync_error ?? undefined,
    mailLastSyncAt: row.mail_last_sync_at ?? undefined,
    mailHistoryFoldersComplete: Number(row.mail_history_folders_complete ?? 0),
    mailHistoryFoldersTotal: Number(row.mail_history_folders_total ?? 0),
  };
}

function accountColor(value: string): string {
  const colors = ["#86bdf5", "#f0a05e", "#9dd5ae", "#c7a6f2", "#f28f9a"];
  const index = [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0) % colors.length;
  return colors[index] ?? colors[0]!;
}
