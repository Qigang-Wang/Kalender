import { resolveExchangeInlineImages, sanitizeEmailHtml } from "./mail-body-service";
import {
  exchangeFolderLocalId,
  exchangeMessageLocalId,
  exchangeProviderUid,
  exchangeThreadLocalId,
  discoverExchangeMailbox,
  fetchExchangeMailMessages,
  syncExchangeMailFolder,
  type ExchangeMailMessage,
} from "./exchange-mail";
import { MailSyncAlreadyRunningError, type SyncSummary } from "./imap-sync";
import {
  finishSyncRun,
  getAccount,
  getExchangeMailSyncState,
  loadExchangeMailCredential,
  removeExchangeMessages,
  saveExchangeMailSyncState,
  saveMessageBodies,
  setSyncStatus,
  startSyncRun,
  upsertFolder,
  upsertMessages,
  updateExchangeMessageReadFlags,
  updateSyncRunProgress,
} from "./mail-repository";

export async function runExchangeMailSync(accountId: string, maximumMessages = 100): Promise<SyncSummary> {
  const activeSyncs = globalThis.kalenderActiveMailSyncs ??= new Set<string>();
  if (activeSyncs.has(accountId)) throw new MailSyncAlreadyRunningError();
  activeSyncs.add(accountId);
  try {
    return await executeExchangeMailSync(accountId, Math.max(1, Math.min(maximumMessages, 500)));
  } finally {
    activeSyncs.delete(accountId);
  }
}

async function executeExchangeMailSync(accountId: string, maximumMessages: number): Promise<SyncSummary> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("Account was not found");
  if (account.syncStatus === "paused") throw new Error("邮箱账户已暂停");
  const credential = await loadExchangeMailCredential(accountId);
  const runId = await startSyncRun(accountId, account.syncMode);
  await setSyncStatus(accountId, "syncing");
  let foldersProcessed = 0;
  let messagesProcessed = 0;
  let messagesReconciled = 0;
  let messagesRemoved = 0;
  let hasMoreHistory = false;
  try {
    const folders = await discoverExchangeMailbox(credential, AbortSignal.timeout(30_000));
    const localFolderIds = new Map(folders.map((folder) => [folder.folderId, exchangeFolderLocalId(accountId, folder.folderId)]));
    for (const folder of folders) {
      await upsertFolder(accountId, {
        id: localFolderIds.get(folder.folderId)!,
        providerFolderId: folder.folderId,
        name: folder.name,
        role: folder.role,
        parentId: folder.parentFolderId ? localFolderIds.get(folder.parentFolderId) : undefined,
        unreadCount: folder.unreadCount,
        totalCount: folder.totalCount,
        sortOrder: folder.sortOrder,
      });
    }
    const ordered = [...folders].sort((left, right) => folderPriority(left.role) - folderPriority(right.role));
    for (const folder of ordered) {
      const remaining = maximumMessages - messagesProcessed;
      if (remaining <= 0) {
        hasMoreHistory = true;
        break;
      }
      let state = await getExchangeMailSyncState(accountId, folder.folderId);
      if (!state?.latestSeeded) {
        const seeded = await fetchExchangeMailMessages(credential, folder, remaining, AbortSignal.timeout(45_000));
        await storeMessages(accountId, folder.folderId, seeded);
        messagesProcessed += seeded.length;
        state = { syncState: state?.syncState, latestSeeded: true, initialComplete: state?.initialComplete ?? false };
        await saveExchangeMailSyncState(accountId, folder.folderId, state);
        hasMoreHistory ||= (folder.totalCount ?? 0) > seeded.length;
        if (messagesProcessed >= maximumMessages) {
          foldersProcessed += 1;
          await updateSyncRunProgress(runId, foldersProcessed, messagesProcessed);
          continue;
        }
      } else if (!state.initialComplete) {
        // Keep the newest window fresh while the EWS initial SyncFolderItems cursor
        // is still walking older history, otherwise newly delivered mail would wait
        // until the entire mailbox backfill catches up.
        const recent = await fetchExchangeMailMessages(
          credential,
          folder,
          Math.min(25, maximumMessages - messagesProcessed),
          AbortSignal.timeout(45_000),
        );
        await storeMessages(accountId, folder.folderId, recent);
        messagesProcessed += recent.length;
        if (messagesProcessed >= maximumMessages) {
          hasMoreHistory = true;
          foldersProcessed += 1;
          await updateSyncRunProgress(runId, foldersProcessed, messagesProcessed);
          continue;
        }
      }
      const changes = await syncExchangeMailFolder(
        credential,
        folder,
        state.syncState,
        maximumMessages - messagesProcessed,
        AbortSignal.timeout(45_000),
      );
      await storeMessages(accountId, folder.folderId, changes.messages);
      messagesProcessed += changes.messages.length;
      messagesRemoved += await removeExchangeMessages(accountId, changes.deletedItemIds);
      messagesReconciled += await updateExchangeMessageReadFlags(
        accountId,
        changes.readFlagChanges.map((change) => ({
          providerMessageId: change.itemId,
          isRead: change.isRead,
        })),
      );
      await saveExchangeMailSyncState(accountId, folder.folderId, {
        syncState: changes.syncState,
        latestSeeded: true,
        initialComplete: changes.includesLastItem,
      });
      hasMoreHistory ||= !changes.includesLastItem;
      foldersProcessed += 1;
      await updateSyncRunProgress(runId, foldersProcessed, messagesProcessed);
    }
    await setSyncStatus(accountId, "ready");
    await finishSyncRun(runId, "succeeded", foldersProcessed, messagesProcessed);
    return {
      accountId,
      foldersProcessed,
      messagesProcessed,
      messagesReconciled,
      messagesRemoved,
      deepAuditRanges: 0,
      hasMoreHistory,
    };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Exchange 邮件同步失败";
    await setSyncStatus(accountId, "error", message);
    await finishSyncRun(runId, "failed", foldersProcessed, messagesProcessed, message);
    throw new Error(message);
  }
}

async function storeMessages(accountId: string, folderId: string, messages: readonly ExchangeMailMessage[]): Promise<void> {
  const records = messages.map((message) => {
    const id = exchangeMessageLocalId(accountId, message.itemId);
    return {
      id,
      threadId: exchangeThreadLocalId(accountId, message.conversationId, message.itemId),
      providerMessageId: message.itemId,
      providerUid: exchangeProviderUid(message.itemId),
      providerFolderId: folderId,
      subject: message.subject,
      from: message.from,
      to: message.to,
      cc: message.cc,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      snippet: message.snippet,
      isRead: message.isRead,
      isStarred: message.isStarred,
      attachments: message.attachments,
      sizeBytes: message.sizeBytes,
    };
  });
  await upsertMessages(accountId, records);
  const bodies = messages.flatMap((message, index) => {
    const id = records[index]!.id;
    const html = message.htmlBody
      ? sanitizeEmailHtml(resolveExchangeInlineImages(message.htmlBody, message.attachments, id))
      : undefined;
    return message.textBody || html
      ? [{ id, textBody: message.textBody, htmlBody: html, snippet: message.snippet }]
      : [];
  });
  await saveMessageBodies(bodies);
}

function folderPriority(role: string): number {
  return { inbox: 0, sent: 1, drafts: 2, archive: 3, other: 4, junk: 8, trash: 9 }[role] ?? 10;
}
