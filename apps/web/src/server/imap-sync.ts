import {
  ImapFlow,
  type FetchMessageObject,
  type ListResponse,
  type MessageAddressObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";

import {
  finishSyncRun,
  getAccount,
  getSyncCursor,
  loadImapSmtpCredential,
  removeMissingFolderMessages,
  resetFolderSyncState,
  saveSyncCursor,
  setSyncStatus,
  startSyncRun,
  updateMessageFlags,
  upsertFolder,
  upsertMessage,
  type MessageRecord,
  type SyncMode,
} from "./mail-repository";

declare global {
  var kalenderActiveMailSyncs: Set<string> | undefined;
}

export interface SyncSummary {
  readonly accountId: string;
  readonly foldersProcessed: number;
  readonly messagesProcessed: number;
  readonly messagesReconciled: number;
  readonly messagesRemoved: number;
  readonly hasMoreHistory: boolean;
}

export class MailSyncAlreadyRunningError extends Error {
  constructor() {
    super("该账户正在同步");
    this.name = "MailSyncAlreadyRunningError";
  }
}

export async function runInitialImapSync(
  accountId: string,
  maximumMessages = 100,
): Promise<SyncSummary> {
  return runImapSync(accountId, maximumMessages);
}

export async function runImapSync(
  accountId: string,
  maximumMessages = 100,
): Promise<SyncSummary> {
  const activeSyncs = globalThis.kalenderActiveMailSyncs ??= new Set<string>();
  if (activeSyncs.has(accountId)) throw new MailSyncAlreadyRunningError();
  activeSyncs.add(accountId);
  try {
    return await executeImapSync(accountId, Math.max(1, Math.min(maximumMessages, 500)));
  } finally {
    activeSyncs.delete(accountId);
  }
}

export function isMailAccountSyncing(accountId: string): boolean {
  return globalThis.kalenderActiveMailSyncs?.has(accountId) ?? false;
}

async function executeImapSync(accountId: string, maximumMessages: number): Promise<SyncSummary> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("Account was not found");
  if (account.syncStatus === "paused") throw new Error("邮箱账户已暂停");
  const credential = await loadImapSmtpCredential(accountId);
  const runId = await startSyncRun(accountId, account.syncMode);
  await setSyncStatus(accountId, "syncing");

  let foldersProcessed = 0;
  let messagesProcessed = 0;
  let messagesReconciled = 0;
  let messagesRemoved = 0;
  let hasMoreHistory = false;
  const client = new ImapFlow({
    host: credential.imap.host,
    port: credential.imap.port,
    secure: credential.imap.secure,
    servername: credential.imap.host,
    auth: { user: credential.imap.username, pass: credential.imap.password },
    logger: false,
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 30_000,
    maxLineLength: 2 * 1024 * 1024,
    maxLiteralSize: 25 * 1024 * 1024,
    tls: { rejectUnauthorized: true, servername: credential.imap.host },
  });

  try {
    await client.connect();
    const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
    const orderedFolders = [...folders].sort((left, right) => folderPriority(left) - folderPriority(right));
    for (const [sortOrder, folder] of folders.entries()) {
      await upsertFolder(accountId, {
        id: folderLocalId(accountId, folder.path),
        providerFolderId: folder.path,
        name: folder.name || folder.path,
        role: folderRole(folder),
        parentId: folder.parentPath ? folderLocalId(accountId, folder.parentPath) : undefined,
        unreadCount: folder.status?.unseen,
        totalCount: folder.status?.messages,
        sortOrder,
      });
      foldersProcessed += 1;
    }

    const cutoff = syncCutoff(account.syncMode);
    for (const folder of orderedFolders) {
      if (maximumMessages - messagesProcessed <= 0) {
        hasMoreHistory = true;
        break;
      }
      if (folder.flags.has("\\Noselect")) continue;
      const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
      const uidValidity = mailbox.uidValidity.toString();
      let cursor = await getSyncCursor(accountId, folder.path);
      if (cursor && cursor.uidValidity !== uidValidity) {
        await resetFolderSyncState(accountId, folder.path);
        cursor = undefined;
      }

      if (!cursor) {
        const matchingUids = (await searchUids(client, cutoff ? { since: cutoff } : { all: true }))
          .sort((left, right) => right - left);
        const selected = matchingUids.slice(0, maximumMessages - messagesProcessed);
        messagesProcessed += await fetchAndStore(client, accountId, folder.path, selected);
        const folderHasMore = selected.length < matchingUids.length;
        hasMoreHistory ||= folderHasMore;
        await saveSyncCursor(
          accountId,
          folder.path,
          uidValidity,
          Math.max(0, mailbox.uidNext - 1),
          selected.at(-1),
          !folderHasMore,
        );
        const reconciliation = await reconcileRecentFolderState(
          client,
          accountId,
          folder.path,
          Math.max(0, mailbox.uidNext - 1),
        );
        messagesReconciled += reconciliation.reconciled;
        messagesRemoved += reconciliation.removed;
        continue;
      }

      let lastUid = cursor.lastUid;
      let backfillBeforeUid = cursor.backfillBeforeUid;
      let initialComplete = cursor.initialComplete;
      if (lastUid === 0 && initialComplete) lastUid = Math.max(0, mailbox.uidNext - 1);

      const newUids = (await searchUids(client, { uid: `${lastUid + 1}:*` }))
        .filter((uid) => uid > lastUid)
        .sort((left, right) => left - right);
      const selectedNew = newUids.slice(0, maximumMessages - messagesProcessed);
      messagesProcessed += await fetchAndStore(client, accountId, folder.path, selectedNew);
      lastUid = selectedNew.at(-1) ?? lastUid;
      const hasMoreNew = selectedNew.length < newUids.length;
      hasMoreHistory ||= hasMoreNew;

      if (!hasMoreNew && !initialComplete && messagesProcessed < maximumMessages) {
        const beforeUid = backfillBeforeUid ?? Math.max(1, cursor.lastUid > 0 ? cursor.lastUid + 1 : mailbox.uidNext);
        if (beforeUid <= 1) {
          initialComplete = true;
        } else {
          const historyQuery: SearchObject = { uid: `1:${beforeUid - 1}` };
          if (cutoff) historyQuery.since = cutoff;
          const olderUids = (await searchUids(client, historyQuery)).sort((left, right) => right - left);
          const selectedOlder = olderUids.slice(0, maximumMessages - messagesProcessed);
          messagesProcessed += await fetchAndStore(client, accountId, folder.path, selectedOlder);
          backfillBeforeUid = selectedOlder.at(-1) ?? backfillBeforeUid;
          const hasMoreOlder = selectedOlder.length < olderUids.length;
          initialComplete = !hasMoreOlder;
          hasMoreHistory ||= hasMoreOlder;
        }
      }

      hasMoreHistory ||= !initialComplete;
      await saveSyncCursor(
        accountId,
        folder.path,
        uidValidity,
        lastUid,
        backfillBeforeUid,
        initialComplete,
      );
      const reconciliation = await reconcileRecentFolderState(
        client,
        accountId,
        folder.path,
        Math.max(0, mailbox.uidNext - 1),
      );
      messagesReconciled += reconciliation.reconciled;
      messagesRemoved += reconciliation.removed;
    }

    await setSyncStatus(accountId, "ready");
    await finishSyncRun(runId, "succeeded", foldersProcessed, messagesProcessed);
    return {
      accountId,
      foldersProcessed,
      messagesProcessed,
      messagesReconciled,
      messagesRemoved,
      hasMoreHistory,
    };
  } catch (error) {
    const message = publicSyncError(error);
    await setSyncStatus(accountId, "error", message);
    await finishSyncRun(runId, "failed", foldersProcessed, messagesProcessed, message);
    throw new Error(message);
  } finally {
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      client.close();
    }
  }
}

async function reconcileRecentFolderState(
  client: ImapFlow,
  accountId: string,
  folderPath: string,
  latestUid: number,
): Promise<{ readonly reconciled: number; readonly removed: number }> {
  if (latestUid <= 0) return { reconciled: 0, removed: 0 };
  const minimumUid = Math.max(1, latestUid - 199);
  const remoteUids = await searchUids(client, { uid: `${minimumUid}:${latestUid}` });
  const remoteUidSet = new Set(remoteUids);
  let reconciled = 0;
  if (remoteUids.length > 0) {
    const messages = await client.fetchAll([...remoteUids], { uid: true, flags: true }, { uid: true });
    for (const message of messages) {
      if (await updateMessageFlags(
        accountId,
        folderPath,
        message.uid,
        message.flags?.has("\\Seen") ?? false,
        message.flags?.has("\\Flagged") ?? false,
      )) reconciled += 1;
    }
  }
  const removed = await removeMissingFolderMessages(
    accountId,
    folderPath,
    minimumUid,
    latestUid,
    remoteUidSet,
  );
  return { reconciled, removed };
}

async function searchUids(client: ImapFlow, query: SearchObject): Promise<number[]> {
  const result = await client.search(query, { uid: true });
  return result === false ? [] : [...result];
}

async function fetchAndStore(
  client: ImapFlow,
  accountId: string,
  folderPath: string,
  uids: readonly number[],
): Promise<number> {
  if (uids.length === 0) return 0;
  const fetched = await client.fetchAll(
    [...uids],
    { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, threadId: true },
    { uid: true },
  );
  for (const message of fetched) {
    await upsertMessage(accountId, toMessageRecord(accountId, folderPath, message));
  }
  return fetched.length;
}

function toMessageRecord(accountId: string, folderPath: string, message: FetchMessageObject): MessageRecord {
  const envelope = message.envelope;
  const id = messageLocalId(accountId, folderPath, message.uid);
  const threadId = message.threadId
    ? `${accountId}:thread:${Buffer.from(message.threadId).toString("base64url")}`
    : id;
  const sender = addresses(envelope?.from)[0] ?? { address: "unknown@invalid.local" };
  return {
    id,
    threadId,
    providerMessageId: envelope?.messageId ?? String(message.uid),
    providerUid: message.uid,
    providerFolderId: folderPath,
    subject: envelope?.subject ?? "(无主题)",
    from: sender,
    to: addresses(envelope?.to),
    cc: addresses(envelope?.cc),
    sentAt: isoDate(envelope?.date ?? message.internalDate),
    receivedAt: isoDate(message.internalDate ?? envelope?.date),
    snippet: "",
    isRead: message.flags?.has("\\Seen") ?? false,
    isStarred: message.flags?.has("\\Flagged") ?? false,
    attachments: attachments(message.bodyStructure),
    sizeBytes: message.size,
  };
}

function addresses(input?: MessageAddressObject[]) {
  return (input ?? []).flatMap((address) =>
    address.address ? [{ address: address.address, name: address.name }] : [],
  );
}

function attachments(structure?: MessageStructureObject): readonly unknown[] {
  const output: { filename: string; contentType: string; sizeBytes: number; inline: boolean }[] = [];
  const visit = (node?: MessageStructureObject) => {
    if (!node) return;
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (filename || node.disposition?.toLocaleLowerCase() === "attachment") {
      output.push({
        filename: filename ?? `attachment-${output.length + 1}`,
        contentType: node.type,
        sizeBytes: node.size ?? 0,
        inline: node.disposition?.toLocaleLowerCase() === "inline",
      });
    }
    node.childNodes?.forEach(visit);
  };
  visit(structure);
  return output;
}

function folderRole(folder: ListResponse): string {
  const special = folder.specialUse?.toLocaleLowerCase();
  if (folder.path.toLocaleUpperCase() === "INBOX" || special === "\\inbox") return "inbox";
  if (special === "\\sent") return "sent";
  if (special === "\\drafts") return "drafts";
  if (special === "\\archive") return "archive";
  if (special === "\\all") return "all";
  if (special === "\\trash") return "trash";
  if (special === "\\junk") return "spam";
  return "custom";
}

function folderPriority(folder: ListResponse): number {
  const priorities: Record<string, number> = { inbox: 0, sent: 1, drafts: 2, archive: 3, all: 4, custom: 5, spam: 8, trash: 9 };
  return priorities[folderRole(folder)] ?? 5;
}

function syncCutoff(mode: SyncMode): Date | undefined {
  if (mode === "full") return undefined;
  const days = mode === "quick" ? 30 : 90;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function folderLocalId(accountId: string, path: string): string {
  return `${accountId}:folder:${Buffer.from(path).toString("base64url")}`;
}

function messageLocalId(accountId: string, path: string, uid: number): string {
  return `${accountId}:message:${Buffer.from(JSON.stringify([path, uid])).toString("base64url")}`;
}

function isoDate(value?: Date | string): string {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function publicSyncError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (/AUTH|EAUTH|LOGIN/i.test(code)) return "邮箱认证失败，请重新测试账户连接";
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ESOCKET/i.test(code)) return "无法连接邮件服务器，稍后可以重新同步";
  return "邮件同步失败";
}
