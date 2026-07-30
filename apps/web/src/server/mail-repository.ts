import { randomUUID } from "node:crypto";

import type { MailServerConnection } from "./imap-smtp-test";
import { decryptCredential, encryptCredential } from "./credential-crypto";
import { getDatabase } from "./database";
import { getUserScope } from "./user-scope";
import type { ExchangeCredential } from "./exchange-ews-client";

export type SyncMode = "quick" | "recommended" | "full";

export interface StoredImapSmtpCredential {
  readonly kind: "imap_smtp";
  readonly imap: MailServerConnection;
  readonly smtp: MailServerConnection;
}

export interface SaveAccountInput {
  readonly accountId?: string;
  readonly displayName: string;
  readonly emailAddress: string;
  readonly syncMode: SyncMode;
  readonly credential: StoredImapSmtpCredential;
}

export interface StoredAccount {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly emailAddress: string;
  readonly color: string;
  readonly syncMode: SyncMode;
  readonly syncStatus: "idle" | "syncing" | "ready" | "error" | "paused";
  readonly syncError?: string;
  readonly lastSyncAt?: string;
}

export interface StoredSyncRun {
  readonly id: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly mode: SyncMode;
  readonly foldersProcessed: number;
  readonly messagesProcessed: number;
  readonly errorMessage?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface PublicImapSmtpSettings {
  readonly imap: Omit<MailServerConnection, "password">;
  readonly smtp: Omit<MailServerConnection, "password">;
}

export interface PublicExchangeSettings {
  readonly serverUrl: string;
  readonly username: string;
}

interface AccountRow {
  id: string;
  provider_id: string;
  display_name: string;
  email_address: string;
  color: string;
  sync_mode: SyncMode;
  sync_status: StoredAccount["syncStatus"];
  sync_error: string | null;
  last_sync_at: string | null;
}

interface CredentialRow {
  encrypted_payload: string;
}

interface SyncCursorRow {
  uid_validity: string;
  last_uid: number;
  backfill_before_uid: number | null;
  initial_complete: boolean;
  reconcile_before_uid: number | null;
  last_deep_reconcile_at: string | null;
}

export interface StoredSyncCursor {
  readonly uidValidity: string;
  readonly lastUid: number;
  readonly backfillBeforeUid?: number;
  readonly initialComplete: boolean;
  readonly reconcileBeforeUid?: number;
  readonly lastDeepReconcileAt?: string;
}

export interface FolderUidBounds {
  readonly minimumUid: number;
  readonly maximumUid: number;
}

export interface StoredExchangeMailSyncState {
  readonly syncState?: string;
  readonly latestSeeded: boolean;
  readonly initialComplete: boolean;
}

export interface FolderRecord {
  readonly id: string;
  readonly providerFolderId: string;
  readonly name: string;
  readonly role: string;
  readonly parentId?: string;
  readonly unreadCount?: number;
  readonly totalCount?: number;
  readonly sortOrder?: number;
  readonly manualSortOrder?: number;
}

export interface StoredMailFolder extends FolderRecord {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountColor: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly providerMessageId: string;
  readonly providerUid: number;
  readonly providerFolderId: string;
  readonly subject: string;
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc: readonly { readonly address: string; readonly name?: string }[];
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly snippet: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly attachments: readonly unknown[];
  readonly sizeBytes?: number;
}

export interface MessageBodyRecord {
  readonly id: string;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly snippet: string;
}

export interface ExchangeMessageReadFlagChange {
  readonly providerMessageId: string;
  readonly isRead: boolean;
}

export interface InboxItem {
  readonly id: string;
  readonly threadId: string;
  readonly threadCount: number;
  readonly unreadCount: number;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly senderName: string;
  readonly senderAddress: string;
  readonly subject: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly canArchive: boolean;
  readonly attachments: readonly InboxAttachment[];
  readonly direction?: "incoming" | "outgoing";
  readonly folderRole?: string;
  readonly correspondentName?: string;
  readonly correspondentAddress?: string;
}

export interface MailCorrespondenceSummary {
  readonly name: string;
  readonly address: string;
  readonly totalCount: number;
  readonly unreadCount: number;
  readonly incomingCount: number;
  readonly outgoingCount: number;
  readonly lastContactAt?: string;
}

export interface MailCorrespondenceResult {
  readonly items: readonly InboxItem[];
  readonly summary?: MailCorrespondenceSummary;
}

export interface UnreadInboxSummaryItem {
  readonly id: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly senderName: string;
  readonly senderAddress: string;
  readonly subject: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly isStarred: boolean;
  readonly attachmentCount: number;
  readonly canArchive: boolean;
}

export interface UnreadInboxSummary {
  readonly items: readonly UnreadInboxSummaryItem[];
  readonly total: number;
}

export interface InboxPageCursor {
  readonly receivedAt: string;
  readonly id: string;
}

export interface MailThreadMessage {
  readonly id: string;
  readonly threadId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly senderName: string;
  readonly senderAddress: string;
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc: readonly { readonly address: string; readonly name?: string }[];
  readonly subject: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly folderRole: string;
  readonly attachments: readonly InboxAttachment[];
}

export interface InboxAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly inline: boolean;
}

export interface MessageActionTarget {
  readonly id: string;
  readonly accountId: string;
  readonly providerFolderId: string;
  readonly providerUid: number;
  readonly providerMessageId: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
}

export type MessageMoveTarget = MessageActionTarget;

export interface StoredMessageBody {
  readonly id: string;
  readonly accountId: string;
  readonly threadId: string;
  readonly providerFolderId: string;
  readonly providerUid: number;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly snippet: string;
  readonly loadedAt?: string;
  readonly cacheVersion: number;
}

export interface StoredMessageRemote {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly attachments: readonly {
    readonly id?: string;
    readonly filename?: string;
    readonly contentType?: string;
    readonly sizeBytes?: number;
    readonly inline?: boolean;
    readonly contentId?: string;
  }[];
}

export const MAIL_BODY_CACHE_VERSION = 4;
export const DEFAULT_MAIL_BODY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAIL_BODY_CACHE_MAX_BYTES = 128 * 1024 * 1024;

function repairInvalidUnicode(value: string): string {
  let repaired = "";
  let segmentStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }

    repaired += `${value.slice(segmentStart, index)}\ufffd`;
    segmentStart = index + 1;
  }

  return segmentStart === 0 ? value : repaired + value.slice(segmentStart);
}

function stringifyPostgresJson(value: unknown): string {
  const serialized = JSON.stringify(
    value,
    (_key, nestedValue) => typeof nestedValue === "string"
      ? repairInvalidUnicode(nestedValue)
      : nestedValue,
  );
  if (serialized === undefined) throw new TypeError("Unable to serialize PostgreSQL JSON value");
  return serialized;
}

export interface MailBodyCacheCleanupOptions {
  readonly now?: Date;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  readonly targetBytes?: number;
}

export interface MailBodyCacheCleanupResult {
  readonly expiredEntries: number;
  readonly evictedEntries: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export interface MailAiContext {
  readonly id: string;
  readonly subject: string;
  readonly senderName: string;
  readonly senderAddress: string;
  readonly to: readonly string[];
  readonly receivedAt: string;
  readonly text: string;
}

export async function saveImapSmtpAccount(input: SaveAccountInput): Promise<StoredAccount> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const existing = input.accountId
    ? await database.query<{ id: string; color: string }>(
      `SELECT id, color FROM accounts WHERE id = $1 AND provider_id = 'imap-smtp'${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [input.accountId, scope.userId] : [input.accountId],
    )
    : await database.query<{ id: string; color: string }>(
      `SELECT id, color FROM accounts WHERE provider_id = $1 AND email_address = $2${scope.active ? " AND user_id = $3" : ""} LIMIT 1`,
      scope.active ? ["imap-smtp", input.emailAddress.toLocaleLowerCase(), scope.userId] : ["imap-smtp", input.emailAddress.toLocaleLowerCase()],
    );
  if (input.accountId && !existing.rows[0]) throw new Error("Account was not found");
  const accountId = existing.rows[0]?.id ?? randomUUID();
  const encryptedPayload = await encryptCredential(accountId, input.credential);
  const color = existing.rows[0]?.color ?? accountColor(accountId);

  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO accounts (
         id, user_id, provider_id, display_name, email_address, color, enabled,
         sync_mode, sync_status, sync_error, last_tested_at, updated_at
       ) VALUES ($1, $2, 'imap-smtp', $3, $4, $5, true, $6, 'idle', NULL, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email_address = EXCLUDED.email_address,
         sync_mode = EXCLUDED.sync_mode,
         enabled = true,
         last_tested_at = now(),
         updated_at = now()`,
      [accountId, scope.valueOrNull(), input.displayName, input.emailAddress.toLocaleLowerCase(), color, input.syncMode],
    );
    await transaction.query(
      `INSERT INTO encrypted_credentials (account_id, encrypted_payload, key_version, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (account_id) DO UPDATE SET
         encrypted_payload = EXCLUDED.encrypted_payload,
         key_version = EXCLUDED.key_version,
         updated_at = now()`,
      [accountId, encryptedPayload],
    );
  });

  return (await getAccount(accountId))!;
}

export async function getAccount(id: string): Promise<StoredAccount | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<AccountRow>(
    `SELECT id, provider_id, display_name, email_address, color, sync_mode,
            sync_status, sync_error, last_sync_at
       FROM accounts WHERE id = $1 AND enabled = true${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [id, scope.userId] : [id],
  );
  return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
}

export async function listAccounts(): Promise<readonly StoredAccount[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<AccountRow>(
    `SELECT id, provider_id, display_name, email_address, color, sync_mode,
            sync_status, sync_error, last_sync_at
       FROM accounts WHERE enabled = true${scope.active ? " AND user_id = $1" : ""} ORDER BY created_at`,
    scope.active ? [scope.userId] : [],
  );
  return result.rows.map(mapAccount);
}

export async function listAccountSelfAddresses(accountId: string): Promise<readonly string[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ address: string }>(
    `SELECT DISTINCT lower(trim(m.from_address ->> 'address')) AS address
       FROM mail_messages m
       JOIN mail_folders f
         ON f.account_id = m.account_id
        AND f.provider_folder_id = m.provider_folder_id
      JOIN accounts a ON a.id = m.account_id AND a.enabled = true
      WHERE m.account_id = $1${scope.active ? " AND a.user_id = $2" : ""}
        AND f.role = 'sent'
        AND trim(coalesce(m.from_address ->> 'address', '')) <> ''
      ORDER BY address`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  return result.rows.map((row) => row.address).filter(Boolean);
}

export async function getExchangeMailAccountForCalendar(calendarAccountId: string): Promise<StoredAccount | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<AccountRow>(
    `SELECT a.id, a.provider_id, a.display_name, a.email_address, a.color, a.sync_mode,
            a.sync_status, a.sync_error, a.last_sync_at
       FROM accounts a
       JOIN calendar_accounts ca ON ca.exchange_connection_id = a.exchange_connection_id
      WHERE ca.id = $1 AND a.provider_id = 'exchange-ews' AND a.enabled = true${scope.active ? " AND a.user_id = $2 AND ca.user_id = $2" : ""} LIMIT 1`,
    scope.active ? [calendarAccountId, scope.userId] : [calendarAccountId],
  );
  return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
}

export async function loadImapSmtpCredential(accountId: string): Promise<StoredImapSmtpCredential> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<CredentialRow>(
    `SELECT c.encrypted_payload
       FROM encrypted_credentials c
       JOIN accounts a ON a.id = c.account_id
      WHERE c.account_id = $1${scope.active ? " AND a.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  const payload = result.rows[0]?.encrypted_payload;
  if (!payload) throw new Error("Account credentials were not found");
  return decryptCredential<StoredImapSmtpCredential>(accountId, payload);
}

export async function loadExchangeMailCredential(accountId: string): Promise<ExchangeCredential> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ connection_id: string; encrypted_payload: string }>(
    `SELECT a.exchange_connection_id AS connection_id, ecc.encrypted_payload
       FROM accounts a
       JOIN exchange_connection_credentials ecc ON ecc.connection_id = a.exchange_connection_id
      WHERE a.id = $1 AND a.provider_id = 'exchange-ews'${scope.active ? " AND a.user_id = $2" : ""} LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  const row = result.rows[0];
  if (!row?.connection_id || !row.encrypted_payload) throw new Error("Exchange account credentials were not found");
  return decryptCredential<ExchangeCredential>(row.connection_id, row.encrypted_payload);
}

export async function getPublicImapSmtpSettings(accountId: string): Promise<PublicImapSmtpSettings> {
  const credential = await loadImapSmtpCredential(accountId);
  const { password: _imapPassword, ...imap } = credential.imap;
  const { password: _smtpPassword, ...smtp } = credential.smtp;
  return { imap, smtp };
}

export async function getPublicExchangeSettings(accountId: string): Promise<PublicExchangeSettings> {
  const credential = await loadExchangeMailCredential(accountId);
  return { serverUrl: credential.serverUrl, username: credential.username };
}

export async function setAccountPaused(accountId: string, paused: boolean): Promise<StoredAccount | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ id: string }>(
    `UPDATE accounts SET
       sync_status = CASE
         WHEN $2 = 'pause' THEN 'paused'
         WHEN last_sync_at IS NOT NULL THEN 'ready'
         ELSE 'idle'
       END,
       sync_error = NULL,
       updated_at = now()
      WHERE id = $1 AND enabled = true${scope.active ? " AND user_id = $3" : ""} RETURNING id`,
    scope.active ? [accountId, paused ? "pause" : "resume", scope.userId] : [accountId, paused ? "pause" : "resume"],
  );
  return result.rows[0] ? getAccount(accountId) : undefined;
}

export async function deleteAccount(accountId: string): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  return database.transaction(async (transaction) => {
    const existing = await transaction.query<{ provider_id: string; exchange_connection_id: string | null }>(
      `SELECT provider_id, exchange_connection_id FROM accounts WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
      scope.active ? [accountId, scope.userId] : [accountId],
    );
    const row = existing.rows[0];
    if (!row) return false;
    if (row.provider_id === "exchange-ews" && row.exchange_connection_id) {
      await transaction.query(
        `UPDATE exchange_connections SET mail_enabled = false, updated_at = now() WHERE id = $1${scope.active ? " AND user_id = $2" : ""}`,
        scope.active ? [row.exchange_connection_id, scope.userId] : [row.exchange_connection_id],
      );
    }
    const result = await transaction.query<{ id: string }>(
      `DELETE FROM accounts WHERE id = $1${scope.active ? " AND user_id = $2" : ""} RETURNING id`,
      scope.active ? [accountId, scope.userId] : [accountId],
    );
    if (row.exchange_connection_id) {
      await transaction.query(
        `DELETE FROM exchange_connections WHERE id = $1 AND mail_enabled = false AND calendar_enabled = false${scope.active ? " AND user_id = $2" : ""}`,
        scope.active ? [row.exchange_connection_id, scope.userId] : [row.exchange_connection_id],
      );
    }
    return Boolean(result.rows[0]);
  });
}

export async function setSyncStatus(
  accountId: string,
  status: StoredAccount["syncStatus"],
  error?: string,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE accounts SET sync_status = $2, sync_error = $3,
       last_sync_at = CASE WHEN $2 = 'ready' THEN now() ELSE last_sync_at END,
       updated_at = now() WHERE id = $1`,
    [accountId, status, error ?? null],
  );
}

export async function startSyncRun(accountId: string, mode: SyncMode): Promise<string> {
  const database = await getDatabase();
  const id = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE sync_runs
          SET status = 'failed',
              error_message = '同步进程已中断',
              finished_at = now()
        WHERE account_id = $1 AND status = 'running'`,
      [accountId],
    );
    await transaction.query(
      "INSERT INTO sync_runs (id, account_id, status, mode) VALUES ($1, $2, 'running', $3)",
      [id, accountId, mode],
    );
  });
  return id;
}

export async function finishSyncRun(
  runId: string,
  status: "succeeded" | "failed",
  folders: number,
  messages: number,
  error?: string,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE sync_runs SET status = $2, folders_processed = $3,
       messages_processed = $4, error_message = $5, finished_at = now()
       WHERE id = $1`,
    [runId, status, folders, messages, error ?? null],
  );
}

export async function updateSyncRunProgress(
  runId: string,
  folders: number,
  messages: number,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE sync_runs
        SET folders_processed = $2, messages_processed = $3
      WHERE id = $1 AND status = 'running'`,
    [runId, folders, messages],
  );
}

export async function getLatestSyncRun(accountId: string): Promise<StoredSyncRun | undefined> {
  const database = await getDatabase();
  const result = await database.query<{
    id: string;
    status: StoredSyncRun["status"];
    mode: SyncMode;
    folders_processed: number;
    messages_processed: number;
    error_message: string | null;
    started_at: string;
    finished_at: string | null;
  }>(
    `SELECT id, status, mode, folders_processed, messages_processed,
            error_message, started_at, finished_at
       FROM sync_runs
      WHERE account_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [accountId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    status: row.status,
    mode: row.mode,
    foldersProcessed: row.folders_processed,
    messagesProcessed: row.messages_processed,
    errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  } : undefined;
}

export async function upsertFolder(accountId: string, folder: FolderRecord): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `INSERT INTO mail_folders (
       id, account_id, provider_folder_id, name, role, parent_id,
       unread_count, total_count, sort_order, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (account_id, provider_folder_id) DO UPDATE SET
       id = EXCLUDED.id, name = EXCLUDED.name, role = EXCLUDED.role, parent_id = EXCLUDED.parent_id,
       unread_count = EXCLUDED.unread_count, total_count = EXCLUDED.total_count,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()`,
    [folder.id, accountId, folder.providerFolderId, folder.name, folder.role,
      folder.parentId ?? null, folder.unreadCount ?? null, folder.totalCount ?? null, folder.sortOrder ?? 0],
  );
}

export async function listMailFolders(): Promise<readonly StoredMailFolder[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    account_id: string;
    account_name: string;
    account_color: string;
    provider_folder_id: string;
    name: string;
    role: string;
    parent_id: string | null;
    unread_count: number | null;
    total_count: number | null;
    sort_order: number;
    manual_sort_order: number | null;
  }>(
    `SELECT f.id, f.account_id, a.display_name AS account_name, a.color AS account_color,
            f.provider_folder_id, f.name, f.role, f.parent_id, f.unread_count, f.total_count, f.sort_order, f.manual_sort_order
       FROM mail_folders f
       JOIN accounts a ON a.id = f.account_id AND a.enabled = true
      ${scope.active ? "WHERE a.user_id = $1" : ""}
      ORDER BY a.created_at, f.sort_order, f.name`,
    scope.active ? [scope.userId] : [],
  );
  return result.rows.map(mapMailFolder);
}

export async function getMailNavigationSummary(): Promise<{ readonly unreadCount: number }> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ unread_count: number }>(
    `SELECT COALESCE(sum(COALESCE(f.unread_count, 0)), 0)::integer AS unread_count
       FROM mail_folders f
       JOIN accounts a ON a.id = f.account_id AND a.enabled = true
      WHERE f.role = 'inbox'${scope.active ? " AND a.user_id = $1" : ""}`,
    scope.active ? [scope.userId] : [],
  );
  return { unreadCount: Number(result.rows[0]?.unread_count ?? 0) };
}

export async function getMailFolder(folderId: string): Promise<StoredMailFolder | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    account_id: string;
    account_name: string;
    account_color: string;
    provider_folder_id: string;
    name: string;
    role: string;
    parent_id: string | null;
    unread_count: number | null;
    total_count: number | null;
    sort_order: number;
    manual_sort_order: number | null;
  }>(
    `SELECT f.id, f.account_id, a.display_name AS account_name, a.color AS account_color,
            f.provider_folder_id, f.name, f.role, f.parent_id, f.unread_count, f.total_count, f.sort_order, f.manual_sort_order
       FROM mail_folders f
       JOIN accounts a ON a.id = f.account_id AND a.enabled = true
      WHERE f.id = $1${scope.active ? " AND a.user_id = $2" : ""} LIMIT 1`,
    scope.active ? [folderId, scope.userId] : [folderId],
  );
  return result.rows[0] ? mapMailFolder(result.rows[0]) : undefined;
}

function mapMailFolder(row: {
  id: string;
  account_id: string;
  account_name: string;
  account_color: string;
  provider_folder_id: string;
  name: string;
  role: string;
  parent_id: string | null;
  unread_count: number | null;
  total_count: number | null;
  sort_order: number;
  manual_sort_order: number | null;
}): StoredMailFolder {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    accountColor: row.account_color,
    providerFolderId: row.provider_folder_id,
    name: row.name,
    role: row.role,
    parentId: row.parent_id ?? undefined,
    unreadCount: row.unread_count ?? undefined,
    totalCount: row.total_count ?? undefined,
    sortOrder: row.sort_order,
    manualSortOrder: row.manual_sort_order ?? undefined,
  };
}

export async function updateFolderManualOrder(
  accountId: string,
  parentId: string | undefined,
  orderedFolderIds: readonly string[],
): Promise<void> {
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      `SELECT id FROM mail_folders
        WHERE account_id = $1 AND parent_id IS NOT DISTINCT FROM $2
          AND role IN ('other', 'custom')`,
      [accountId, parentId ?? null],
    );
    const available = new Set(result.rows.map((row) => row.id));
    if (available.size !== orderedFolderIds.length || orderedFolderIds.some((id) => !available.has(id))) {
      throw new Error("文件夹顺序已经变化，请刷新后重试");
    }
    for (const [manualSortOrder, folderId] of orderedFolderIds.entries()) {
      await transaction.query(
        "UPDATE mail_folders SET manual_sort_order = $2, updated_at = now() WHERE id = $1",
        [folderId, manualSortOrder],
      );
    }
  });
}

export async function removeFolderSubtreeFromIndex(folderId: string): Promise<void> {
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    const subtree = await transaction.query<{ id: string; account_id: string; provider_folder_id: string }>(
      `WITH RECURSIVE folders AS (
         SELECT id, account_id, provider_folder_id FROM mail_folders WHERE id = $1
         UNION ALL
         SELECT child.id, child.account_id, child.provider_folder_id
           FROM mail_folders child JOIN folders parent ON child.parent_id = parent.id
       ) SELECT id, account_id, provider_folder_id FROM folders`,
      [folderId],
    );
    if (!subtree.rows.length) return;
    const accountId = subtree.rows[0]!.account_id;
    const providerFolderIds = subtree.rows.map((row) => row.provider_folder_id);
    const folderIds = subtree.rows.map((row) => row.id);
    await transaction.query(
      "DELETE FROM mail_messages WHERE account_id = $1 AND provider_folder_id = ANY($2::text[])",
      [accountId, providerFolderIds],
    );
    await transaction.query(
      "DELETE FROM exchange_mail_sync_state WHERE account_id = $1 AND provider_folder_id = ANY($2::text[])",
      [accountId, providerFolderIds],
    );
    await transaction.query(
      "DELETE FROM sync_cursors WHERE account_id = $1 AND provider_folder_id = ANY($2::text[])",
      [accountId, providerFolderIds],
    );
    await transaction.query("DELETE FROM mail_folders WHERE id = ANY($1::text[])", [folderIds]);
    await transaction.query(
      "DELETE FROM mail_threads t WHERE t.account_id = $1 AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id)",
      [accountId],
    );
  });
}

export async function upsertMessage(accountId: string, message: MessageRecord): Promise<void> {
  await upsertMessages(accountId, [message]);
}

export async function upsertMessages(accountId: string, messages: readonly MessageRecord[]): Promise<void> {
  if (messages.length === 0) return;
  const database = await getDatabase();
  const batch = stringifyPostgresJson(messages.map((message) => ({
    id: message.id,
    thread_id: message.threadId,
    provider_message_id: message.providerMessageId,
    provider_uid: message.providerUid,
    provider_folder_id: message.providerFolderId,
    subject: message.subject,
    from_address: message.from,
    to_addresses: message.to,
    cc_addresses: message.cc,
    sent_at: message.sentAt,
    received_at: message.receivedAt,
    snippet: message.snippet,
    is_read: message.isRead,
    is_starred: message.isStarred,
    attachments: message.attachments,
    size_bytes: message.sizeBytes ?? null,
  })));
  const threadIds = [...new Set(messages.map((message) => message.threadId))];
  await database.transaction(async (transaction) => {
    await transaction.query(
      `WITH message_batch AS (
         SELECT *
           FROM jsonb_to_recordset($2::jsonb) AS message (
             id text, thread_id text, provider_message_id text, provider_uid integer,
             provider_folder_id text, subject text, from_address jsonb,
             to_addresses jsonb, cc_addresses jsonb, sent_at timestamptz,
             received_at timestamptz, snippet text, is_read boolean,
             is_starred boolean, attachments jsonb, size_bytes integer
           )
       ), latest_threads AS (
         SELECT DISTINCT ON (thread_id)
                thread_id, subject, snippet, from_address, to_addresses,
                received_at, is_read
           FROM message_batch
          ORDER BY thread_id, received_at DESC, id DESC
       )
       INSERT INTO mail_threads (
         id, account_id, provider_thread_id, subject, snippet, participants,
         last_message_at, unread_count, updated_at
       )
       SELECT thread_id, $1, thread_id, subject, snippet,
              jsonb_build_array(from_address) || to_addresses,
              received_at, CASE WHEN is_read THEN 0 ELSE 1 END, now()
         FROM latest_threads
       ON CONFLICT (id) DO UPDATE SET
         subject = CASE WHEN EXCLUDED.last_message_at >= mail_threads.last_message_at THEN EXCLUDED.subject ELSE mail_threads.subject END,
         snippet = CASE WHEN EXCLUDED.last_message_at >= mail_threads.last_message_at THEN EXCLUDED.snippet ELSE mail_threads.snippet END,
         participants = CASE WHEN EXCLUDED.last_message_at >= mail_threads.last_message_at THEN EXCLUDED.participants ELSE mail_threads.participants END,
         last_message_at = GREATEST(mail_threads.last_message_at, EXCLUDED.last_message_at),
         updated_at = now()`,
      [accountId, batch],
    );
    await transaction.query(
      `WITH message_batch AS (
         SELECT *
           FROM jsonb_to_recordset($2::jsonb) AS message (
             id text, thread_id text, provider_message_id text, provider_uid integer,
             provider_folder_id text, subject text, from_address jsonb,
             to_addresses jsonb, cc_addresses jsonb, sent_at timestamptz,
             received_at timestamptz, snippet text, is_read boolean,
             is_starred boolean, attachments jsonb, size_bytes integer
           )
       )
       INSERT INTO mail_messages (
         id, account_id, thread_id, provider_message_id, provider_uid,
         provider_folder_id, subject, from_address, to_addresses, cc_addresses,
         sent_at, received_at, snippet, is_read, is_starred, attachments,
         size_bytes, updated_at
       )
       SELECT id, $1, thread_id, provider_message_id, provider_uid,
              provider_folder_id, subject, from_address, to_addresses, cc_addresses,
              sent_at, received_at, snippet, is_read, is_starred, attachments,
              size_bytes, now()
         FROM message_batch
       ON CONFLICT (account_id, provider_folder_id, provider_uid) DO UPDATE SET
         subject = EXCLUDED.subject, from_address = EXCLUDED.from_address,
         to_addresses = EXCLUDED.to_addresses, cc_addresses = EXCLUDED.cc_addresses,
         sent_at = EXCLUDED.sent_at, received_at = EXCLUDED.received_at,
         snippet = EXCLUDED.snippet, is_read = EXCLUDED.is_read,
         is_starred = EXCLUDED.is_starred, attachments = EXCLUDED.attachments,
         size_bytes = EXCLUDED.size_bytes, updated_at = now()`,
      [accountId, batch],
    );
    await transaction.query(
      `WITH latest AS (
         SELECT DISTINCT ON (thread_id) thread_id, subject, snippet, received_at
           FROM mail_messages
          WHERE thread_id = ANY($1::text[])
          ORDER BY thread_id, received_at DESC, id DESC
       ), stats AS (
         SELECT thread_id,
                count(*) FILTER (WHERE is_read = false)::integer AS unread_count
           FROM mail_messages
          WHERE thread_id = ANY($1::text[])
          GROUP BY thread_id
       )
       UPDATE mail_threads t SET
         subject = latest.subject,
         snippet = latest.snippet,
         last_message_at = latest.received_at,
         unread_count = stats.unread_count,
         updated_at = now()
       FROM latest
       JOIN stats ON stats.thread_id = latest.thread_id
       WHERE t.id = latest.thread_id`,
      [threadIds],
    );
  });
}

export async function updateMessageFlags(
  accountId: string,
  providerFolderId: string,
  providerUid: number,
  isRead: boolean,
  isStarred: boolean,
): Promise<boolean> {
  const database = await getDatabase();
  let updated = false;
  await database.transaction(async (transaction) => {
    const result = await transaction.query<{ thread_id: string }>(
      `UPDATE mail_messages
          SET is_read = $4, is_starred = $5, updated_at = now()
        WHERE account_id = $1 AND provider_folder_id = $2 AND provider_uid = $3
        RETURNING thread_id`,
      [accountId, providerFolderId, providerUid, isRead, isStarred],
    );
    const threadId = result.rows[0]?.thread_id;
    if (!threadId) return;
    updated = true;
    await transaction.query(
      `UPDATE mail_threads SET unread_count = (
         SELECT count(*)::int FROM mail_messages WHERE thread_id = $1 AND is_read = false
       ), updated_at = now() WHERE id = $1`,
      [threadId],
    );
  });
  return updated;
}

export async function removeMissingFolderMessages(
  accountId: string,
  providerFolderId: string,
  minimumUid: number,
  maximumUid: number,
  remoteUids: ReadonlySet<number>,
): Promise<number> {
  const database = await getDatabase();
  const result = await database.query<{ id: string; thread_id: string; provider_uid: number }>(
    `SELECT id, thread_id, provider_uid
       FROM mail_messages
      WHERE account_id = $1 AND provider_folder_id = $2
        AND provider_uid BETWEEN $3 AND $4`,
    [accountId, providerFolderId, minimumUid, maximumUid],
  );
  const missing = result.rows.filter((row) => !remoteUids.has(row.provider_uid));
  if (missing.length === 0) return 0;
  await database.transaction(async (transaction) => {
    const messageIds = missing.map((row) => row.id);
    const threadIds = [...new Set(missing.map((row) => row.thread_id))];
    await transaction.query("DELETE FROM mail_messages WHERE id = ANY($1::text[])", [messageIds]);
    for (const threadId of threadIds) {
      await transaction.query(
        `UPDATE mail_threads t SET
           subject = latest.subject,
           snippet = latest.snippet,
           last_message_at = latest.received_at,
           unread_count = stats.unread_count,
           updated_at = now()
         FROM (
           SELECT subject, snippet, received_at FROM mail_messages
            WHERE thread_id = $1 ORDER BY received_at DESC, id DESC LIMIT 1
         ) latest,
         (
           SELECT count(*) FILTER (WHERE is_read = false)::integer AS unread_count
             FROM mail_messages WHERE thread_id = $1
         ) stats
         WHERE t.id = $1`,
        [threadId],
      );
    }
    await transaction.query(
      `DELETE FROM mail_threads
        WHERE account_id = $1 AND id = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = mail_threads.id)`,
      [accountId, threadIds],
    );
  });
  return missing.length;
}

export async function saveSyncCursor(
  accountId: string,
  providerFolderId: string,
  uidValidity: string,
  lastUid: number,
  backfillBeforeUid?: number,
  initialComplete = false,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `INSERT INTO sync_cursors (
       account_id, provider_folder_id, uid_validity, last_uid,
       backfill_before_uid, initial_complete, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (account_id, provider_folder_id) DO UPDATE SET
       uid_validity = EXCLUDED.uid_validity, last_uid = EXCLUDED.last_uid,
       backfill_before_uid = EXCLUDED.backfill_before_uid,
       initial_complete = EXCLUDED.initial_complete, updated_at = now()`,
    [accountId, providerFolderId, uidValidity, lastUid,
      backfillBeforeUid ?? null, initialComplete],
  );
}

export async function getSyncCursor(
  accountId: string,
  providerFolderId: string,
): Promise<StoredSyncCursor | undefined> {
  const database = await getDatabase();
  const result = await database.query<SyncCursorRow>(
    `SELECT uid_validity, last_uid, backfill_before_uid, initial_complete,
            reconcile_before_uid, last_deep_reconcile_at
       FROM sync_cursors
      WHERE account_id = $1 AND provider_folder_id = $2
      LIMIT 1`,
    [accountId, providerFolderId],
  );
  const row = result.rows[0];
  return row ? {
    uidValidity: row.uid_validity,
    lastUid: row.last_uid,
    backfillBeforeUid: row.backfill_before_uid ?? undefined,
    initialComplete: row.initial_complete,
    reconcileBeforeUid: row.reconcile_before_uid ?? undefined,
    lastDeepReconcileAt: row.last_deep_reconcile_at ?? undefined,
  } : undefined;
}

export async function saveDeepReconcileCursor(
  accountId: string,
  providerFolderId: string,
  reconcileBeforeUid: number,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE sync_cursors
        SET reconcile_before_uid = $3,
            last_deep_reconcile_at = now(),
            updated_at = now()
      WHERE account_id = $1 AND provider_folder_id = $2`,
    [accountId, providerFolderId, Math.max(0, reconcileBeforeUid)],
  );
}

export async function getFolderUidBounds(
  accountId: string,
  providerFolderId: string,
): Promise<FolderUidBounds | undefined> {
  const database = await getDatabase();
  const result = await database.query<{ minimum_uid: number | null; maximum_uid: number | null }>(
    `SELECT min(provider_uid)::integer AS minimum_uid,
            max(provider_uid)::integer AS maximum_uid
       FROM mail_messages
      WHERE account_id = $1 AND provider_folder_id = $2`,
    [accountId, providerFolderId],
  );
  const row = result.rows[0];
  return row?.minimum_uid !== null && row?.minimum_uid !== undefined && row.maximum_uid !== null
    ? { minimumUid: row.minimum_uid, maximumUid: row.maximum_uid! }
    : undefined;
}

export async function reopenAccountHistoryBackfill(accountId: string): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE sync_cursors
        SET initial_complete = false,
            backfill_before_uid = COALESCE(backfill_before_uid, last_uid + 1),
            updated_at = now()
      WHERE account_id = $1`,
    [accountId],
  );
}

export async function resetFolderSyncState(accountId: string, providerFolderId: string): Promise<void> {
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    await transaction.query(
      `DELETE FROM mail_threads
        WHERE account_id = $1
          AND id IN (
            SELECT thread_id FROM mail_messages
             WHERE account_id = $1 AND provider_folder_id = $2
          )`,
      [accountId, providerFolderId],
    );
    await transaction.query(
      "DELETE FROM sync_cursors WHERE account_id = $1 AND provider_folder_id = $2",
      [accountId, providerFolderId],
    );
  });
}

export async function getExchangeMailSyncState(
  accountId: string,
  providerFolderId: string,
): Promise<StoredExchangeMailSyncState | undefined> {
  const database = await getDatabase();
  const result = await database.query<{ sync_state: string | null; latest_seeded: boolean; initial_complete: boolean }>(
    `SELECT sync_state, latest_seeded, initial_complete
       FROM exchange_mail_sync_state
      WHERE account_id = $1 AND provider_folder_id = $2 LIMIT 1`,
    [accountId, providerFolderId],
  );
  const row = result.rows[0];
  return row ? {
    syncState: row.sync_state ?? undefined,
    latestSeeded: row.latest_seeded,
    initialComplete: row.initial_complete,
  } : undefined;
}

export async function saveExchangeMailSyncState(
  accountId: string,
  providerFolderId: string,
  input: StoredExchangeMailSyncState,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `INSERT INTO exchange_mail_sync_state (
       account_id, provider_folder_id, sync_state, latest_seeded, initial_complete, updated_at
     ) VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (account_id, provider_folder_id) DO UPDATE SET
       sync_state = EXCLUDED.sync_state,
       latest_seeded = EXCLUDED.latest_seeded,
       initial_complete = EXCLUDED.initial_complete,
       updated_at = now()`,
    [accountId, providerFolderId, input.syncState ?? null, input.latestSeeded, input.initialComplete],
  );
}

export async function removeExchangeMessages(accountId: string, providerMessageIds: readonly string[]): Promise<number> {
  if (!providerMessageIds.length) return 0;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; thread_id: string }>(
      `DELETE FROM mail_messages
        WHERE account_id = $1 AND provider_message_id = ANY($2::text[])
        RETURNING id, thread_id`,
      [accountId, [...providerMessageIds]],
    );
    for (const threadId of new Set(result.rows.map((row) => row.thread_id))) {
      await transaction.query(
        "DELETE FROM mail_threads WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = $1)",
        [threadId],
      );
    }
    return result.rows.length;
  });
}

export async function updateExchangeMessageReadFlag(
  accountId: string,
  providerMessageId: string,
  isRead: boolean,
): Promise<number> {
  return updateExchangeMessageReadFlags(accountId, [{ providerMessageId, isRead }]);
}

export async function updateExchangeMessageReadFlags(
  accountId: string,
  changes: readonly ExchangeMessageReadFlagChange[],
): Promise<number> {
  if (changes.length === 0) return 0;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const batch = stringifyPostgresJson(changes.map((change) => ({
      provider_message_id: change.providerMessageId,
      is_read: change.isRead,
    })));
    const result = await transaction.query<{ thread_id: string }>(
      `WITH read_flag_batch AS (
         SELECT *
           FROM jsonb_to_recordset($2::jsonb) AS change (
             provider_message_id text,
             is_read boolean
           )
       )
       UPDATE mail_messages message SET
         is_read = change.is_read,
         updated_at = now()
       FROM read_flag_batch change
       WHERE message.account_id = $1
         AND message.provider_message_id = change.provider_message_id
       RETURNING message.thread_id`,
      [accountId, batch],
    );
    const threadIds = [...new Set(result.rows.map((row) => row.thread_id))];
    if (threadIds.length > 0) {
      await transaction.query(
        `UPDATE mail_threads thread SET
           unread_count = stats.unread_count,
           updated_at = now()
         FROM (
           SELECT thread_id,
                  count(*) FILTER (WHERE is_read = false)::integer AS unread_count
             FROM mail_messages
            WHERE thread_id = ANY($1::text[])
            GROUP BY thread_id
         ) stats
         WHERE thread.id = stats.thread_id`,
        [threadIds],
      );
    }
    return result.rows.length;
  });
}

export async function listInbox(
  limit = 100,
  folderId?: string,
  cursor?: InboxPageCursor,
): Promise<readonly InboxItem[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    thread_id: string;
    thread_count: number;
    unread_count: number;
    account_id: string;
    account_name: string;
    account_color: string;
    from_address: { address: string; name?: string };
    subject: string;
    snippet: string;
    received_at: string;
    is_read: boolean;
    is_starred: boolean;
    can_archive: boolean;
    attachments: InboxAttachment[];
  }>(
    `WITH candidate_inbox AS (
       SELECT DISTINCT ON (m.thread_id) m.*
         FROM mail_messages m
         JOIN mail_folders f ON f.account_id = m.account_id
                            AND f.provider_folder_id = m.provider_folder_id
         JOIN accounts candidate_account ON candidate_account.id = m.account_id
                                        AND candidate_account.enabled = true
        WHERE (($2::text IS NULL AND f.role = 'inbox') OR f.id = $2)
          ${scope.active ? "AND candidate_account.user_id = $5" : ""}
        ORDER BY m.thread_id, m.received_at DESC, m.id DESC
     ), selected_inbox AS (
       SELECT *
         FROM candidate_inbox
        WHERE ($3::timestamptz IS NULL OR received_at < $3
               OR (received_at = $3 AND id < $4))
        ORDER BY received_at DESC, id DESC
        LIMIT $1
     ), selected_thread_stats AS (
       SELECT peer.thread_id,
              count(*)::integer AS thread_count,
              count(*) FILTER (
                WHERE peer.is_read = false
                  AND (($2::text IS NULL AND peer_folder.role = 'inbox') OR peer_folder.id = $2)
              )::integer AS unread_count
         FROM mail_messages peer
         JOIN selected_inbox selected ON selected.thread_id = peer.thread_id
         LEFT JOIN mail_folders peer_folder
           ON peer_folder.account_id = peer.account_id
          AND peer_folder.provider_folder_id = peer.provider_folder_id
        GROUP BY peer.thread_id
     )
     SELECT m.id, m.thread_id, m.account_id, a.display_name AS account_name,
            a.color AS account_color, m.from_address, m.subject, m.snippet,
            m.received_at, (COALESCE(stats.unread_count, 0) = 0) AS is_read,
            m.is_starred, m.attachments,
            stats.thread_count, COALESCE(stats.unread_count, 0) AS unread_count,
            EXISTS (
              SELECT 1 FROM mail_folders archive
               WHERE archive.account_id = m.account_id
                 AND (archive.role = 'archive' OR lower(archive.name) IN ('archive', 'archiv'))
                 AND archive.provider_folder_id <> m.provider_folder_id
            ) AS can_archive
       FROM selected_inbox m
       JOIN accounts a ON a.id = m.account_id
       JOIN selected_thread_stats stats ON stats.thread_id = m.thread_id
      ORDER BY m.received_at DESC, m.id DESC`,
    scope.active
      ? [Math.max(1, Math.min(limit, 500)), folderId ?? null, cursor?.receivedAt ?? null, cursor?.id ?? null, scope.userId]
      : [Math.max(1, Math.min(limit, 500)), folderId ?? null, cursor?.receivedAt ?? null, cursor?.id ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    threadCount: Number(row.thread_count ?? 1),
    unreadCount: Number(row.unread_count ?? 0),
    accountId: row.account_id,
    accountName: row.account_name,
    accountColor: row.account_color,
    senderName: row.from_address.name ?? row.from_address.address,
    senderAddress: row.from_address.address,
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.received_at,
    isRead: row.is_read,
    isStarred: row.is_starred,
    canArchive: row.can_archive,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  }));
}

export async function listMailCorrespondence(
  correspondentAddress: string,
  limit = 100,
  cursor?: InboxPageCursor,
): Promise<MailCorrespondenceResult> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const address = correspondentAddress.trim().toLocaleLowerCase();
  if (!address) return { items: [] };
  const result = await database.query<{
    id: string;
    thread_id: string;
    account_id: string;
    account_name: string;
    account_color: string;
    from_address: { address: string; name?: string };
    to_addresses: { address: string; name?: string }[];
    subject: string;
    snippet: string;
    received_at: string;
    is_read: boolean;
    is_starred: boolean;
    can_archive: boolean;
    folder_role: string;
    direction: "incoming" | "outgoing";
    correspondent_name: string;
    attachments: InboxAttachment[];
    total_count: number;
    unread_count: number;
    incoming_count: number;
    outgoing_count: number;
    last_contact_at: string;
  }>(
    `WITH matched_messages AS (
       SELECT DISTINCT ON (m.account_id, m.provider_message_id)
              m.*, a.display_name AS account_name, a.color AS account_color,
              COALESCE(f.role, 'other') AS folder_role,
              CASE
                WHEN lower(COALESCE(m.from_address->>'address', '')) = $2 THEN 'incoming'
                ELSE 'outgoing'
              END AS direction,
              CASE
                WHEN lower(COALESCE(m.from_address->>'address', '')) = $2
                  THEN COALESCE(NULLIF(m.from_address->>'name', ''), m.from_address->>'address', $2)
                ELSE COALESCE(
                  (
                    SELECT NULLIF(recipient->>'name', '')
                      FROM jsonb_array_elements(
                        COALESCE(m.to_addresses, '[]'::jsonb) ||
                        COALESCE(m.cc_addresses, '[]'::jsonb)
                      ) recipient
                     WHERE lower(COALESCE(recipient->>'address', '')) = $2
                     LIMIT 1
                  ),
                  $2
                )
              END AS correspondent_name
         FROM mail_messages m
         JOIN accounts a ON a.id = m.account_id AND a.enabled = true
         LEFT JOIN mail_folders f ON f.account_id = m.account_id
                                 AND f.provider_folder_id = m.provider_folder_id
        WHERE (
          lower(COALESCE(m.from_address->>'address', '')) = $2
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(
                COALESCE(m.to_addresses, '[]'::jsonb) ||
                COALESCE(m.cc_addresses, '[]'::jsonb)
              ) recipient
             WHERE lower(COALESCE(recipient->>'address', '')) = $2
          )
        )
          AND COALESCE(f.role, 'other') NOT IN ('drafts', 'trash', 'junk', 'spam')
          ${scope.active ? "AND a.user_id = $5" : ""}
        ORDER BY m.account_id, m.provider_message_id,
                 CASE WHEN f.role = 'all' THEN 1 ELSE 0 END,
                 m.received_at DESC, m.id DESC
     ), correspondence_stats AS (
       SELECT count(*)::integer AS total_count,
              count(*) FILTER (WHERE is_read = false AND direction = 'incoming')::integer AS unread_count,
              count(*) FILTER (WHERE direction = 'incoming')::integer AS incoming_count,
              count(*) FILTER (WHERE direction = 'outgoing')::integer AS outgoing_count,
              max(received_at) AS last_contact_at
         FROM matched_messages
     ), selected_messages AS (
       SELECT *
         FROM matched_messages
        WHERE ($3::timestamptz IS NULL OR received_at < $3
               OR (received_at = $3 AND id < $4))
        ORDER BY received_at DESC, id DESC
        LIMIT $1
     )
     SELECT m.id, m.thread_id, m.account_id, m.account_name, m.account_color,
            m.from_address, m.to_addresses, m.subject, m.snippet, m.received_at,
            m.is_read, m.is_starred, m.attachments, m.folder_role, m.direction,
            m.correspondent_name, stats.total_count, stats.unread_count,
            stats.incoming_count, stats.outgoing_count, stats.last_contact_at,
            EXISTS (
              SELECT 1 FROM mail_folders archive
               WHERE archive.account_id = m.account_id
                 AND (archive.role = 'archive' OR lower(archive.name) IN ('archive', 'archiv'))
                 AND archive.provider_folder_id <> m.provider_folder_id
            ) AS can_archive
       FROM selected_messages m
       CROSS JOIN correspondence_stats stats
      ORDER BY m.received_at DESC, m.id DESC`,
    scope.active
      ? [Math.max(1, Math.min(limit, 500)), address, cursor?.receivedAt ?? null, cursor?.id ?? null, scope.userId]
      : [Math.max(1, Math.min(limit, 500)), address, cursor?.receivedAt ?? null, cursor?.id ?? null],
  );
  const items = result.rows.map((row) => {
    const recipient = (Array.isArray(row.to_addresses) ? row.to_addresses : [])
      .find((mailbox) => mailbox.address?.trim().toLocaleLowerCase() === address);
    return {
      id: row.id,
      threadId: row.thread_id,
      threadCount: 1,
      unreadCount: row.is_read ? 0 : 1,
      accountId: row.account_id,
      accountName: row.account_name,
      accountColor: row.account_color,
      senderName: row.from_address.name ?? row.from_address.address,
      senderAddress: row.from_address.address,
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: row.received_at,
      isRead: row.is_read,
      isStarred: row.is_starred,
      canArchive: row.can_archive,
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      direction: row.direction,
      folderRole: row.folder_role,
      correspondentName: row.correspondent_name || recipient?.name || address,
      correspondentAddress: address,
    } satisfies InboxItem;
  });
  const first = result.rows[0];
  return {
    items,
    summary: first ? {
      name: first.correspondent_name || address,
      address,
      totalCount: Number(first.total_count ?? 0),
      unreadCount: Number(first.unread_count ?? 0),
      incomingCount: Number(first.incoming_count ?? 0),
      outgoingCount: Number(first.outgoing_count ?? 0),
      lastContactAt: first.last_contact_at,
    } : undefined,
  };
}

export async function listUnreadInboxSummary(limit = 6): Promise<UnreadInboxSummary> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    account_name: string;
    account_color: string;
    from_address: { address: string; name?: string };
    subject: string;
    snippet: string;
    received_at: string;
    is_starred: boolean;
    attachment_count: number;
    can_archive: boolean;
    total: number;
  }>(
    `WITH unread_threads AS (
       SELECT DISTINCT ON (m.thread_id)
              m.id, m.thread_id, a.display_name AS account_name, a.color AS account_color,
              m.from_address, m.subject, m.snippet, m.received_at, m.is_starred,
              jsonb_array_length(m.attachments) AS attachment_count,
              EXISTS (
                SELECT 1 FROM mail_folders archive_folder
                 WHERE archive_folder.account_id = m.account_id
                   AND archive_folder.role = 'archive'
              ) AS can_archive
         FROM mail_messages m
         JOIN mail_folders f ON f.account_id = m.account_id
                            AND f.provider_folder_id = m.provider_folder_id
         JOIN accounts a ON a.id = m.account_id AND a.enabled = true
        WHERE f.role = 'inbox' AND m.is_read = false${scope.active ? " AND a.user_id = $2" : ""}
        ORDER BY m.thread_id, m.is_starred DESC, m.received_at DESC, m.id DESC
     )
     SELECT id, account_name, account_color, from_address, subject, snippet, received_at, is_starred,
            attachment_count, can_archive,
            count(*) OVER ()::integer AS total
       FROM unread_threads
      ORDER BY is_starred DESC, received_at DESC, id DESC
      LIMIT $1`,
    scope.active ? [Math.max(1, Math.min(limit, 50)), scope.userId] : [Math.max(1, Math.min(limit, 50))],
  );
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      accountName: row.account_name,
      accountColor: row.account_color,
      senderName: row.from_address.name ?? row.from_address.address,
      senderAddress: row.from_address.address,
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: row.received_at,
      isStarred: row.is_starred,
      attachmentCount: row.attachment_count,
      canArchive: row.can_archive,
    })),
    total: Number(result.rows[0]?.total ?? 0),
  };
}

export async function listMailThread(messageId: string): Promise<readonly MailThreadMessage[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    thread_id: string;
    account_id: string;
    account_name: string;
    account_color: string;
    from_address: { address: string; name?: string };
    to_addresses: { address: string; name?: string }[];
    cc_addresses: { address: string; name?: string }[];
    subject: string;
    snippet: string;
    received_at: string;
    is_read: boolean;
    is_starred: boolean;
    folder_role: string | null;
    attachments: InboxAttachment[];
  }>(
    `SELECT m.id, m.thread_id, m.account_id, a.display_name AS account_name,
            a.color AS account_color, m.from_address, m.to_addresses, m.cc_addresses,
            m.subject, m.snippet, m.received_at, m.is_read, m.is_starred,
            COALESCE(f.role, 'other') AS folder_role, m.attachments
       FROM mail_messages m
       JOIN accounts a ON a.id = m.account_id AND a.enabled = true
       LEFT JOIN mail_folders f ON f.account_id = m.account_id
                               AND f.provider_folder_id = m.provider_folder_id
      WHERE m.thread_id = (
        SELECT anchor.thread_id
          FROM mail_messages anchor
          JOIN accounts anchor_account ON anchor_account.id = anchor.account_id AND anchor_account.enabled = true
         WHERE anchor.id = $1${scope.active ? " AND anchor_account.user_id = $2" : ""}
         LIMIT 1
      )
      ${scope.active ? "AND a.user_id = $2" : ""}
      ORDER BY m.received_at, m.id`,
    scope.active ? [messageId, scope.userId] : [messageId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    accountId: row.account_id,
    accountName: row.account_name,
    accountColor: row.account_color,
    senderName: row.from_address.name ?? row.from_address.address,
    senderAddress: row.from_address.address,
    to: Array.isArray(row.to_addresses) ? row.to_addresses : [],
    cc: Array.isArray(row.cc_addresses) ? row.cc_addresses : [],
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.received_at,
    isRead: row.is_read,
    isStarred: row.is_starred,
    folderRole: row.folder_role ?? "other",
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  }));
}

export async function getMessageActionTarget(messageId: string): Promise<MessageActionTarget | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    account_id: string;
    provider_folder_id: string;
    provider_uid: number;
    provider_message_id: string;
    is_read: boolean;
    is_starred: boolean;
  }>(
    `SELECT m.id, m.account_id, m.provider_folder_id, m.provider_uid, m.provider_message_id,
            m.is_read, m.is_starred
       FROM mail_messages m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.enabled = true${scope.active ? " AND a.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [messageId, scope.userId] : [messageId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    accountId: row.account_id,
    providerFolderId: row.provider_folder_id,
    providerUid: row.provider_uid,
    providerMessageId: row.provider_message_id,
    isRead: row.is_read,
    isStarred: row.is_starred,
  } : undefined;
}

export async function getMessageMoveTargets(messageId: string): Promise<readonly MessageMoveTarget[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    account_id: string;
    provider_folder_id: string;
    provider_uid: number;
    provider_message_id: string;
    is_read: boolean;
    is_starred: boolean;
  }>(
    `SELECT peer.id, peer.account_id, peer.provider_folder_id, peer.provider_uid,
            peer.provider_message_id, peer.is_read, peer.is_starred
       FROM mail_messages anchor
       JOIN mail_messages peer ON peer.account_id = anchor.account_id
                              AND peer.thread_id = anchor.thread_id
                              AND peer.provider_folder_id = anchor.provider_folder_id
       JOIN accounts a ON a.id = peer.account_id AND a.enabled = true
      WHERE anchor.id = $1${scope.active ? " AND a.user_id = $2" : ""}
      ORDER BY peer.received_at, peer.id`,
    scope.active ? [messageId, scope.userId] : [messageId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    providerFolderId: row.provider_folder_id,
    providerUid: row.provider_uid,
    providerMessageId: row.provider_message_id,
    isRead: row.is_read,
    isStarred: row.is_starred,
  }));
}

export async function getArchiveFolderPath(accountId: string): Promise<string | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ provider_folder_id: string }>(
    `SELECT f.provider_folder_id
       FROM mail_folders f
       JOIN accounts a ON a.id = f.account_id AND a.enabled = true
      WHERE f.account_id = $1${scope.active ? " AND a.user_id = $2" : ""}
        AND (f.role = 'archive' OR lower(f.name) IN ('archive', 'archiv'))
      ORDER BY CASE WHEN role = 'archive' THEN 0 ELSE 1 END
      LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  return result.rows[0]?.provider_folder_id;
}

export async function getTrashFolderPath(accountId: string): Promise<string | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ provider_folder_id: string }>(
    `SELECT f.provider_folder_id
       FROM mail_folders f
       JOIN accounts a ON a.id = f.account_id AND a.enabled = true
      WHERE f.account_id = $1${scope.active ? " AND a.user_id = $2" : ""}
        AND (f.role = 'trash' OR lower(f.name) IN ('trash', 'deleted items', 'gelöschte elemente', 'papierkorb'))
      ORDER BY CASE WHEN role = 'trash' THEN 0 ELSE 1 END
      LIMIT 1`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  return result.rows[0]?.provider_folder_id;
}

export async function removeMessageFromIndex(messageId: string): Promise<boolean> {
  const database = await getDatabase();
  let removed = false;
  await database.transaction(async (transaction) => {
    const result = await transaction.query<{ thread_id: string }>(
      "DELETE FROM mail_messages WHERE id = $1 RETURNING thread_id",
      [messageId],
    );
    const threadId = result.rows[0]?.thread_id;
    if (!threadId) return;
    removed = true;
    await transaction.query(
      `DELETE FROM mail_threads
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = $1)`,
      [threadId],
    );
  });
  return removed;
}

export async function getStoredMessageBody(messageId: string): Promise<StoredMessageBody | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    account_id: string;
    thread_id: string;
    provider_folder_id: string;
    provider_uid: number;
    text_body: string | null;
    html_body: string | null;
    snippet: string;
    body_loaded_at: string | null;
    body_cache_version: number;
  }>(
    `SELECT m.id, m.account_id, m.thread_id, m.provider_folder_id, m.provider_uid,
            body.text_body, body.html_body, m.snippet,
            body.loaded_at AS body_loaded_at,
            COALESCE(body.cache_version, 0) AS body_cache_version
       FROM mail_messages m
       JOIN accounts a ON a.id = m.account_id
       LEFT JOIN mail_message_bodies body ON body.message_id = m.id
      WHERE m.id = $1 AND a.enabled = true${scope.active ? " AND a.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [messageId, scope.userId] : [messageId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    providerFolderId: row.provider_folder_id,
    providerUid: row.provider_uid,
    textBody: row.text_body ?? undefined,
    htmlBody: row.html_body ?? undefined,
    snippet: row.snippet,
    loadedAt: row.body_loaded_at ?? undefined,
    cacheVersion: row.body_cache_version,
  } : undefined;
}

export async function getStoredMessageRemote(messageId: string): Promise<StoredMessageRemote | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ account_id: string; provider_message_id: string; attachments: unknown }>(
    `SELECT m.account_id, m.provider_message_id, m.attachments
       FROM mail_messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.enabled = true${scope.active ? " AND a.user_id = $2" : ""} LIMIT 1`,
    scope.active ? [messageId, scope.userId] : [messageId],
  );
  const row = result.rows[0];
  return row ? {
    accountId: row.account_id,
    providerMessageId: row.provider_message_id,
    attachments: Array.isArray(row.attachments) ? row.attachments as StoredMessageRemote["attachments"] : [],
  } : undefined;
}

export async function getMailAiContext(messageId: string): Promise<MailAiContext | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{
    id: string;
    subject: string;
    from_address: unknown;
    to_addresses: unknown;
    received_at: string;
    text_body: string | null;
    html_body: string | null;
    snippet: string;
  }>(
    `SELECT m.id, m.subject, m.from_address, m.to_addresses, m.received_at,
            body.text_body, body.html_body, m.snippet
       FROM mail_messages m
       JOIN accounts a ON a.id = m.account_id
       LEFT JOIN mail_message_bodies body ON body.message_id = m.id
      WHERE m.id = $1 AND a.enabled = true${scope.active ? " AND a.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [messageId, scope.userId] : [messageId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const sender = jsonRecord(row.from_address);
  return {
    id: row.id,
    subject: row.subject,
    senderName: typeof sender.name === "string" ? sender.name : typeof sender.address === "string" ? sender.address : "未知发件人",
    senderAddress: typeof sender.address === "string" ? sender.address : "",
    to: jsonArray(row.to_addresses).flatMap((item) => {
      const mailbox = jsonRecord(item);
      return typeof mailbox.address === "string" ? [mailbox.address] : [];
    }),
    receivedAt: row.received_at,
    text: (row.text_body || htmlToPlainText(row.html_body) || row.snippet).slice(0, 80_000),
  };
}

export async function saveMessageBody(
  messageId: string,
  textBody: string | undefined,
  htmlBody: string | undefined,
  snippet: string,
): Promise<StoredMessageBody | undefined> {
  await saveMessageBodies([{ id: messageId, textBody, htmlBody, snippet }]);
  return getStoredMessageBody(messageId);
}

export async function saveMessageBodies(messages: readonly MessageBodyRecord[]): Promise<void> {
  if (messages.length === 0) return;
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    const batch = stringifyPostgresJson(messages.map((message) => ({
      id: message.id,
      text_body: message.textBody ?? null,
      html_body: message.htmlBody ?? null,
      snippet: message.snippet,
    })));
    const result = await transaction.query<{ thread_id: string }>(
      `WITH body_batch AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS body (
             id text,
             text_body text,
             html_body text,
             snippet text
           )
       )
       UPDATE mail_messages message SET
         snippet = body.snippet,
         updated_at = now()
       FROM body_batch body
       WHERE message.id = body.id
       RETURNING message.thread_id`,
      [batch],
    );
    await transaction.query(
      `WITH body_batch AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS body (
             id text,
             text_body text,
             html_body text,
             snippet text
           )
       )
       INSERT INTO mail_message_bodies (
         message_id, text_body, html_body, loaded_at, cache_version, updated_at
       )
       SELECT body.id, body.text_body, body.html_body, now(), $2, now()
         FROM body_batch body
         JOIN mail_messages message ON message.id = body.id
       ON CONFLICT (message_id) DO UPDATE SET
         text_body = EXCLUDED.text_body,
         html_body = EXCLUDED.html_body,
         loaded_at = EXCLUDED.loaded_at,
         cache_version = EXCLUDED.cache_version,
         updated_at = EXCLUDED.updated_at`,
      [batch, MAIL_BODY_CACHE_VERSION],
    );
    const threadIds = [...new Set(result.rows.map((row) => row.thread_id))];
    if (threadIds.length > 0) {
      await transaction.query(
        `WITH latest AS (
           SELECT DISTINCT ON (thread_id) thread_id, snippet
             FROM mail_messages
            WHERE thread_id = ANY($1::text[])
            ORDER BY thread_id, received_at DESC, id DESC
         )
         UPDATE mail_threads thread SET
           snippet = latest.snippet,
           updated_at = now()
         FROM latest
         WHERE thread.id = latest.thread_id`,
        [threadIds],
      );
    }
  });
}

export async function cleanupMailBodyCache(
  options: MailBodyCacheCleanupOptions = {},
): Promise<MailBodyCacheCleanupResult> {
  const database = await getDatabase();
  const now = options.now ?? new Date();
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? configuredMailBodyCacheMaxAgeMs());
  const maxBytes = Math.max(0, options.maxBytes ?? configuredMailBodyCacheMaxBytes());
  const targetBytes = Math.min(
    maxBytes,
    Math.max(0, options.targetBytes ?? Math.floor(maxBytes * 0.85)),
  );
  const cached = await database.query<{
    id: string;
    body_loaded_at: string;
    size_bytes: number;
  }>(
    `SELECT message_id AS id, loaded_at AS body_loaded_at,
            (COALESCE(octet_length(text_body), 0) + COALESCE(octet_length(html_body), 0))::integer AS size_bytes
       FROM mail_message_bodies
      ORDER BY loaded_at, message_id`,
  );
  const bytesBefore = cached.rows.reduce((total, row) => total + Number(row.size_bytes), 0);
  const expiryBoundary = now.getTime() - maxAgeMs;
  const expiredIds = cached.rows
    .filter((row) => {
      const loadedAt = Date.parse(row.body_loaded_at);
      return !Number.isFinite(loadedAt) || loadedAt <= expiryBoundary;
    })
    .map((row) => row.id);
  const expiredSet = new Set(expiredIds);
  const retained = cached.rows.filter((row) => !expiredSet.has(row.id));
  let retainedBytes = retained.reduce((total, row) => total + Number(row.size_bytes), 0);
  const evictedIds: string[] = [];
  if (retainedBytes > maxBytes) {
    for (const row of retained) {
      if (retainedBytes <= targetBytes) break;
      evictedIds.push(row.id);
      retainedBytes -= Number(row.size_bytes);
    }
  }
  const clearedIds = [...expiredIds, ...evictedIds];
  if (clearedIds.length > 0) {
    await database.query(
      "DELETE FROM mail_message_bodies WHERE message_id = ANY($1::text[])",
      [clearedIds],
    );
  }
  return {
    expiredEntries: expiredIds.length,
    evictedEntries: evictedIds.length,
    bytesBefore,
    bytesAfter: retainedBytes,
  };
}

export function configuredMailBodyCacheMaxAgeMs(): number {
  const configuredDays = Number(process.env.KALENDER_MAIL_BODY_CACHE_MAX_AGE_DAYS);
  return Number.isFinite(configuredDays) && configuredDays >= 0
    ? configuredDays * 24 * 60 * 60 * 1000
    : DEFAULT_MAIL_BODY_CACHE_MAX_AGE_MS;
}

export function configuredMailBodyCacheMaxBytes(): number {
  const configuredMegabytes = Number(process.env.KALENDER_MAIL_BODY_CACHE_MAX_MB);
  return Number.isFinite(configuredMegabytes) && configuredMegabytes >= 0
    ? configuredMegabytes * 1024 * 1024
    : DEFAULT_MAIL_BODY_CACHE_MAX_BYTES;
}

function mapAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    providerId: row.provider_id,
    displayName: row.display_name,
    emailAddress: row.email_address,
    color: row.color,
    syncMode: row.sync_mode,
    syncStatus: row.sync_status,
    syncError: row.sync_error ?? undefined,
    lastSyncAt: row.last_sync_at ?? undefined,
  };
}

function accountColor(id: string): string {
  const palette = ["#86bdf5", "#f0a05e", "#91d1a3", "#c2a7ef", "#ef8d9a"];
  const value = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return palette[value % palette.length]!;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { return jsonRecord(JSON.parse(value) as unknown); } catch { return {}; }
  }
  return {};
}

function jsonArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return jsonArray(JSON.parse(value) as unknown); } catch { return []; }
  }
  return [];
}

function htmlToPlainText(value: string | null): string {
  return (value ?? "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
