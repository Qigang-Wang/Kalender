import { ImapFlow, type ListResponse } from "imapflow";

import {
  createExchangeMailFolder,
  deleteExchangeMailFolder,
  moveExchangeMailFolder,
  renameExchangeMailFolder,
} from "./exchange-mail";
import { runMailSync } from "./mail-sync";
import {
  getAccount,
  getMailFolder,
  getTrashFolderPath,
  listMailFolders,
  loadExchangeMailCredential,
  loadImapSmtpCredential,
  removeFolderSubtreeFromIndex,
  type StoredMailFolder,
} from "./mail-repository";

export type MailFolderAction = "create" | "rename" | "move" | "delete";

export interface MailFolderActionResult {
  readonly action: MailFolderAction;
  readonly accountId: string;
  readonly refreshed: boolean;
}

export class MailFolderActionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "PROTECTED_FOLDER" | "INVALID_NAME" | "INVALID_MOVE" | "ACTION_BUSY" | "REMOTE_ERROR",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailFolderActionError";
  }
}

declare global {
  var kalenderActiveFolderActions: Set<string> | undefined;
}

export async function createMailFolder(input: {
  readonly accountId: string;
  readonly parentFolderId?: string;
  readonly name: string;
}): Promise<MailFolderActionResult> {
  const name = validateFolderName(input.name);
  const account = await getAccount(input.accountId);
  if (!account) throw new MailFolderActionError("NOT_FOUND", "邮箱账户不存在", 404);
  const parent = input.parentFolderId ? await getMailFolder(input.parentFolderId) : undefined;
  if (input.parentFolderId && (!parent || parent.accountId !== account.id)) {
    throw new MailFolderActionError("NOT_FOUND", "父文件夹不存在", 404);
  }
  return withFolderAction(account.id, async () => {
    if (account.providerId === "exchange-ews") {
      const credential = await loadExchangeMailCredential(account.id);
      await createExchangeMailFolder(credential, name, parent?.providerFolderId, AbortSignal.timeout(30_000));
    } else {
      await withImap(account.id, async (client, folders) => {
        const delimiter = parent ? folderByProviderId(folders, parent.providerFolderId)?.delimiter : folders[0]?.delimiter;
        const path = parent ? `${parent.providerFolderId}${delimiter || "/"}${name}` : name;
        await client.mailboxCreate(path);
      });
    }
    return { action: "create", accountId: account.id, refreshed: await refreshFolderIndex(account.id) };
  });
}

export async function renameMailFolder(folderId: string, rawName: string): Promise<MailFolderActionResult> {
  const name = validateFolderName(rawName);
  const folder = await requireMutableFolder(folderId);
  const account = await getAccount(folder.accountId);
  if (!account) throw new MailFolderActionError("NOT_FOUND", "邮箱账户不存在", 404);
  return withFolderAction(account.id, async () => {
    if (account.providerId === "exchange-ews") {
      const credential = await loadExchangeMailCredential(account.id);
      await renameExchangeMailFolder(credential, folder.providerFolderId, name, AbortSignal.timeout(30_000));
    } else {
      const parent = folder.parentId ? await getMailFolder(folder.parentId) : undefined;
      await withImap(account.id, async (client, folders) => {
        const current = folderByProviderId(folders, folder.providerFolderId);
        const path = parent ? `${parent.providerFolderId}${current?.delimiter || "/"}${name}` : name;
        await client.mailboxRename(folder.providerFolderId, path);
      });
      await removeFolderSubtreeFromIndex(folder.id);
    }
    return { action: "rename", accountId: account.id, refreshed: await refreshFolderIndex(account.id) };
  });
}

export async function moveMailFolder(folderId: string, parentFolderId?: string): Promise<MailFolderActionResult> {
  const folder = await requireMutableFolder(folderId);
  const account = await getAccount(folder.accountId);
  if (!account) throw new MailFolderActionError("NOT_FOUND", "邮箱账户不存在", 404);
  const parent = parentFolderId ? await getMailFolder(parentFolderId) : undefined;
  if (parentFolderId && (!parent || parent.accountId !== folder.accountId)) {
    throw new MailFolderActionError("NOT_FOUND", "目标文件夹不存在", 404);
  }
  if (parent?.id === folder.id || await isDescendant(folder.id, parent?.id)) {
    throw new MailFolderActionError("INVALID_MOVE", "不能把文件夹移动到自身或其子文件夹中", 409);
  }
  if (folder.parentId === parent?.id || (!folder.parentId && !parent)) {
    throw new MailFolderActionError("INVALID_MOVE", "文件夹已经位于该位置", 409);
  }
  return withFolderAction(account.id, async () => {
    if (account.providerId === "exchange-ews") {
      const credential = await loadExchangeMailCredential(account.id);
      await moveExchangeMailFolder(credential, folder.providerFolderId, parent?.providerFolderId, AbortSignal.timeout(30_000));
    } else {
      await withImap(account.id, async (client, folders) => {
        const current = folderByProviderId(folders, folder.providerFolderId);
        const path = parent
          ? `${parent.providerFolderId}${current?.delimiter || "/"}${folder.name}`
          : folder.name;
        await client.mailboxRename(folder.providerFolderId, path);
      });
    }
    await removeFolderSubtreeFromIndex(folder.id);
    return { action: "move", accountId: account.id, refreshed: await refreshFolderIndex(account.id) };
  });
}

export async function deleteMailFolder(folderId: string): Promise<MailFolderActionResult> {
  const folder = await requireMutableFolder(folderId);
  const account = await getAccount(folder.accountId);
  if (!account) throw new MailFolderActionError("NOT_FOUND", "邮箱账户不存在", 404);
  return withFolderAction(account.id, async () => {
    if (account.providerId === "exchange-ews") {
      const credential = await loadExchangeMailCredential(account.id);
      await deleteExchangeMailFolder(credential, folder.providerFolderId, AbortSignal.timeout(30_000));
    } else {
      await withImap(account.id, async (client, folders) => {
        const trashPath = await getTrashFolderPath(account.id);
        const current = folderByProviderId(folders, folder.providerFolderId);
        const trash = trashPath ? folderByProviderId(folders, trashPath) : undefined;
        if (!trash || folder.providerFolderId === trash.path || folder.providerFolderId.startsWith(`${trash.path}${trash.delimiter}`)) {
          throw new MailFolderActionError("INVALID_MOVE", "该文件夹已在已删除邮件中，或邮箱没有可用的已删除文件夹", 409);
        }
        const basePath = `${trash.path}${trash.delimiter}${folder.name}`;
        const occupied = new Set(folders.map((item) => item.path.toLocaleLowerCase()));
        const destination = occupied.has(basePath.toLocaleLowerCase()) ? `${basePath}-${Date.now()}` : basePath;
        await client.mailboxRename(folder.providerFolderId, destination);
      });
    }
    await removeFolderSubtreeFromIndex(folder.id);
    return { action: "delete", accountId: account.id, refreshed: await refreshFolderIndex(account.id) };
  });
}

async function requireMutableFolder(folderId: string): Promise<StoredMailFolder> {
  const folder = await getMailFolder(folderId);
  if (!folder) throw new MailFolderActionError("NOT_FOUND", "邮件文件夹不存在", 404);
  if (!isMutableFolder(folder)) {
    throw new MailFolderActionError("PROTECTED_FOLDER", "系统特殊文件夹不能重命名、移动或删除", 409);
  }
  return folder;
}

function isMutableFolder(folder: StoredMailFolder): boolean {
  return folder.role === "other" || folder.role === "custom";
}

async function isDescendant(folderId: string, possibleDescendantId?: string): Promise<boolean> {
  if (!possibleDescendantId) return false;
  const folders = await listMailFolders();
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let current = byId.get(possibleDescendantId);
  while (current?.parentId) {
    if (current.parentId === folderId) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

function validateFolderName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new MailFolderActionError("INVALID_NAME", "文件夹名称必须为 1–120 个有效字符", 400);
  }
  return name;
}

async function withFolderAction<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const active = globalThis.kalenderActiveFolderActions ??= new Set<string>();
  if (active.has(accountId)) throw new MailFolderActionError("ACTION_BUSY", "该邮箱正在执行其他文件夹操作", 409);
  active.add(accountId);
  try {
    return await task();
  } catch (error) {
    if (error instanceof MailFolderActionError) throw error;
    console.error("Mail folder action failed", error);
    throw new MailFolderActionError("REMOTE_ERROR", error instanceof Error && error.message ? error.message : "邮箱服务器没有完成文件夹操作", 502);
  } finally {
    active.delete(accountId);
  }
}

async function refreshFolderIndex(accountId: string): Promise<boolean> {
  try {
    await runMailSync(accountId, 1);
    return true;
  } catch (error) {
    console.error("Mail folder refresh after remote operation failed", error);
    return false;
  }
}

async function withImap<T>(
  accountId: string,
  task: (client: ImapFlow, folders: readonly ListResponse[]) => Promise<T>,
): Promise<T> {
  const credential = await loadImapSmtpCredential(accountId);
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
    tls: { rejectUnauthorized: true, servername: credential.imap.host },
  });
  try {
    await client.connect();
    return await task(client, await client.list());
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function folderByProviderId(folders: readonly ListResponse[], providerFolderId: string): ListResponse | undefined {
  return folders.find((folder) => folder.path === providerFolderId);
}
