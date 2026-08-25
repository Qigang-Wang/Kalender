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
  if (!draft) throw new MailDraftAttachmentError("Entwurf existiert nicht", 404);
  if (draft.status === "sending" || draft.status === "sent") {
    throw new MailDraftAttachmentError("Anhänge können während des E-Mail-Versands nicht geändert werden", 409);
  }
  if (files.length === 0) throw new MailDraftAttachmentError("Bitte wählen Sie einen Anhang");

  const existing = await listMailDraftAttachmentRecords(draftId);
  if (existing.length + files.length > MAX_MAIL_ATTACHMENTS) {
    throw new MailDraftAttachmentError(`Fügen Sie ein Maximum von jeder E-Mail${MAX_MAIL_ATTACHMENTS} eine Anlage`);
  }
  const normalized = files.map((file) => normalizeFile(file, Boolean(options.inline)));
  const totalBytes = existing.reduce((total, item) => total + item.sizeBytes, 0)
    + normalized.reduce((total, item) => total + item.file.size, 0);
  if (totalBytes > MAX_MAIL_ATTACHMENTS_TOTAL_BYTES) {
    throw new MailDraftAttachmentError("die Gesamtgröße der Anhänge sollte 25 MB nicht überschreiten");
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
  if (!draft) throw new MailDraftAttachmentError("Entwurf existiert nicht", 404);
  if (draft.status === "sending" || draft.status === "sent") {
    throw new MailDraftAttachmentError("Anhänge können während des E-Mail-Versands nicht geändert werden", 409);
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
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(draftId)) throw new MailDraftAttachmentError("der Entwurf der ID ist ungültig");
  return path.join(dataRoot(), "mail-draft-attachments", draftId);
}

function normalizeFile(file: File, inline: boolean): { readonly file: File; readonly filename: string } {
  if (!(file instanceof File)) throw new MailDraftAttachmentError("das Anhängeformat ist nicht gültig");
  if (file.size <= 0) throw new MailDraftAttachmentError(`Anlage "${file.name || "unbenannte Datei"}"Frei"`);
  if (file.size > MAX_MAIL_ATTACHMENT_BYTES) throw new MailDraftAttachmentError(`Anlage "${file.name}"kann 15 MB nicht überschreiten"`);
  if (inline && !/^image\/(?:png|jpe?g|gif|webp)$/i.test(file.type)) {
    throw new MailDraftAttachmentError("Nur PNG-, JPEG-, GIF- oder WebP-Bilder können in Text eingefügt werden");
  }
  const filename = file.name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!filename || filename.length > 240) throw new MailDraftAttachmentError("Anhängename ungültig oder zu lang");
  return { file, filename };
}
