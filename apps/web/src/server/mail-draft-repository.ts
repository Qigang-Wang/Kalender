import { randomUUID } from "node:crypto";

import { decodeNoteContent, encodeNoteContent, noteContentToPlainText } from "../lib/note-content";
import { replaceMailSignatureContent } from "../lib/mail-signature-content";

import { getDatabase } from "./database";
import { getAccount } from "./mail-repository";
import type { ParsedMailDraftInput } from "./mail-draft-validation";
import {
  getDefaultMailSignature,
  getMailSignature,
  recommendMailSignatureVariant,
} from "./mail-signature-repository";
import { getUserScope } from "./user-scope";

export type MailDraftStatus = "draft" | "sending" | "sent" | "failed";

export interface StoredMailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly inline: boolean;
  readonly contentId?: string;
  readonly createdAt: string;
}

export interface MailDraftAttachmentRecord extends StoredMailAttachment {
  readonly draftId: string;
  readonly storageName: string;
}

export interface StoredMailDraft extends ParsedMailDraftInput {
  readonly id: string;
  readonly attachments: readonly StoredMailAttachment[];
  readonly status: MailDraftStatus;
  readonly idempotencyKey?: string;
  readonly providerMessageId?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sentAt?: string;
}

interface MailDraftRow {
  id: string;
  account_id: string;
  reply_to_message_id: string | null;
  to_addresses: unknown;
  cc_addresses: unknown;
  bcc_addresses: unknown;
  subject: string;
  text_body: string;
  body_content: string;
  signature_id: string | null;
  signature_variant: "full" | "short" | null;
  status: MailDraftStatus;
  idempotency_key: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

interface MailDraftAttachmentRow {
  id: string;
  draft_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_name: string;
  inline: boolean;
  content_id: string | null;
  created_at: string;
}

export interface MailReplyContext {
  readonly messageId: string;
  readonly accountId: string;
  readonly providerMessageId: string;
}

export class MailDraftRepositoryError extends Error {
  constructor(
    readonly code: "DRAFT_NOT_FOUND" | "ACCOUNT_NOT_FOUND" | "REPLY_ACCOUNT_MISMATCH" | "DRAFT_BUSY" | "DRAFT_SENT" | "IDEMPOTENCY_CONFLICT",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailDraftRepositoryError";
  }
}

export async function listMailDrafts(): Promise<readonly StoredMailDraft[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<MailDraftRow>(
    `SELECT * FROM mail_drafts
      WHERE status IN ('draft', 'failed')${scope.active ? " AND user_id = $1" : ""}
      ORDER BY updated_at DESC`,
    scope.active ? [scope.userId] : [],
  );
  return Promise.all(result.rows.map(async (row) => mapDraft(row, await listMailDraftAttachments(row.id))));
}

export async function getMailDraft(id: string): Promise<StoredMailDraft | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<MailDraftRow>(
    `SELECT * FROM mail_drafts WHERE id = $1${scope.active ? " AND user_id = $2" : ""} LIMIT 1`,
    scope.active ? [id, scope.userId] : [id],
  );
  return result.rows[0] ? mapDraft(result.rows[0], await listMailDraftAttachments(id)) : undefined;
}

export async function listMailDraftIdsForAccount(accountId: string): Promise<readonly string[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ id: string }>(
    `SELECT id FROM mail_drafts WHERE account_id = $1${scope.active ? " AND user_id = $2" : ""}`,
    scope.active ? [accountId, scope.userId] : [accountId],
  );
  return result.rows.map((row) => row.id);
}

export async function saveMailDraft(input: ParsedMailDraftInput, id?: string): Promise<StoredMailDraft> {
  if (!await getAccount(input.accountId)) {
    throw new MailDraftRepositoryError("ACCOUNT_NOT_FOUND", "发件账户不存在", 404);
  }
  if (input.replyToMessageId) {
    const reply = await getMailReplyContext(input.replyToMessageId);
    if (!reply) throw new MailDraftRepositoryError("DRAFT_NOT_FOUND", "回复的原邮件不存在", 404);
    if (reply.accountId !== input.accountId) {
      throw new MailDraftRepositoryError("REPLY_ACCOUNT_MISMATCH", "回复必须使用收到原邮件的账户", 409);
    }
  }
  if (input.signatureId) {
    const signature = await getMailSignature(input.signatureId);
    if (!signature || signature.accountId !== input.accountId) {
      throw new MailDraftRepositoryError("ACCOUNT_NOT_FOUND", "所选签名不属于当前发件账户", 400);
    }
  }
  const draftId = id ?? randomUUID();
  const existing = id ? await getMailDraft(id) : undefined;
  if (id && !existing) throw new MailDraftRepositoryError("DRAFT_NOT_FOUND", "草稿不存在", 404);
  if (existing?.status === "sending") throw new MailDraftRepositoryError("DRAFT_BUSY", "邮件正在发送", 409);
  if (existing?.status === "sent") throw new MailDraftRepositoryError("DRAFT_SENT", "邮件已经发送", 409);
  const database = await getDatabase();
  const scope = await getUserScope();
  const values = [draftId, input.accountId, input.replyToMessageId ?? null, JSON.stringify(input.to), JSON.stringify(input.cc),
    JSON.stringify(input.bcc), input.subject, input.textBody, input.bodyContent, input.signatureId ?? null, input.signatureVariant ?? null];
  if (existing) {
    await database.query(
      `UPDATE mail_drafts SET account_id = $2, reply_to_message_id = $3,
         to_addresses = $4::jsonb, cc_addresses = $5::jsonb, bcc_addresses = $6::jsonb,
         subject = $7, text_body = $8, body_content = $9, status = 'draft', idempotency_key = NULL,
         signature_id = $10, signature_variant = $11,
         error_message = NULL, updated_at = now()
       WHERE id = $1${scope.active ? " AND user_id = $12" : ""}`,
      scope.active ? [...values, scope.userId] : values,
    );
  } else {
    await database.query(
      `INSERT INTO mail_drafts (
         id, account_id, reply_to_message_id, to_addresses, cc_addresses, bcc_addresses,
         subject, text_body, body_content, signature_id, signature_variant, status, updated_at,
         user_id
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,'draft',now(),$12)`,
      [...values, scope.valueOrNull()],
    );
  }
  return (await getMailDraft(draftId))!;
}

export async function createMailDraft(input: ParsedMailDraftInput): Promise<StoredMailDraft> {
  const signature = await getDefaultMailSignature(input.accountId);
  if (!signature) return saveMailDraft(input);
  const variant = await recommendMailSignatureVariant(input.accountId, input.replyToMessageId);
  const bodyContent = replaceMailSignatureContent(input.bodyContent, {
    id: signature.id,
    variant,
    text: variant === "full" ? signature.fullText : signature.shortText,
  });
  return saveMailDraft({
    ...input,
    bodyContent,
    textBody: noteContentToPlainText(bodyContent),
    signatureId: signature.id,
    signatureVariant: variant,
  });
}

export async function deleteMailDraft(id: string): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ id: string }>(
    `DELETE FROM mail_drafts WHERE id = $1 AND status IN ('draft', 'failed')${scope.active ? " AND user_id = $2" : ""} RETURNING id`,
    scope.active ? [id, scope.userId] : [id],
  );
  return Boolean(result.rows[0]);
}

export async function beginMailDraftSend(
  id: string,
  accountId: string,
  idempotencyKey: string,
): Promise<{ readonly draft: StoredMailDraft; readonly alreadySent: boolean }> {
  const draft = await getMailDraft(id);
  if (!draft) throw new MailDraftRepositoryError("DRAFT_NOT_FOUND", "草稿不存在", 404);
  if (draft.accountId !== accountId) throw new MailDraftRepositoryError("REPLY_ACCOUNT_MISMATCH", "发件账户与确认信息不一致", 409);
  if (draft.status === "sent") {
    if (draft.idempotencyKey === idempotencyKey) return { draft, alreadySent: true };
    throw new MailDraftRepositoryError("DRAFT_SENT", "邮件已经发送", 409);
  }
  if (draft.status === "sending") throw new MailDraftRepositoryError("DRAFT_BUSY", "邮件正在发送", 409);
  const database = await getDatabase();
  const conflict = await database.query<{ id: string }>(
    "SELECT id FROM mail_drafts WHERE idempotency_key = $1 AND id <> $2 LIMIT 1",
    [idempotencyKey, id],
  );
  if (conflict.rows[0]) throw new MailDraftRepositoryError("IDEMPOTENCY_CONFLICT", "发送确认已被其他邮件使用", 409);
  await database.query(
    `UPDATE mail_drafts SET status = 'sending', idempotency_key = $2,
       error_message = NULL, updated_at = now() WHERE id = $1`,
    [id, idempotencyKey],
  );
  return { draft: (await getMailDraft(id))!, alreadySent: false };
}

export async function finishMailDraftSend(id: string, providerMessageId: string): Promise<StoredMailDraft> {
  const database = await getDatabase();
  await database.query(
    `UPDATE mail_drafts SET status = 'sent', provider_message_id = $2,
       sent_at = now(), updated_at = now() WHERE id = $1`,
    [id, providerMessageId],
  );
  return (await getMailDraft(id))!;
}

export async function failMailDraftSend(id: string, message: string): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE mail_drafts SET status = 'failed', error_message = $2,
       updated_at = now() WHERE id = $1 AND status = 'sending'`,
    [id, message],
  );
}

export async function getMailReplyContext(messageId: string): Promise<MailReplyContext | undefined> {
  const database = await getDatabase();
  const result = await database.query<{ id: string; account_id: string; provider_message_id: string }>(
    "SELECT id, account_id, provider_message_id FROM mail_messages WHERE id = $1 LIMIT 1",
    [messageId],
  );
  const row = result.rows[0];
  return row ? { messageId: row.id, accountId: row.account_id, providerMessageId: row.provider_message_id } : undefined;
}

export async function listMailDraftAttachments(draftId: string): Promise<readonly StoredMailAttachment[]> {
  const records = await listMailDraftAttachmentRecords(draftId);
  return records.map(({ id, filename, contentType, sizeBytes, inline, contentId, createdAt }) => ({ id, filename, contentType, sizeBytes, inline, contentId, createdAt }));
}

export async function listMailDraftAttachmentRecords(draftId: string): Promise<readonly MailDraftAttachmentRecord[]> {
  const database = await getDatabase();
  const result = await database.query<MailDraftAttachmentRow>(
    "SELECT * FROM mail_draft_attachments WHERE draft_id = $1 ORDER BY created_at, id",
    [draftId],
  );
  return result.rows.map(mapAttachmentRecord);
}

export async function insertMailDraftAttachment(input: Omit<MailDraftAttachmentRecord, "createdAt">): Promise<StoredMailAttachment> {
  const database = await getDatabase();
  const result = await database.query<MailDraftAttachmentRow>(
    `INSERT INTO mail_draft_attachments (id, draft_id, filename, content_type, size_bytes, storage_name, inline, content_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.id, input.draftId, input.filename, input.contentType, input.sizeBytes, input.storageName, input.inline, input.contentId ?? null],
  );
  const record = mapAttachmentRecord(result.rows[0]!);
  return { id: record.id, filename: record.filename, contentType: record.contentType, sizeBytes: record.sizeBytes, inline: record.inline, contentId: record.contentId, createdAt: record.createdAt };
}

export async function deleteMailDraftAttachment(draftId: string, attachmentId: string): Promise<MailDraftAttachmentRecord | undefined> {
  const database = await getDatabase();
  const result = await database.query<MailDraftAttachmentRow>(
    "DELETE FROM mail_draft_attachments WHERE draft_id = $1 AND id = $2 RETURNING *",
    [draftId, attachmentId],
  );
  return result.rows[0] ? mapAttachmentRecord(result.rows[0]) : undefined;
}

export async function deleteMailDraftAttachmentRecords(draftId: string): Promise<void> {
  const database = await getDatabase();
  await database.query("DELETE FROM mail_draft_attachments WHERE draft_id = $1", [draftId]);
}

function mapDraft(row: MailDraftRow, attachments: readonly StoredMailAttachment[]): StoredMailDraft {
  return {
    id: row.id,
    accountId: row.account_id,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    to: stringArray(row.to_addresses),
    cc: stringArray(row.cc_addresses),
    bcc: stringArray(row.bcc_addresses),
    subject: row.subject,
    textBody: row.text_body,
    bodyContent: row.body_content || encodeNoteContent(decodeNoteContent(row.text_body)),
    signatureId: row.signature_id ?? undefined,
    signatureVariant: row.signature_variant ?? undefined,
    attachments,
    status: row.status,
    idempotencyKey: row.idempotency_key ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? undefined,
  };
}

function mapAttachmentRecord(row: MailDraftAttachmentRow): MailDraftAttachmentRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    storageName: row.storage_name,
    inline: row.inline,
    contentId: row.content_id ?? undefined,
    createdAt: row.created_at,
  };
}

function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try { return stringArray(JSON.parse(value)); } catch { return []; }
  }
  return [];
}
