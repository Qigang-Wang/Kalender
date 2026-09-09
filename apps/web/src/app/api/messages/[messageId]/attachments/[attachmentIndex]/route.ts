import { NextResponse } from "next/server";

import { getMailAttachment, MailBodyNotFoundError } from "@/server/mail-body-service";
import { safeAttachmentPreviewContentType } from "@/lib/mail-attachment-preview";

export const runtime = "nodejs";
export const maxDuration = 60;

interface AttachmentRouteContext {
  readonly params: Promise<{ readonly messageId: string; readonly attachmentIndex: string }>;
}

export async function GET(request: Request, context: AttachmentRouteContext) {
  const { messageId, attachmentIndex } = await context.params;
  try {
    const attachment = await getMailAttachment(messageId, Number(attachmentIndex));
    const preview = new URL(request.url).searchParams.get("preview") === "1";
    const previewContentType = preview ? safeAttachmentPreviewContentType(attachment.contentType) : undefined;
    if (preview && !previewContentType) {
      return NextResponse.json({ ok: false, message: "该附件类型仅支持下载" }, { status: 415 });
    }
    const encoded = encodeURIComponent(attachment.filename);
    return new NextResponse(Buffer.from(attachment.content), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${preview || attachment.inline ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encoded}`,
        "Content-Length": String(attachment.content.byteLength),
        "Content-Type": previewContentType ?? attachment.contentType,
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'self'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MailBodyNotFoundError) return NextResponse.json({ ok: false, message: error.message }, { status: 404 });
    return NextResponse.json({ ok: false, message: "无法下载附件" }, { status: 502 });
  }
}
