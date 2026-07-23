import { NextResponse } from "next/server";

import { getMailBody, MailBodyNotFoundError } from "@/server/mail-body-service";

export const runtime = "nodejs";
export const maxDuration = 60;

interface MessageBodyRouteContext {
  readonly params: Promise<{ readonly messageId: string }>;
}

export async function GET(request: Request, context: MessageBodyRouteContext) {
  const { messageId } = await context.params;
  try {
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
    const body = await getMailBody(messageId, { forceRefresh });
    return NextResponse.json({ ok: true, body });
  } catch (error) {
    if (error instanceof MailBodyNotFoundError) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { ok: false, message: "无法读取邮件正文，请稍后重试" },
      { status: 502 },
    );
  }
}
