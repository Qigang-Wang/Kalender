import { NextResponse } from "next/server";

import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { createMailDraft, listMailDrafts, getMailDraft, deleteMailDraft, saveMailDraft } from "@/server/mail-draft-repository";
import { addMailDraftAttachments, clearMailDraftAttachmentFiles } from "@/server/mail-draft-attachment-service";
import { getStoredMessageRemote } from "@/server/mail-repository";
import { getMailAttachment, getMailBody } from "@/server/mail-body-service";
import { exchangeHtmlToContent } from "@/server/exchange-rich-text";
import { decodeNoteContent, encodeNoteContent, noteContentToPlainText } from "@/lib/note-content";
import { MailDraftValidationError } from "@/server/mail-draft-validation";
import { mailDraftAttachmentUrl } from "@/server/mail-rich-text";
import { pushExchangeDraft } from "@/server/exchange-draft-sync";
import { parseMailDraftInput, type MailDraftRequestBody } from "@/server/mail-draft-validation";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, drafts: await listMailDrafts() });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as (MailDraftRequestBody & { forwardMessageId?: unknown }) | null;
    const input = parseMailDraftInput(body);
    const forwardId = typeof body?.forwardMessageId === "string" ? body.forwardMessageId : undefined;
    const source = forwardId ? await getStoredMessageRemote(forwardId) : undefined;
    if (forwardId && (!source || source.accountId !== input.accountId)) throw new MailDraftValidationError("转发邮件不属于当前账户", 400);
    if (source && source.attachments.length > 10) throw new MailDraftValidationError("原邮件附件超过 10 个，无法完整转发", 400);
    const original = forwardId ? await getMailBody(forwardId) : undefined;
    const draft = await createMailDraft(input);
    try {
      const imageUrls = new Map<string, string>();
      if (forwardId && source?.attachments.length) {
        let totalBytes = 0;
        for (let index = 0; index < source.attachments.length; index++) {
          const attachment = await getMailAttachment(forwardId, index);
          totalBytes += attachment.content.length;
          if (attachment.content.length > 15 * 1024 * 1024 || totalBytes > 25 * 1024 * 1024) throw new MailDraftValidationError("原邮件附件超过大小限制，无法完整转发", 400);
          const inline = attachment.inline && /^image\/(?:png|jpe?g|gif|webp)$/i.test(attachment.contentType);
          const [added] = await addMailDraftAttachments(draft.id, [new File([Buffer.from(attachment.content)], attachment.filename, { type: attachment.contentType })], { inline });
          if (inline && added) imageUrls.set(`/api/messages/${encodeURIComponent(forwardId)}/attachments/${index}`, mailDraftAttachmentUrl(draft.id, added.id));
        }
      }
      if (original) {
        const bodyContent = encodeNoteContent([...decodeNoteContent(draft.bodyContent), ...decodeNoteContent(original.html ? exchangeHtmlToContent(original.html, (src) => imageUrls.get(src)) : original.text ?? "")]);
        await saveMailDraft({ ...draft, bodyContent, textBody: noteContentToPlainText(bodyContent) }, draft.id);
      }
      await pushExchangeDraft(draft.id).catch(() => undefined);
      return NextResponse.json({ ok: true, draft: await getMailDraft(draft.id) }, { status: 201 });
    } catch (error) {
      await clearMailDraftAttachmentFiles(draft.id);
      await deleteMailDraft(draft.id);
      throw error;
    }
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}
