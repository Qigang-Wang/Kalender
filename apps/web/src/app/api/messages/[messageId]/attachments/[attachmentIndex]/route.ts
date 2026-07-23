import { NextResponse } from "next/server";

import { getMailAttachment, MailBodyNotFoundError } from "@/server/mail-body-service";

export const runtime = "nodejs";
export const maxDuration = 60;

interface AttachmentRouteContext {
  readonly params: Promise<{ readonly messageId: string; readonly attachmentIndex: string }>;
}

export async function GET(_request: Request, context: AttachmentRouteContext) {
  const { messageId, attachmentIndex } = await context.params;
  try {
    const attachment = await getMailAttachment(messageId, Number(attachmentIndex));
    const encoded = encodeURIComponent(attachment.filename);
    return new NextResponse(Buffer.from(attachment.content), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${attachment.inline ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encoded}`,
        "Content-Length": String(attachment.content.byteLength),
        "Content-Type": attachment.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MailBodyNotFoundError) return NextResponse.json({ ok: false, message: error.message }, { status: 404 });
    return NextResponse.json({ ok: false, message: "无法下载附件" }, { status: 502 });
  }
}
