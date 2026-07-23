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
    snippet: "Storage integration works",
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
  const thread = await repository.listMailThread(`${account.id}:message:1`);
  assert(thread.length === 2 && thread[1]?.folderRole === "sent", "thread detail contains incoming and sent messages in order");
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
  assert(
    await repository.removeMissingFolderMessages(account.id, "INBOX", 1, 1, new Set([1])) === 0,
    "present remote message is preserved",
  );
  await repository.saveSyncCursor(account.id, "INBOX", "42", 100, 80, false);
  const cursor = await repository.getSyncCursor(account.id, "INBOX");
  assert(cursor?.uidValidity === "42", "sync cursor preserves UIDVALIDITY");
  assert(cursor?.lastUid === 100 && cursor.backfillBeforeUid === 80, "sync cursor preserves incremental positions");
  await repository.saveSyncCursor(account.id, "Archive", "43", 120, 60, true);
  await repository.reopenAccountHistoryBackfill(account.id);
  const reopenedCursor = await repository.getSyncCursor(account.id, "Archive");
  assert(reopenedCursor?.initialComplete === false, "expanding sync range reopens history backfill");
  assert(reopenedCursor?.backfillBeforeUid === 60, "history backfill resumes before the oldest indexed message");
  assert(
    await repository.removeMissingFolderMessages(account.id, "INBOX", 1, 1, new Set()) === 1,
    "missing remote message is removed from local index",
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
