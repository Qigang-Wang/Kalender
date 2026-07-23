import { randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataRoot } from "./database";
import {
  deleteMailDraftAttachment,
  deleteMailDraftAttachmentRecords,
  getMailDraft,
  insertMailDraftAttachment,
  listMailDraftAttachmentRecords,
  type MailDraftAttachmentRecord,
  type StoredMailAttachment,
} from "./mail-draft-repository";

export const MAX_MAIL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_MAIL_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_MAIL_ATTACHMENTS = 10;

export class MailDraftAttachmentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MailDraftAttachmentError";
  }
}

export async function addMailDraftAttachments(
  draftId: string,
  files: readonly File[],
  options: { readonly inline?: boolean } = {},
): Promise<readonly StoredMailAttachment[]> {
  const draft = await getMailDraft(draftId);
  if (!draft) throw new MailDraftAttachmentError("草稿不存在", 404);
  if (draft.status === "sending" || draft.status === "sent") {
    throw new MailDraftAttachmentError("邮件发送期间不能修改附件", 409);
  }
  if (files.length === 0) throw new MailDraftAttachmentError("请选择附件");

  const existing = await listMailDraftAttachmentRecords(draftId);
  if (existing.length + files.length > MAX_MAIL_ATTACHMENTS) {
    throw new MailDraftAttachmentError(`每封邮件最多添加 ${MAX_MAIL_ATTACHMENTS} 个附件`);
  }
  const normalized = files.map((file) => normalizeFile(file, Boolean(options.inline)));
  const totalBytes = existing.reduce((total, item) => total + item.sizeBytes, 0)
    + normalized.reduce((total, item) => total + item.file.size, 0);
  if (totalBytes > MAX_MAIL_ATTACHMENTS_TOTAL_BYTES) {
    throw new MailDraftAttachmentError("附件总大小不能超过 25 MB");
  }

  const directory = attachmentDirectory(draftId);
  await mkdir(directory, { recursive: true });
  const created: Array<{ readonly id: string; readonly filePath: string }> = [];
  const added: StoredMailAttachment[] = [];
  try {
    for (const item of normalized) {
      const id = randomUUID();
      const storageName = `${id}.bin`;
      const filePath = path.join(directory, storageName);
      await writeFile(filePath, Buffer.from(await item.file.arrayBuffer()), { flag: "wx", mode: 0o600 });
      created.push({ id, filePath });
      const attachment = await insertMailDraftAttachment({
        id,
        draftId,
        filename: item.filename,
        contentType: item.file.type || "application/octet-stream",
        sizeBytes: item.file.size,
        storageName,
        inline: Boolean(options.inline),
        contentId: options.inline ? `kalender-${id}@inline.local` : undefined,
      });
      added.push(attachment);
    }
    return added;
  } catch (error) {
    await Promise.all(created.map(async (item) => {
      await deleteMailDraftAttachment(draftId, item.id).catch(() => undefined);
      await unlink(item.filePath).catch(() => undefined);
    }));
    throw error;
  }
}

export async function removeMailDraftAttachment(draftId: string, attachmentId: string): Promise<boolean> {
  const draft = await getMailDraft(draftId);
  if (!draft) throw new MailDraftAttachmentError("草稿不存在", 404);
  if (draft.status === "sending" || draft.status === "sent") {
    throw new MailDraftAttachmentError("邮件发送期间不能修改附件", 409);
  }
  const record = (await listMailDraftAttachmentRecords(draftId)).find((item) => item.id === attachmentId);
  if (!record) return false;
  await unlink(mailDraftAttachmentPath(record)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return Boolean(await deleteMailDraftAttachment(draftId, attachmentId));
}

export async function clearMailDraftAttachmentFiles(draftId: string): Promise<void> {
  await deleteMailDraftAttachmentRecords(draftId);
  await rm(attachmentDirectory(draftId), { recursive: true, force: true });
}

export function mailDraftAttachmentPath(record: MailDraftAttachmentRecord): string {
  return path.join(attachmentDirectory(record.draftId), record.storageName);
}

function attachmentDirectory(draftId: string): string {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(draftId)) throw new MailDraftAttachmentError("草稿标识无效");
  return path.join(dataRoot(), "mail-draft-attachments", draftId);
}

function normalizeFile(file: File, inline: boolean): { readonly file: File; readonly filename: string } {
  if (!(file instanceof File)) throw new MailDraftAttachmentError("附件格式无效");
  if (file.size <= 0) throw new MailDraftAttachmentError(`附件“${file.name || "未命名文件"}”为空`);
  if (file.size > MAX_MAIL_ATTACHMENT_BYTES) throw new MailDraftAttachmentError(`附件“${file.name}”不能超过 15 MB`);
  if (inline && !/^image\/(?:png|jpe?g|gif|webp)$/i.test(file.type)) {
    throw new MailDraftAttachmentError("正文内只能粘贴 PNG、JPEG、GIF 或 WebP 图片");
  }
  const filename = file.name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!filename || filename.length > 240) throw new MailDraftAttachmentError("附件名称无效或过长");
  return { file, filename };
}
