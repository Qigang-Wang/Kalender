import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-storage-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const repository = await import("./mail-repository");
  const { getDatabase } = await import("./database");
  try {
  const password = `test-secret-${randomUUID()}`;
  const account = await repository.saveImapSmtpAccount({
    displayName: "Storage Test",
    emailAddress: "storage@example.test",
    syncMode: "recommended",
    credential: {
      kind: "imap_smtp",
      imap: { host: "imap.example.test", port: 993, secure: true, username: "storage@example.test", password },
      smtp: { host: "smtp.example.test", port: 465, secure: true, username: "storage@example.test", password },
    },
  });
  const restored = await repository.loadImapSmtpCredential(account.id);
  assert(restored.imap.password === password, "encrypted credential round trip");
  const reconfigured = await repository.saveImapSmtpAccount({
    accountId: account.id,
    displayName: "Storage Test Updated",
    emailAddress: "storage@example.test",
    syncMode: "full",
    credential: restored,
  });
  assert(reconfigured.id === account.id, "reconfiguration preserves account identity");
  assert(reconfigured.syncMode === "full", "reconfiguration updates sync range");
  assert(
    (await repository.loadImapSmtpCredential(account.id)).imap.password === password,
    "reconfiguration can retain the encrypted password",
  );
  const publicSettings = await repository.getPublicImapSmtpSettings(account.id);
  assert(publicSettings.imap.host === "imap.example.test", "public settings include server host");
  assert(!("password" in publicSettings.imap), "public settings never expose password");

  const database = await getDatabase();
  const encrypted = await database.query<{ encrypted_payload: string }>(
    "SELECT encrypted_payload FROM encrypted_credentials WHERE account_id = $1",
    [account.id],
  );
  assert(!encrypted.rows[0]?.encrypted_payload.includes(password), "password is not stored in plaintext");

  await repository.upsertFolder(account.id, {
    id: `${account.id}:folder:inbox`,
    providerFolderId: "INBOX",
    name: "Inbox",
    role: "inbox",
    unreadCount: 1,
    totalCount: 1,
  });
  const projectFolderId = `${account.id}:folder:projects`;
  const secondFolderId = `${account.id}:folder:second`;
  const childFolderId = `${account.id}:folder:projects-child`;
  await repository.upsertFolder(account.id, {
    id: projectFolderId,
    providerFolderId: "Projects",
    name: "Projects",
    role: "custom",
    sortOrder: 20,
  });
  await repository.upsertFolder(account.id, {
    id: secondFolderId,
    providerFolderId: "Second",
    name: "Second",
    role: "custom",
    sortOrder: 21,
  });
  await repository.upsertFolder(account.id, {
    id: childFolderId,
    providerFolderId: "Projects/Child",
    name: "Child",
    role: "custom",
    parentId: projectFolderId,
    sortOrder: 22,
  });
  await repository.updateFolderManualOrder(account.id, undefined, [secondFolderId, projectFolderId]);
  const manuallyOrdered = await repository.listMailFolders();
  assert(manuallyOrdered.find((folder) => folder.id === secondFolderId)?.manualSortOrder === 0, "manual folder order is persisted");
  assert(manuallyOrdered.find((folder) => folder.id === projectFolderId)?.manualSortOrder === 1, "all custom siblings receive a manual order");
  await repository.upsertFolder(account.id, {
    id: `${account.id}:folder:archive`,
    providerFolderId: "Archive",
    name: "Archive",
    role: "archive",
    unreadCount: 0,
    totalCount: 0,
  });
  await repository.upsertFolder(account.id, {
    id: `${account.id}:folder:sent`,
    providerFolderId: "Sent",
    name: "Sent",
    role: "sent",
    unreadCount: 0,
    totalCount: 1,
  });
  await repository.upsertMessage(account.id, {
    id: `${account.id}:message:1`,
    threadId: `${account.id}:thread:1`,
    providerMessageId: "<storage-test@example.test>",
    providerUid: 1,
    providerFolderId: "INBOX",
    subject: "Encrypted storage test",
    from: { address: "sender@example.test", name: "Sender" },
    to: [{ address: "storage@example.test" }],
    cc: [],
    sentAt: "2026-07-20T12:00:00.000Z",
    receivedAt: "2026-07-20T12:00:00.000Z",
    snippet: "Storage integration works \ud83d",
    isRead: false,
    isStarred: false,
    attachments: [],
  });
  await repository.upsertMessage(account.id, {
    id: `${account.id}:message:2`,
    threadId: `${account.id}:thread:1`,
    providerMessageId: "<storage-reply@example.test>",
    providerUid: 2,
    providerFolderId: "Sent",
    subject: "Re: Encrypted storage test",
    from: { address: "storage@example.test", name: "Storage" },
    to: [{ address: "sender@example.test" }],
    cc: [],
    sentAt: "2026-07-20T12:05:00.000Z",
    receivedAt: "2026-07-20T12:05:00.000Z",
    snippet: "Threaded reply",
    isRead: true,
    isStarred: false,
    attachments: [],
  });
  const inbox = await repository.listInbox();
  assert(inbox.length === 1, "stored inbox message is returned");
  assert(inbox[0]?.threadCount === 2, "inbox collapses a conversation into one row with a message count");
  const unreadSummary = await repository.listUnreadInboxSummary();
  assert(
    unreadSummary.total === 1 && unreadSummary.items[0]?.id === `${account.id}:message:1`,
    "unread inbox summary returns the newest unread thread without loading the full inbox",
  );
  const thread = await repository.listMailThread(`${account.id}:message:1`);
  assert(thread.length === 2 && thread[1]?.folderRole === "sent", "thread detail contains incoming and sent messages in order");
  assert(
    thread[0]?.snippet === "Storage integration works \ufffd",
    "mail batches repair isolated UTF-16 surrogates before PostgreSQL JSON storage",
  );
  const selfAddresses = await repository.listAccountSelfAddresses(account.id);
  assert(
    selfAddresses.length === 1 && selfAddresses[0] === "storage@example.test",
    "sent-folder sender addresses are exposed as account aliases",
  );
  assert(inbox[0]?.accountId === account.id, "inbox message retains account identity");
  assert(inbox[0]?.canArchive, "inbox reports an available archive destination");
  assert(await repository.getArchiveFolderPath(account.id) === "Archive", "archive destination is resolved");
  const actionTarget = await repository.getMessageActionTarget(`${account.id}:message:1`);
  assert(actionTarget?.providerUid === 1 && !actionTarget.isRead, "message action target preserves remote locator and flags");
  const moveTargets = await repository.getMessageMoveTargets(`${account.id}:message:1`);
  assert(
    moveTargets.length === 1 && moveTargets[0]?.providerFolderId === "INBOX",
    "moving a collapsed thread only targets messages from its current source folder",
  );
  assert(await repository.updateMessageFlags(account.id, "INBOX", 1, true, true), "message flags can be reconciled");
  const updatedInbox = await repository.listInbox();
  assert(updatedInbox[0]?.isRead && updatedInbox[0]?.isStarred, "read and starred state is persisted");
  assert((await repository.listUnreadInboxSummary()).total === 0, "unread inbox summary follows stored read state");
  const uncachedBody = await repository.getStoredMessageBody(`${account.id}:message:1`);
  assert(uncachedBody && !uncachedBody.loadedAt, "message body starts uncached");
  const cachedBody = await repository.saveMessageBody(
    `${account.id}:message:1`,
    "Safe text body",
    "<p>Safe HTML body</p>",
    "Safe text body",
  );
  assert(cachedBody?.textBody === "Safe text body", "text body is cached");
  assert(cachedBody?.htmlBody === "<p>Safe HTML body</p>", "HTML body is cached");
  assert(Boolean(cachedBody?.loadedAt), "body cache records its load time");
  assert(cachedBody?.cacheVersion === repository.MAIL_BODY_CACHE_VERSION, "body cache records the current sanitizer version");
  assert((await repository.listInbox())[0]?.snippet === "Safe text body", "body preview updates the inbox");
  const repairedBody = await repository.saveMessageBody(
    `${account.id}:message:1`,
    "Damaged emoji \ud83d",
    "<p>Damaged emoji \ud83d</p>",
    "Damaged emoji \ud83d",
  );
  assert(
    repairedBody?.textBody === "Damaged emoji \ufffd"
      && repairedBody.htmlBody === "<p>Damaged emoji \ufffd</p>"
      && repairedBody.snippet === "Damaged emoji \ufffd",
    "mail body batches repair isolated UTF-16 surrogates",
  );
  const capacityCleanup = await repository.cleanupMailBodyCache({
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxBytes: 1,
    targetBytes: 0,
  });
  assert(capacityCleanup.evictedEntries === 1 && capacityCleanup.bytesAfter === 0, "body cache evicts oldest entries above its size limit");
  await repository.saveMessageBody(
    `${account.id}:message:1`,
    "Safe text body",
    "<p>Safe HTML body</p>",
    "Safe text body",
  );
  const expiryCleanup = await repository.cleanupMailBodyCache({
    now: new Date(Date.now() + 1_000),
    maxAgeMs: 0,
  });
  assert(expiryCleanup.expiredEntries === 1, "body cache removes expired entries");
  assert(!(await repository.getStoredMessageBody(`${account.id}:message:1`))?.loadedAt, "body cache cleanup preserves metadata but clears cached content");
  assert(
    await repository.removeMissingFolderMessages(account.id, "INBOX", 1, 1, new Set([1])) === 0,
    "present remote message is preserved",
  );
  await repository.upsertMessages(account.id, [
    {
      id: `${account.id}:message:3`,
      threadId: `${account.id}:thread:3`,
      providerMessageId: "<batch-3@example.test>",
      providerUid: 3,
      providerFolderId: "INBOX",
      subject: "Batch insert three",
      from: { address: "three@example.test" },
      to: [{ address: "storage@example.test" }],
      cc: [],
      sentAt: "2026-07-22T12:00:00.000Z",
      receivedAt: "2026-07-22T12:00:00.000Z",
      snippet: "Third thread",
      isRead: true,
      isStarred: false,
      attachments: [],
    },
    {
      id: `${account.id}:message:4`,
      threadId: `${account.id}:thread:4`,
      providerMessageId: "<batch-4@example.test>",
      providerUid: 4,
      providerFolderId: "INBOX",
      subject: "Batch insert four",
      from: { address: "four@example.test" },
      to: [{ address: "storage@example.test" }],
      cc: [],
      sentAt: "2026-07-21T12:00:00.000Z",
      receivedAt: "2026-07-21T12:00:00.000Z",
      snippet: "Fourth thread",
      isRead: true,
      isStarred: false,
      attachments: [],
    },
  ]);
  const firstInboxPage = await repository.listInbox(1);
  const secondInboxPage = await repository.listInbox(1, undefined, {
    receivedAt: firstInboxPage[0]!.receivedAt,
    id: firstInboxPage[0]!.id,
  });
  assert(
    firstInboxPage[0]?.id === `${account.id}:message:3` && secondInboxPage[0]?.id === `${account.id}:message:4`,
    "inbox cursor pagination returns the next thread without repeating the previous page",
  );
  await repository.upsertMessages(account.id, [
    {
      id: `${account.id}:message:5`,
      threadId: `${account.id}:thread:5`,
      providerMessageId: "<batch-5@example.test>",
      providerUid: 5,
      providerFolderId: "INBOX",
      subject: "Batch conversation",
      from: { address: "five@example.test" },
      to: [{ address: "storage@example.test" }],
      cc: [],
      sentAt: "2026-07-19T11:00:00.000Z",
      receivedAt: "2026-07-19T11:00:00.000Z",
      snippet: "First batch conversation message",
      isRead: true,
      isStarred: false,
      attachments: [],
    },
    {
      id: `${account.id}:message:6`,
      threadId: `${account.id}:thread:5`,
      providerMessageId: "<batch-6@example.test>",
      providerUid: 6,
      providerFolderId: "INBOX",
      subject: "Batch conversation update",
      from: { address: "five@example.test" },
      to: [{ address: "storage@example.test" }],
      cc: [],
      sentAt: "2026-07-19T12:00:00.000Z",
      receivedAt: "2026-07-19T12:00:00.000Z",
      snippet: "Latest batch conversation message",
      isRead: true,
      isStarred: false,
      attachments: [],
    },
  ]);
  const batchThread = await repository.listMailThread(`${account.id}:message:5`);
  assert(
    batchThread.length === 2 && batchThread[1]?.snippet === "Latest batch conversation message",
    "one bulk write can insert multiple messages from the same thread",
  );
  assert(
    await repository.updateExchangeMessageReadFlags(account.id, [
      { providerMessageId: "<batch-3@example.test>", isRead: false },
      { providerMessageId: "<batch-4@example.test>", isRead: false },
    ]) === 2,
    "read-state reconciliation updates a batch in one repository call",
  );
  assert((await repository.listUnreadInboxSummary()).total === 2, "batch read-state reconciliation refreshes thread counters");
  await repository.updateExchangeMessageReadFlags(account.id, [
    { providerMessageId: "<batch-3@example.test>", isRead: true },
    { providerMessageId: "<batch-4@example.test>", isRead: true },
  ]);
  assert(
    (await repository.getMailNavigationSummary()).unreadCount === 1,
    "mail navigation summary reads only the lightweight folder unread total",
  );
  await repository.saveSyncCursor(account.id, "INBOX", "42", 100, 80, false);
  await repository.saveDeepReconcileCursor(account.id, "INBOX", 70);
  const cursor = await repository.getSyncCursor(account.id, "INBOX");
  assert(cursor?.uidValidity === "42", "sync cursor preserves UIDVALIDITY");
  assert(cursor?.lastUid === 100 && cursor.backfillBeforeUid === 80, "sync cursor preserves incremental positions");
  assert(cursor?.reconcileBeforeUid === 70 && Boolean(cursor.lastDeepReconcileAt), "sync cursor preserves deep audit progress");
  const syncRunId = await repository.startSyncRun(account.id, "recommended");
  await repository.updateSyncRunProgress(syncRunId, 2, 25);
  const runningSync = await repository.getLatestSyncRun(account.id);
  assert(
    runningSync?.status === "running" && runningSync.foldersProcessed === 2 && runningSync.messagesProcessed === 25,
    "latest sync run exposes live progress",
  );
  await repository.finishSyncRun(syncRunId, "succeeded", 3, 30);
  assert((await repository.getLatestSyncRun(account.id))?.status === "succeeded", "latest sync run exposes completion");
  await repository.saveSyncCursor(account.id, "Archive", "43", 120, 60, true);
  await repository.reopenAccountHistoryBackfill(account.id);
  const reopenedCursor = await repository.getSyncCursor(account.id, "Archive");
  assert(reopenedCursor?.initialComplete === false, "expanding sync range reopens history backfill");
  assert(reopenedCursor?.backfillBeforeUid === 60, "history backfill resumes before the oldest indexed message");
  assert(
    await repository.removeMissingFolderMessages(account.id, "INBOX", 1, 1, new Set()) === 1,
    "missing remote message is removed from local index",
  );
  const survivingThread = await repository.listMailThread(`${account.id}:message:2`);
  assert(
    survivingThread.length === 1 && survivingThread[0]?.folderRole === "sent",
    "removing a missing folder message preserves the rest of its conversation",
  );
  await repository.resetFolderSyncState(account.id, "INBOX");
  assert(!(await repository.getSyncCursor(account.id, "INBOX")), "folder reset removes invalid cursor");
  assert((await repository.listInbox()).length === 0, "folder reset removes messages with invalid UID state");
  await repository.removeFolderSubtreeFromIndex(projectFolderId);
  const foldersAfterSubtreeRemoval = await repository.listMailFolders();
  assert(!foldersAfterSubtreeRemoval.some((folder) => folder.id === projectFolderId || folder.id === childFolderId), "folder subtree removal clears parent and descendants");
  const paused = await repository.setAccountPaused(account.id, true);
  assert(paused?.syncStatus === "paused", "account can be paused");
  const resumed = await repository.setAccountPaused(account.id, false);
  assert(resumed?.syncStatus === "idle", "account can be resumed");
  assert(await repository.deleteAccount(account.id), "account can be deleted");
  assert((await repository.listAccounts()).length === 0, "deleted account is removed from account list");
  console.log("Encrypted storage tests passed");
    await database.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
