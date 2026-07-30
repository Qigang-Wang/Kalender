import { ImapFlow } from "imapflow";
import { moveExchangeMessage, updateExchangeMessageFlags } from "./exchange-mail";
import { isExchangeItemNotFoundError } from "./exchange-ews-client";

import {
  getAccount,
  getArchiveFolderPath,
  getMailFolder,
  getMessageMoveTargets,
  getTrashFolderPath,
  getMessageActionTarget,
  loadExchangeMailCredential,
  loadImapSmtpCredential,
  removeMessageFromIndex,
  updateMessageFlags,
} from "./mail-repository";
import type { MessageActionTarget } from "./mail-repository";

export type MailMessageAction = "mark-read" | "mark-unread" | "star" | "unstar" | "archive" | "delete" | "move";

export interface MailMessageActionResult {
  readonly action: MailMessageAction;
  readonly messageId: string;
  readonly isRead?: boolean;
  readonly isStarred?: boolean;
  readonly removedFromInbox: boolean;
  readonly alreadyRemoved?: boolean;
  readonly movedCount?: number;
  readonly destinationFolderId?: string;
}

export class MailMessageActionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "ACCOUNT_UNAVAILABLE" | "ARCHIVE_UNAVAILABLE" | "TRASH_UNAVAILABLE" | "MOVE_UNAVAILABLE" | "ACTION_BUSY" | "REMOTE_ERROR",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailMessageActionError";
  }
}

declare global {
  var kalenderActiveMessageActions: Set<string> | undefined;
}

export async function performMailMessageAction(
  messageId: string,
  action: MailMessageAction,
  destinationFolderId?: string,
): Promise<MailMessageActionResult> {
  const active = globalThis.kalenderActiveMessageActions ??= new Set<string>();
  if (active.has(messageId)) throw new MailMessageActionError("ACTION_BUSY", "这封邮件正在执行其他操作", 409);
  active.add(messageId);
  try {
    return await executeMailMessageAction(messageId, action, destinationFolderId);
  } finally {
    active.delete(messageId);
  }
}

async function executeMailMessageAction(
  messageId: string,
  action: MailMessageAction,
  destinationFolderId?: string,
): Promise<MailMessageActionResult> {
  const target = await getMessageActionTarget(messageId);
  if (!target) {
    if (action === "delete") return removedMessageResult(messageId, true);
    throw new MailMessageActionError("NOT_FOUND", "邮件不存在或已被移动", 404);
  }
  const account = await getAccount(target.accountId);
  if (!account || account.syncStatus === "paused") {
    throw new MailMessageActionError("ACCOUNT_UNAVAILABLE", "请先启用该邮箱账户", 409);
  }
  if (action === "move") return moveMailThreadFromFolder(messageId, target, account.providerId, destinationFolderId);
  const storedArchiveFolder = action === "archive" ? await getArchiveFolderPath(target.accountId) : undefined;
  const storedTrashFolder = action === "delete" ? await getTrashFolderPath(target.accountId) : undefined;
  if (action === "archive" && (!storedArchiveFolder || storedArchiveFolder === target.providerFolderId)) {
    throw new MailMessageActionError("ARCHIVE_UNAVAILABLE", "该邮箱没有可用的归档文件夹", 409);
  }
  if (action === "delete" && (!storedTrashFolder || storedTrashFolder === target.providerFolderId)) {
    throw new MailMessageActionError("TRASH_UNAVAILABLE", "该邮件已在已删除文件夹中，或邮箱没有可用的已删除文件夹", 409);
  }

  if (account.providerId === "exchange-ews") {
    let isRead = target.isRead;
    let isStarred = target.isStarred;
    if (action === "mark-read" || action === "mark-unread") isRead = action === "mark-read";
    if (action === "star" || action === "unstar") isStarred = action === "star";
    try {
      const credential = await loadExchangeMailCredential(target.accountId);
      if (action === "archive" || action === "delete") {
        const destination = action === "archive" ? storedArchiveFolder! : storedTrashFolder!;
        await moveExchangeMessage(credential, target.providerMessageId, destination, AbortSignal.timeout(30_000));
        await removeMessageFromIndex(messageId);
      } else {
        await updateExchangeMessageFlags(
          credential,
          target.providerMessageId,
          { isRead, isStarred },
          AbortSignal.timeout(30_000),
        );
        await updateMessageFlags(target.accountId, target.providerFolderId, target.providerUid, isRead, isStarred);
      }
      return {
        action,
        messageId,
        isRead: action === "archive" || action === "delete" ? undefined : isRead,
        isStarred: action === "archive" || action === "delete" ? undefined : isStarred,
        removedFromInbox: action === "archive" || action === "delete",
      };
    } catch (error) {
      if (error instanceof MailMessageActionError) throw error;
      if (action === "delete" && isExchangeItemNotFoundError(error)) {
        await removeMessageFromIndex(messageId);
        return removedMessageResult(messageId, true);
      }
      console.error("Exchange mail action failed", error);
      throw new MailMessageActionError("REMOTE_ERROR", "Exchange 没有完成该邮件操作，请稍后重试", 502);
    }
  }

  const credential = await loadImapSmtpCredential(target.accountId);
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
    const archiveFolder = action === "archive"
      ? (await client.list()).find((folder) =>
          folder.specialUse?.toLocaleLowerCase() === "\\archive" ||
          ["archive", "archiv"].includes(folder.name.toLocaleLowerCase()),
        )?.path
      : undefined;
    const trashFolder = action === "delete"
      ? (await client.list()).find((folder) =>
          folder.specialUse?.toLocaleLowerCase() === "\\trash" ||
          ["trash", "deleted items", "gelöschte elemente", "papierkorb"].includes(folder.name.toLocaleLowerCase()),
        )?.path
      : undefined;
    if (action === "archive" && (!archiveFolder || archiveFolder === target.providerFolderId)) {
      throw new MailMessageActionError("ARCHIVE_UNAVAILABLE", "该邮箱没有可用的归档文件夹", 409);
    }
    if (action === "delete" && (!trashFolder || trashFolder === target.providerFolderId)) {
      throw new MailMessageActionError("TRASH_UNAVAILABLE", "该邮件已在已删除文件夹中，或邮箱没有可用的已删除文件夹", 409);
    }
    await client.mailboxOpen(target.providerFolderId);
    let isRead = target.isRead;
    let isStarred = target.isStarred;
    if (action === "mark-read" || action === "mark-unread") {
      isRead = action === "mark-read";
      const changed = await (isRead
        ? client.messageFlagsAdd([target.providerUid], ["\\Seen"], { uid: true })
        : client.messageFlagsRemove([target.providerUid], ["\\Seen"], { uid: true }));
      if (!changed) throw new MailMessageActionError("NOT_FOUND", "邮件不存在或已被移动", 404);
      await updateMessageFlags(
        target.accountId,
        target.providerFolderId,
        target.providerUid,
        isRead,
        isStarred,
      );
    } else if (action === "star" || action === "unstar") {
      isStarred = action === "star";
      const changed = await (isStarred
        ? client.messageFlagsAdd([target.providerUid], ["\\Flagged"], { uid: true })
        : client.messageFlagsRemove([target.providerUid], ["\\Flagged"], { uid: true }));
      if (!changed) throw new MailMessageActionError("NOT_FOUND", "邮件不存在或已被移动", 404);
      await updateMessageFlags(
        target.accountId,
        target.providerFolderId,
        target.providerUid,
        isRead,
        isStarred,
      );
    } else {
      const destination = action === "archive" ? archiveFolder! : trashFolder!;
      const moved = await client.messageMove([target.providerUid], destination, { uid: true });
      if (!moved) throw new MailMessageActionError("NOT_FOUND", "邮件不存在或已被移动", 404);
      await removeMessageFromIndex(messageId);
    }
    return {
      action,
      messageId,
      isRead: action === "archive" || action === "delete" ? undefined : isRead,
      isStarred: action === "archive" || action === "delete" ? undefined : isStarred,
      removedFromInbox: action === "archive" || action === "delete",
    };
  } catch (error) {
    if (error instanceof MailMessageActionError) throw error;
    throw new MailMessageActionError("REMOTE_ERROR", "邮箱服务器没有完成该操作，请稍后重试", 502);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function removedMessageResult(messageId: string, alreadyRemoved = false): MailMessageActionResult {
  return {
    action: "delete",
    messageId,
    removedFromInbox: true,
    alreadyRemoved: alreadyRemoved || undefined,
  };
}

async function moveMailThreadFromFolder(
  messageId: string,
  anchor: MessageActionTarget,
  providerId: string,
  destinationFolderId?: string,
): Promise<MailMessageActionResult> {
  if (!destinationFolderId) throw new MailMessageActionError("MOVE_UNAVAILABLE", "请选择目标文件夹", 400);
  const destination = await getMailFolder(destinationFolderId);
  if (!destination || destination.accountId !== anchor.accountId || destination.role === "all") {
    throw new MailMessageActionError("MOVE_UNAVAILABLE", "目标文件夹不可用，邮件只能在同一邮箱账户内移动", 409);
  }
  if (destination.providerFolderId === anchor.providerFolderId) {
    throw new MailMessageActionError("MOVE_UNAVAILABLE", "邮件已经在这个文件夹中", 409);
  }
  const targets = await getMessageMoveTargets(messageId);
  if (!targets.length) throw new MailMessageActionError("NOT_FOUND", "邮件不存在或已被移动", 404);

  try {
    if (providerId === "exchange-ews") {
      const credential = await loadExchangeMailCredential(anchor.accountId);
      for (const target of targets) {
        await moveExchangeMessage(credential, target.providerMessageId, destination.providerFolderId, AbortSignal.timeout(30_000));
        await removeMessageFromIndex(target.id);
      }
    } else {
      const credential = await loadImapSmtpCredential(anchor.accountId);
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
        await client.mailboxOpen(anchor.providerFolderId);
        const moved = await client.messageMove(targets.map((target) => target.providerUid), destination.providerFolderId, { uid: true });
        if (!moved) throw new MailMessageActionError("NOT_FOUND", "邮件不存在或已被移动", 404);
        for (const target of targets) await removeMessageFromIndex(target.id);
      } finally {
        await client.logout().catch(() => undefined);
      }
    }
    return {
      action: "move",
      messageId,
      removedFromInbox: true,
      movedCount: targets.length,
      destinationFolderId,
    };
  } catch (error) {
    if (error instanceof MailMessageActionError) throw error;
    console.error("Mail move failed", error);
    throw new MailMessageActionError("REMOTE_ERROR", "邮箱服务器没有完成邮件移动，请稍后重试", 502);
  }
}
