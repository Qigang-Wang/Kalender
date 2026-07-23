import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageAddressObject, type MessageStructureObject, type SearchObject } from "imapflow";
import * as nodemailer from "nodemailer";
import PostalMime, { type Address as PostalAddress } from "postal-mime";

import { MailProviderError } from "../../errors.js";
import type {
  AuthorizationCallbackInput,
  AuthorizationStartInput,
  ImapSmtpSession,
  ListThreadsInput,
  MailAddress,
  MailAttachment,
  MailFolder,
  MailFolderRole,
  MailMessage,
  MailProvider,
  MailSyncInput,
  MailSyncPage,
  MailThread,
  MailThreadDetails,
  Page,
  ProviderConnectionTestResult,
  ProviderContext,
  ProviderSession,
  SendMailInput,
  UpdateMessageInput,
} from "../../types.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export class ImapSmtpMailProvider implements MailProvider {
  readonly metadata = { id: "imap-smtp", displayName: "IMAP / SMTP" } as const;
  readonly capabilities = {
    authentication: "basic",
    mail: {
      folders: true,
      threads: false,
      attachments: true,
      drafts: false,
      send: true,
      modify: true,
      incrementalSync: true,
      pushNotifications: false,
    },
    calendar: { read: false, write: false, incrementalSync: false },
  } as const;

  readonly authorization = {
    createAuthorizationRequest: async (_input: AuthorizationStartInput) => {
      throw this.unsupported("IMAP/SMTP uses server credentials instead of an OAuth redirect");
    },
    exchangeAuthorizationCode: async (_input: AuthorizationCallbackInput) => {
      throw this.unsupported("IMAP/SMTP does not exchange authorization codes");
    },
    refreshSession: async (session: ProviderSession) => session,
    revokeSession: async (_session: ProviderSession) => undefined,
  };

  readonly mail = {
    listFolders: (context: ProviderContext) => this.listFolders(context),
    listThreads: (context: ProviderContext, input: ListThreadsInput) =>
      this.listThreads(context, input),
    getThread: (context: ProviderContext, threadId: string) =>
      this.getThread(context, threadId),
    sync: (context: ProviderContext, input: MailSyncInput) =>
      this.sync(context, input),
    sendMessage: (context: ProviderContext, input: SendMailInput) =>
      this.sendMessage(context, input),
    updateMessage: (context: ProviderContext, input: UpdateMessageInput) =>
      this.updateMessage(context, input),
  };

  async testConnection(context: ProviderContext): Promise<ProviderConnectionTestResult> {
    const startedAt = Date.now();
    const session = requireImapSmtpSession(context);
    const folders = await this.withImap(context, async (client) =>
      client.list({ statusQuery: { messages: true, unseen: true } }),
    );
    await this.verifySmtp(context, session);
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      identity: context.account.emailAddress,
      checks: [
        { name: "authentication", status: "passed" },
        { name: "mail_read", status: "passed", message: `${folders.length} folders available` },
        { name: "smtp_connection", status: "passed" },
        { name: "calendar_read", status: "skipped" },
      ],
    };
  }

  private async listFolders(context: ProviderContext): Promise<readonly MailFolder[]> {
    return this.withImap(context, async (client) => {
      const folders = await client.list({
        statusQuery: { messages: true, unseen: true },
      });
      return folders.map((folder) => this.toFolder(folder));
    });
  }

  private async listThreads(
    context: ProviderContext,
    input: ListThreadsInput,
  ): Promise<Page<MailThread>> {
    return this.withImap(context, async (client) => {
      const path = input.folderId ? decodeFolderId(input.folderId) : "INBOX";
      await client.mailboxOpen(path, { readOnly: true });
      const criteria: SearchObject = { all: true };
      if (input.unreadOnly) criteria.seen = false;
      if (input.after) criteria.since = new Date(input.after);
      if (input.before) criteria.before = new Date(input.before);
      if (input.query) criteria.text = input.query;
      const result = await client.search(criteria, { uid: true });
      const uids = result === false ? [] : [...result].sort((a, b) => b - a);
      const offset = parseOffsetCursor(input.cursor);
      const limit = normalizeLimit(input.limit);
      const pageUids = uids.slice(offset, offset + limit);
      const messages = pageUids.length
        ? await client.fetchAll(pageUids, summaryFetchQuery(), { uid: true })
        : [];
      const byUid = new Map(messages.map((message) => [message.uid, message]));
      const items = pageUids
        .map((uid) => byUid.get(uid))
        .filter((message): message is FetchMessageObject => message !== undefined)
        .map((message) => this.toThread(path, message));
      const nextOffset = offset + pageUids.length;
      return {
        items,
        nextCursor: nextOffset < uids.length ? String(nextOffset) : undefined,
      };
    });
  }

  private async getThread(
    context: ProviderContext,
    threadId: string,
  ): Promise<MailThreadDetails> {
    const locator = decodeMessageId(threadId);
    return this.withImap(context, async (client) => {
      await client.mailboxOpen(locator.path, { readOnly: true });
      const fetched = await client.fetchOne(
        String(locator.uid),
        { ...summaryFetchQuery(), source: true },
        { uid: true },
      );
      if (!fetched || !fetched.source) {
        throw this.notFound(context, "The selected IMAP message no longer exists");
      }
      const message = await this.toDetailedMessage(locator.path, fetched);
      return { thread: this.toThread(locator.path, fetched, message.snippet), messages: [message] };
    });
  }

  private async sync(
    context: ProviderContext,
    input: MailSyncInput,
  ): Promise<MailSyncPage> {
    return this.withImap(context, async (client) => {
      const path = "INBOX";
      const mailbox = await client.mailboxOpen(path, { readOnly: true });
      const cursor = parseSyncCursor(input.cursor);
      const uidValidity = mailbox.uidValidity.toString();
      const lastUid = cursor?.uidValidity === uidValidity ? cursor.lastUid : 0;
      const result = await client.search(
        lastUid > 0 ? { uid: `${lastUid + 1}:*` } : { all: true },
        { uid: true },
      );
      const allUids = result === false ? [] : [...result].sort((a, b) => a - b);
      const selected = allUids.slice(0, normalizeLimit(input.limit));
      const fetched = selected.length
        ? await client.fetchAll(selected, summaryFetchQuery(), { uid: true })
        : [];
      const changes = fetched.flatMap((item) => {
        const message = this.toMessage(path, item);
        const thread = this.toThread(path, item);
        return [
          { type: "upsert_message", message } as const,
          { type: "upsert_thread", thread } as const,
        ];
      });
      const nextLastUid = selected.at(-1) ?? lastUid;
      return {
        changes,
        nextCursor: `${uidValidity}:${nextLastUid}`,
        hasMore: selected.length < allUids.length,
      };
    });
  }

  private async sendMessage(
    context: ProviderContext,
    input: SendMailInput,
  ): Promise<MailMessage> {
    const session = requireImapSmtpSession(context);
    const transport = createSmtpTransport(session);
    const abort = () => transport.close();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      const from = input.from ?? {
        address: context.account.emailAddress,
        name: context.account.displayName,
      };
      const info = await transport.sendMail({
        from,
        to: [...input.to],
        cc: input.cc ? [...input.cc] : undefined,
        bcc: input.bcc ? [...input.bcc] : undefined,
        subject: input.subject,
        text: input.textBody,
        html: input.htmlBody,
        inReplyTo: input.inReplyToMessageId,
        attachments: input.attachments?.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: Buffer.from(attachment.contentBase64, "base64"),
          cid: attachment.contentId,
        })),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      const now = new Date().toISOString();
      const id = `smtp:${Buffer.from(info.messageId).toString("base64url")}`;
      return {
        id,
        providerMessageId: info.messageId,
        threadId: input.threadId ?? id,
        subject: input.subject,
        from,
        to: input.to,
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        sentAt: now,
        receivedAt: now,
        snippet: (input.textBody ?? "").slice(0, 180),
        textBody: input.textBody,
        htmlBody: input.htmlBody,
        isRead: true,
        isStarred: false,
        folderIds: [],
        labelIds: [],
        attachments: [],
        providerData: { accepted: info.accepted.map(String), rejected: info.rejected.map(String) },
      };
    } catch (error) {
      throw mapConnectionError(error, context);
    } finally {
      context.signal?.removeEventListener("abort", abort);
      transport.close();
    }
  }

  private async updateMessage(
    context: ProviderContext,
    input: UpdateMessageInput,
  ): Promise<MailMessage> {
    const locator = decodeMessageId(input.messageId);
    return this.withImap(context, async (client) => {
      await client.mailboxOpen(locator.path);
      const current = await client.fetchOne(String(locator.uid), summaryFetchQuery(), { uid: true });
      if (!current) throw this.notFound(context, "The selected IMAP message no longer exists");
      if (input.isRead !== undefined) {
        await (input.isRead
          ? client.messageFlagsAdd([locator.uid], ["\\Seen"], { uid: true })
          : client.messageFlagsRemove([locator.uid], ["\\Seen"], { uid: true }));
      }
      if (input.isStarred !== undefined) {
        await (input.isStarred
          ? client.messageFlagsAdd([locator.uid], ["\\Flagged"], { uid: true })
          : client.messageFlagsRemove([locator.uid], ["\\Flagged"], { uid: true }));
      }
      for (const label of input.addLabelIds ?? []) {
        await client.messageFlagsAdd([locator.uid], [label], { uid: true });
      }
      for (const label of input.removeLabelIds ?? []) {
        await client.messageFlagsRemove([locator.uid], [label], { uid: true });
      }
      if (input.moveToFolderId) {
        await client.messageMove([locator.uid], decodeFolderId(input.moveToFolderId), { uid: true });
      }
      const message = this.toMessage(locator.path, current);
      return {
        ...message,
        isRead: input.isRead ?? message.isRead,
        isStarred: input.isStarred ?? message.isStarred,
        folderIds: input.moveToFolderId ? [input.moveToFolderId] : message.folderIds,
      };
    });
  }

  private async withImap<T>(
    context: ProviderContext,
    operation: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const session = requireImapSmtpSession(context);
    const client = createImapClient(session);
    const abort = () => client.close();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      throw mapConnectionError(error, context);
    } finally {
      context.signal?.removeEventListener("abort", abort);
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        client.close();
      }
    }
  }

  private async verifySmtp(
    context: ProviderContext,
    session: ImapSmtpSession,
  ): Promise<void> {
    const transport = createSmtpTransport(session);
    const abort = () => transport.close();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      await transport.verify();
    } catch (error) {
      throw mapConnectionError(error, context);
    } finally {
      context.signal?.removeEventListener("abort", abort);
      transport.close();
    }
  }

  private toFolder(folder: ListResponse): MailFolder {
    return {
      id: encodeFolderId(folder.path),
      providerFolderId: folder.path,
      name: folder.name || folder.path,
      role: folderRole(folder),
      parentId: folder.parentPath ? encodeFolderId(folder.parentPath) : undefined,
      unreadCount: folder.status?.unseen,
      totalCount: folder.status?.messages,
      providerData: { specialUse: folder.specialUse },
    };
  }

  private toThread(path: string, fetched: FetchMessageObject, snippet = ""): MailThread {
    const id = encodeMessageId(path, fetched.uid);
    const envelope = fetched.envelope;
    return {
      id,
      providerThreadId: fetched.threadId ?? envelope?.messageId ?? id,
      subject: envelope?.subject ?? "(无主题)",
      snippet,
      participants: uniqueAddresses([
        ...imapAddresses(envelope?.from),
        ...imapAddresses(envelope?.to),
        ...imapAddresses(envelope?.cc),
      ]),
      lastMessageAt: toIsoDate(fetched.internalDate ?? envelope?.date),
      unreadCount: fetched.flags?.has("\\Seen") ? 0 : 1,
      messageIds: [id],
      providerData: { path, uid: fetched.uid, size: fetched.size },
    };
  }

  private toMessage(path: string, fetched: FetchMessageObject): MailMessage {
    const id = encodeMessageId(path, fetched.uid);
    const envelope = fetched.envelope;
    return {
      id,
      providerMessageId: envelope?.messageId ?? String(fetched.uid),
      threadId: id,
      subject: envelope?.subject ?? "(无主题)",
      from: imapAddresses(envelope?.from)[0] ?? { address: "unknown@invalid.local" },
      to: imapAddresses(envelope?.to),
      cc: imapAddresses(envelope?.cc),
      bcc: imapAddresses(envelope?.bcc),
      sentAt: toIsoDate(envelope?.date ?? fetched.internalDate),
      receivedAt: toIsoDate(fetched.internalDate ?? envelope?.date),
      snippet: "",
      isRead: fetched.flags?.has("\\Seen") ?? false,
      isStarred: fetched.flags?.has("\\Flagged") ?? false,
      folderIds: [encodeFolderId(path)],
      labelIds: [...(fetched.labels ?? [])],
      attachments: structureAttachments(fetched.bodyStructure),
      providerData: { path, uid: fetched.uid, size: fetched.size },
    };
  }

  private async toDetailedMessage(path: string, fetched: FetchMessageObject): Promise<MailMessage> {
    const summary = this.toMessage(path, fetched);
    const parsed = await PostalMime.parse(fetched.source!, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 30,
      maxHeadersSize: 256 * 1024,
    });
    const from = flattenPostalAddresses(parsed.from ? [parsed.from] : [])[0] ?? summary.from;
    return {
      ...summary,
      providerMessageId: parsed.messageId ?? summary.providerMessageId,
      subject: parsed.subject ?? summary.subject,
      from,
      to: flattenPostalAddresses(parsed.to),
      cc: flattenPostalAddresses(parsed.cc),
      bcc: flattenPostalAddresses(parsed.bcc),
      sentAt: toIsoDate(parsed.date ?? summary.sentAt),
      snippet: (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
      textBody: parsed.text,
      htmlBody: parsed.html,
      attachments: parsed.attachments.map((attachment, index) => ({
        id: `${summary.id}:attachment:${index + 1}`,
        filename: attachment.filename ?? `attachment-${index + 1}`,
        contentType: attachment.mimeType,
        sizeBytes: byteLength(attachment.content),
        inline: attachment.disposition === "inline",
        contentId: attachment.contentId,
      })),
    };
  }

  private unsupported(message: string): MailProviderError {
    return new MailProviderError("UNSUPPORTED", message, { providerId: this.metadata.id });
  }

  private notFound(context: ProviderContext, message: string): MailProviderError {
    return new MailProviderError("NOT_FOUND", message, {
      providerId: this.metadata.id,
      accountId: context.account.id,
    });
  }
}

export function requireImapSmtpSession(context: ProviderContext): ImapSmtpSession {
  if (context.session.kind !== "imap_smtp") {
    throw new MailProviderError("AUTH_REQUIRED", "IMAP/SMTP credentials are required", {
      providerId: context.account.providerId,
      accountId: context.account.id,
    });
  }
  for (const [name, server] of [["IMAP", context.session.imap], ["SMTP", context.session.smtp]] as const) {
    if (!server.host || !server.username || !server.password || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
      throw new MailProviderError("INVALID_REQUEST", `${name} connection settings are incomplete`, {
        providerId: context.account.providerId,
        accountId: context.account.id,
      });
    }
  }
  return context.session;
}

function createImapClient(session: ImapSmtpSession): ImapFlow {
  return new ImapFlow({
    host: session.imap.host,
    port: session.imap.port,
    secure: session.imap.secure,
    servername: session.imap.host,
    auth: { user: session.imap.username, pass: session.imap.password },
    logger: false,
    connectionTimeout: DEFAULT_TIMEOUT_MS,
    greetingTimeout: DEFAULT_TIMEOUT_MS,
    socketTimeout: 30_000,
    maxLineLength: 2 * 1024 * 1024,
    maxLiteralSize: MAX_MESSAGE_BYTES,
    tls: { rejectUnauthorized: true, servername: session.imap.host },
  });
}

function createSmtpTransport(session: ImapSmtpSession) {
  return nodemailer.createTransport({
    host: session.smtp.host,
    port: session.smtp.port,
    secure: session.smtp.secure,
    auth: { user: session.smtp.username, pass: session.smtp.password },
    connectionTimeout: DEFAULT_TIMEOUT_MS,
    greetingTimeout: DEFAULT_TIMEOUT_MS,
    socketTimeout: 30_000,
    tls: { rejectUnauthorized: true, servername: session.smtp.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function summaryFetchQuery() {
  return { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, threadId: true, labels: true } as const;
}

function encodeFolderId(path: string): string {
  return `imap-folder:${Buffer.from(path, "utf8").toString("base64url")}`;
}

function decodeFolderId(id: string): string {
  if (!id.startsWith("imap-folder:")) {
    throw new MailProviderError("INVALID_REQUEST", "Invalid IMAP folder identifier");
  }
  return Buffer.from(id.slice("imap-folder:".length), "base64url").toString("utf8");
}

function encodeMessageId(path: string, uid: number): string {
  return `imap-message:${Buffer.from(JSON.stringify([path, uid]), "utf8").toString("base64url")}`;
}

function decodeMessageId(id: string): { path: string; uid: number } {
  try {
    if (!id.startsWith("imap-message:")) throw new Error("prefix");
    const decoded = JSON.parse(Buffer.from(id.slice("imap-message:".length), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || typeof decoded[0] !== "string" || !Number.isSafeInteger(decoded[1]) || Number(decoded[1]) < 1) throw new Error("shape");
    return { path: decoded[0], uid: Number(decoded[1]) };
  } catch {
    throw new MailProviderError("INVALID_REQUEST", "Invalid IMAP message identifier");
  }
}

function folderRole(folder: ListResponse): MailFolderRole {
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

function imapAddresses(addresses?: MessageAddressObject[]): MailAddress[] {
  return (addresses ?? []).flatMap((address) =>
    address.address ? [{ address: address.address, name: address.name }] : [],
  );
}

function flattenPostalAddresses(addresses?: PostalAddress[]): MailAddress[] {
  return (addresses ?? []).flatMap((address) => {
    if (address.address) return [{ address: address.address, name: address.name }];
    return (address.group ?? []).map((member) => ({ address: member.address, name: member.name }));
  });
}

function uniqueAddresses(addresses: readonly MailAddress[]): readonly MailAddress[] {
  const unique = new Map<string, MailAddress>();
  for (const address of addresses) unique.set(address.address.toLocaleLowerCase(), address);
  return [...unique.values()];
}

function structureAttachments(structure?: MessageStructureObject): MailAttachment[] {
  const result: MailAttachment[] = [];
  const visit = (node: MessageStructureObject | undefined) => {
    if (!node) return;
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (filename || node.disposition?.toLocaleLowerCase() === "attachment") {
      result.push({
        id: node.part ?? `part-${result.length + 1}`,
        filename: filename ?? `attachment-${result.length + 1}`,
        contentType: node.type,
        sizeBytes: node.size ?? 0,
        inline: node.disposition?.toLocaleLowerCase() === "inline",
        contentId: node.id,
      });
    }
    node.childNodes?.forEach(visit);
  };
  visit(structure);
  return result;
}

function parseOffsetCursor(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MailProviderError("INVALID_REQUEST", "Invalid IMAP pagination cursor");
  }
  return value;
}

function parseSyncCursor(cursor?: string): { uidValidity: string; lastUid: number } | undefined {
  if (!cursor) return undefined;
  const [uidValidity, rawUid, ...rest] = cursor.split(":");
  const lastUid = Number.parseInt(rawUid ?? "", 10);
  if (!uidValidity || rest.length || !Number.isSafeInteger(lastUid) || lastUid < 0) {
    throw new MailProviderError("INVALID_REQUEST", "Invalid IMAP sync cursor");
  }
  return { uidValidity, lastUid };
}

function normalizeLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? 50, 100));
}

function toIsoDate(value?: Date | string): string {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === "string") return Buffer.byteLength(content);
  return content.byteLength;
}

function mapConnectionError(error: unknown, context: ProviderContext): MailProviderError {
  if (error instanceof MailProviderError) return error;
  if (context.signal?.aborted) {
    return new MailProviderError("CANCELLED", "Mail server connection was cancelled", {
      providerId: context.account.providerId,
      accountId: context.account.id,
    });
  }
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const responseCode = typeof error === "object" && error !== null && "responseCode" in error ? Number(error.responseCode) : undefined;
  if (/AUTH|EAUTH|LOGIN/i.test(code) || responseCode === 535) {
    return new MailProviderError("AUTH_REQUIRED", "The mail server rejected the username, password, or app password", {
      providerId: context.account.providerId,
      accountId: context.account.id,
      cause: error,
    });
  }
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ESOCKET|ECONNECTION/i.test(code)) {
    return new MailProviderError("NETWORK_ERROR", "Unable to reach the mail server", {
      retryable: true,
      providerId: context.account.providerId,
      accountId: context.account.id,
      cause: error,
    });
  }
  return new MailProviderError("REMOTE_ERROR", "The mail server rejected the operation", {
    providerId: context.account.providerId,
    accountId: context.account.id,
    cause: error,
  });
}
