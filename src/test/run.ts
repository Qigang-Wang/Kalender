import { MailProviderError } from "../mail/errors.js";
import { MailProviderRegistry } from "../mail/registry.js";
import { InMemoryMailProvider } from "../mail/testing/in-memory-mail-provider.js";
import { ImapSmtpMailProvider } from "../mail/providers/imap-smtp/imap-smtp-provider.js";
import type {
  ConnectedMailAccount,
  MailAddress,
  MailFolder,
  MailMessage,
  MailThread,
  ProviderContextFactory,
} from "../mail/types.js";
import { UnifiedMailService } from "../mail/unified-mail-service.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}. Expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function account(
  id: string,
  providerId: string,
  emailAddress: string,
): ConnectedMailAccount {
  return { id, providerId, emailAddress, enabled: true };
}

function folder(id: string, role: MailFolder["role"]): MailFolder {
  return { id, providerFolderId: id, name: role, role };
}

function seededMail(
  accountId: string,
  sender: MailAddress,
  receivedAt: string,
  subject: string,
): { message: MailMessage; thread: MailThread } {
  const messageId = `${accountId}-message-1`;
  const threadId = `${accountId}-thread-1`;
  const message: MailMessage = {
    id: messageId,
    providerMessageId: messageId,
    threadId,
    subject,
    from: sender,
    to: [{ address: `${accountId}@example.com` }],
    cc: [],
    bcc: [],
    sentAt: receivedAt,
    receivedAt,
    snippet: `${subject} snippet`,
    textBody: `${subject} body`,
    isRead: false,
    isStarred: false,
    folderIds: ["inbox"],
    labelIds: [],
    attachments: [],
  };
  const thread: MailThread = {
    id: threadId,
    providerThreadId: threadId,
    subject,
    snippet: message.snippet,
    participants: [sender],
    lastMessageAt: receivedAt,
    unreadCount: 1,
    messageIds: [messageId],
  };
  return { message, thread };
}

async function main(): Promise<void> {
  const gmail = new InMemoryMailProvider("gmail", "Gmail");
  const microsoft = new InMemoryMailProvider("microsoft", "Microsoft 365");
  const privateAccount = account("private", "gmail", "me@gmail.test");
  const workAccount = account("work", "microsoft", "me@company.test");
  const privateMail = seededMail(
    privateAccount.id,
    { address: "friend@example.test", name: "Friend" },
    "2026-07-20T09:00:00.000Z",
    "Private message",
  );
  const workMail = seededMail(
    workAccount.id,
    { address: "boss@example.test", name: "Boss" },
    "2026-07-20T10:00:00.000Z",
    "Work message",
  );

  gmail.seedAccount(privateAccount.id, {
    folders: [folder("inbox", "inbox"), folder("sent", "sent")],
    messages: [privateMail.message],
    threads: [privateMail.thread],
  });
  microsoft.seedAccount(workAccount.id, {
    folders: [folder("inbox", "inbox"), folder("sent", "sent")],
    messages: [workMail.message],
    threads: [workMail.thread],
  });

  const registry = new MailProviderRegistry();
  registry.register(gmail);
  registry.register(microsoft);
  equal(registry.list().length, 2, "both providers are registered");
  equal(registry.resolve(workAccount).metadata.id, "microsoft", "account routing");

  let duplicateRejected = false;
  try {
    registry.register(gmail);
  } catch (error) {
    duplicateRejected =
      error instanceof MailProviderError && error.code === "CONFLICT";
  }
  assert(duplicateRejected, "duplicate provider registration is rejected");

  const contextFactory: ProviderContextFactory = {
    create: async (connectedAccount, signal) => ({
      account: connectedAccount,
      signal,
      session: {
        kind: "oauth2",
        accessToken: `token-for-${connectedAccount.id}`,
        scopes: [],
      },
    }),
  };
  const service = new UnifiedMailService(registry, contextFactory);
  const connection = await service.testConnection(workAccount);
  assert(connection.ok, "connection test succeeds before account use");
  equal(connection.identity, workAccount.emailAddress, "connection identity is verified");
  assert(
    connection.checks.some(
      (check) => check.name === "authentication" && check.status === "passed",
    ),
    "connection test verifies authentication",
  );
  const inbox = await service.listUnifiedInbox([privateAccount, workAccount]);
  equal(inbox.failures.length, 0, "unified inbox has no provider failures");
  equal(inbox.items.length, 2, "unified inbox contains both accounts");
  equal(inbox.items[0]?.accountId, "work", "threads are sorted across accounts");
  equal(
    inbox.items[1]?.accountId,
    "private",
    "second provider result is preserved",
  );

  const sent = await service.sendMessage(workAccount, {
    to: [{ address: "customer@example.test" }],
    subject: "Follow-up",
    textBody: "Thanks for your time.",
    idempotencyKey: "follow-up-1",
  });
  equal(sent.from.address, workAccount.emailAddress, "send uses account identity");
  assert(sent.folderIds.includes("sent"), "sent message is placed in sent folder");

  const initialSync = await service.sync(privateAccount, { limit: 2 });
  equal(initialSync.changes.length, 2, "sync respects page size");
  assert(initialSync.hasMore, "sync exposes an independent continuation cursor");

  const disabledAccount = { ...privateAccount, enabled: false };
  let disabledRejected = false;
  try {
    await service.listThreads(disabledAccount);
  } catch (error) {
    disabledRejected =
      error instanceof MailProviderError && error.code === "INVALID_REQUEST";
  }
  assert(disabledRejected, "disabled accounts cannot execute provider operations");

  const imapSmtp = new ImapSmtpMailProvider();
  equal(imapSmtp.metadata.id, "imap-smtp", "IMAP/SMTP provider has a stable ID");
  assert(imapSmtp.capabilities.mail.send, "IMAP/SMTP provider declares sending support");
  assert(!imapSmtp.capabilities.mail.threads, "generic IMAP does not claim native thread support");

  let credentialsRequired = false;
  try {
    await imapSmtp.testConnection({
      account: account("imap-account", "imap-smtp", "me@example.test"),
      session: { kind: "basic", username: "me", password: "secret" },
    });
  } catch (error) {
    credentialsRequired =
      error instanceof MailProviderError && error.code === "AUTH_REQUIRED";
  }
  assert(credentialsRequired, "IMAP/SMTP rejects the wrong session type before networking");

  let invalidServerRejected = false;
  try {
    await imapSmtp.testConnection({
      account: account("imap-account", "imap-smtp", "me@example.test"),
      session: {
        kind: "imap_smtp",
        imap: { host: "", port: 993, secure: true, username: "me", password: "secret" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "me", password: "secret" },
      },
    });
  } catch (error) {
    invalidServerRejected =
      error instanceof MailProviderError && error.code === "INVALID_REQUEST";
  }
  assert(invalidServerRejected, "IMAP/SMTP validates server settings before networking");

  let redirectRejected = false;
  try {
    await imapSmtp.authorization.createAuthorizationRequest({ callbackUrl: "http://localhost/callback" });
  } catch (error) {
    redirectRejected =
      error instanceof MailProviderError && error.code === "UNSUPPORTED";
  }
  assert(redirectRejected, "password-based IMAP/SMTP does not expose an OAuth redirect");

  console.log("MailProvider tests passed");
}

await main();
