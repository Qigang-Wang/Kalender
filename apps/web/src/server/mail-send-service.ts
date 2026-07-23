import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import * as nodemailer from "nodemailer";

import {
  beginMailDraftSend,
  failMailDraftSend,
  finishMailDraftSend,
  getMailReplyContext,
  listMailDraftAttachmentRecords,
  type StoredMailDraft,
} from "./mail-draft-repository";
import { clearMailDraftAttachmentFiles, mailDraftAttachmentPath } from "./mail-draft-attachment-service";
import { assertDraftCanSend } from "./mail-draft-validation";
import { mailDraftAttachmentUrl, mailInlineImageAttachmentIds, renderMailHtml } from "./mail-rich-text";
import { sendExchangeMessage } from "./exchange-mail";
import { getAccount, loadExchangeMailCredential, loadImapSmtpCredential } from "./mail-repository";

export interface MailSendResult {
  readonly draft: StoredMailDraft;
  readonly alreadySent: boolean;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export class MailSendError extends Error {
  constructor(
    readonly code: "ACCOUNT_UNAVAILABLE" | "SEND_BUSY" | "AUTH_REQUIRED" | "NETWORK_ERROR" | "REMOTE_ERROR",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

declare global {
  var kalenderActiveMailSends: Set<string> | undefined;
}

export async function sendMailDraft(
  draftId: string,
  accountId: string,
  idempotencyKey: string,
): Promise<MailSendResult> {
  const active = globalThis.kalenderActiveMailSends ??= new Set<string>();
  if (active.has(draftId)) throw new MailSendError("SEND_BUSY", "邮件正在发送，请勿重复操作", 409);
  active.add(draftId);
  try {
    const claim = await beginMailDraftSend(draftId, accountId, idempotencyKey);
    if (claim.alreadySent) {
      return { draft: claim.draft, alreadySent: true, accepted: [], rejected: [] };
    }
    const account = await getAccount(accountId);
    if (!account || account.syncStatus === "paused") {
      throw new MailSendError("ACCOUNT_UNAVAILABLE", "请先启用发件账户", 409);
    }
    const attachmentRecords = await listMailDraftAttachmentRecords(draftId);
    const referencedInlineIds = mailInlineImageAttachmentIds(claim.draft.bodyContent);
    const sendAttachments = attachmentRecords.filter((attachment) => !attachment.inline || referencedInlineIds.has(attachment.id));
    const inlineImages = sendAttachments.flatMap((attachment) => attachment.inline && attachment.contentId ? [{
      attachmentId: attachment.id,
      contentId: attachment.contentId,
      sourceUrl: mailDraftAttachmentUrl(draftId, attachment.id),
    }] : []);
    assertDraftCanSend(claim.draft, inlineImages.length > 0);
    const htmlBody = await renderMailHtml(claim.draft.bodyContent, inlineImages);
    if (account.providerId === "exchange-ews") {
      const credential = await loadExchangeMailCredential(accountId);
      const reply = claim.draft.replyToMessageId
        ? await getMailReplyContext(claim.draft.replyToMessageId)
        : undefined;
      const providerMessageId = await sendExchangeMessage(credential, {
        to: claim.draft.to,
        cc: claim.draft.cc,
        bcc: claim.draft.bcc,
        subject: claim.draft.subject,
        textBody: claim.draft.textBody,
        htmlBody,
        attachments: await Promise.all(sendAttachments.map(async (attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: new Uint8Array(await readFile(mailDraftAttachmentPath(attachment))),
          inline: attachment.inline,
          contentId: attachment.contentId,
        }))),
        replyToItemId: reply?.providerMessageId,
      }, AbortSignal.timeout(60_000));
      const draft = await finishMailDraftSend(draftId, providerMessageId);
      await clearMailDraftAttachmentFiles(draftId).catch(() => undefined);
      return {
        draft,
        alreadySent: false,
        accepted: [...claim.draft.to, ...claim.draft.cc, ...claim.draft.bcc],
        rejected: [],
      };
    }
    const credential = await loadImapSmtpCredential(accountId);
    const transport = nodemailer.createTransport({
      host: credential.smtp.host,
      port: credential.smtp.port,
      secure: credential.smtp.secure,
      auth: { user: credential.smtp.username, pass: credential.smtp.password },
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 30_000,
      tls: { rejectUnauthorized: true, servername: credential.smtp.host },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const reply = claim.draft.replyToMessageId
        ? await getMailReplyContext(claim.draft.replyToMessageId)
        : undefined;
      const info = await transport.sendMail({
        from: { name: account.displayName, address: account.emailAddress },
        to: [...claim.draft.to],
        cc: claim.draft.cc.length ? [...claim.draft.cc] : undefined,
        bcc: claim.draft.bcc.length ? [...claim.draft.bcc] : undefined,
        subject: claim.draft.subject,
        text: claim.draft.textBody,
        html: htmlBody,
        attachments: sendAttachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: createReadStream(mailDraftAttachmentPath(attachment)),
          cid: attachment.inline ? attachment.contentId : undefined,
          contentDisposition: attachment.inline ? "inline" : "attachment",
        })),
        inReplyTo: reply?.providerMessageId,
        references: reply?.providerMessageId ? [reply.providerMessageId] : undefined,
        messageId: stableMessageId(idempotencyKey, account.emailAddress),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      const accepted = info.accepted.map(String);
      const rejected = info.rejected.map(String);
      if (!accepted.length) throw new MailSendError("REMOTE_ERROR", "邮件服务器没有接受任何收件人", 502);
      const draft = await finishMailDraftSend(draftId, info.messageId);
      await clearMailDraftAttachmentFiles(draftId).catch(() => undefined);
      return { draft, alreadySent: false, accepted, rejected };
    } finally {
      transport.close();
    }
  } catch (error) {
    console.error("Mail draft send failed", error);
    const normalized = normalizeSendError(error);
    await failMailDraftSend(draftId, normalized.message).catch(() => undefined);
    throw normalized;
  } finally {
    active.delete(draftId);
  }
}

function stableMessageId(idempotencyKey: string, emailAddress: string): string {
  const hash = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  const domain = emailAddress.split("@")[1]?.replace(/[^a-z0-9.-]/gi, "") || "localhost";
  return `<kalender.${hash}@${domain}>`;
}

function normalizeSendError(error: unknown): MailSendError {
  if (error instanceof MailSendError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const responseCode = typeof error === "object" && error !== null && "responseCode" in error ? Number(error.responseCode) : undefined;
  if (/AUTH|EAUTH|LOGIN/i.test(code) || responseCode === 535) {
    return new MailSendError("AUTH_REQUIRED", "SMTP 服务器拒绝了账户凭据，请重新配置账户", 401);
  }
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ESOCKET|ECONNECTION|EACCES/i.test(code)) {
    return new MailSendError("NETWORK_ERROR", "无法连接 SMTP 服务器，草稿已保留", 502);
  }
  if (error instanceof Error && /^(请|邮件|发件)/.test(error.message)) {
    return new MailSendError("REMOTE_ERROR", error.message, 400);
  }
  return new MailSendError("REMOTE_ERROR", "邮件发送失败，草稿已保留", 502);
}
