import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";

import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { mailDraftAttachmentPath, MailDraftAttachmentError, removeMailDraftAttachment } from "@/server/mail-draft-attachment-service";
import { MailDraftRepositoryError, getMailDraft, listMailDraftAttachmentRecords } from "@/server/mail-draft-repository";

export const runtime = "nodejs";

interface AttachmentRouteContext {
  readonly params: Promise<{ readonly draftId: string; readonly attachmentId: string }>;
}

export async function GET(_request: Request, context: AttachmentRouteContext) {
  const { draftId, attachmentId } = await context.params;
  try {
    const attachment = (await listMailDraftAttachmentRecords(draftId)).find((item) => item.id === attachmentId);
    if (!attachment) throw new MailDraftAttachmentError("附件不存在", 404);
    const content = await readFile(mailDraftAttachmentPath(attachment));
    const disposition = attachment.inline && /^image\//i.test(attachment.contentType) ? "inline" : "attachment";
    return new Response(content, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        "Content-Length": String(content.byteLength),
        "Content-Type": attachment.contentType || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: AttachmentRouteContext) {
  const { draftId, attachmentId } = await context.params;
  try {
    if (!await removeMailDraftAttachment(draftId, attachmentId)) {
      throw new MailDraftRepositoryError("DRAFT_NOT_FOUND", "附件不存在", 404);
    }
    return NextResponse.json({ ok: true, draft: await getMailDraft(draftId) });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}
