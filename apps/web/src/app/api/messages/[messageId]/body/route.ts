import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { CredentialDecryptionError } from "@/server/credential-crypto";
import { ExchangeEwsError } from "@/server/exchange-ews-client";
import { getMailBody, MailBodyNotFoundError } from "@/server/mail-body-service";

export const runtime = "nodejs";
export const maxDuration = 60;

interface MessageBodyRouteContext {
  readonly params: Promise<{ readonly messageId: string }>;
}

export async function GET(request: Request, context: MessageBodyRouteContext) {
  const { messageId } = await context.params;
  const requestId = randomUUID();
  try {
    const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
    const body = await getMailBody(messageId, { forceRefresh });
    return NextResponse.json({ ok: true, body }, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    console.error("Unable to read mail body", {
      requestId,
      messageId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    if (error instanceof MailBodyNotFoundError) {
      return NextResponse.json({ ok: false, message: error.message, requestId }, { status: 404, headers: { "X-Request-Id": requestId } });
    }
    if (error instanceof CredentialDecryptionError) {
      return NextResponse.json({ ok: false, message: error.message, requestId }, { status: 409, headers: { "X-Request-Id": requestId } });
    }
    if (error instanceof ExchangeEwsError) {
      return NextResponse.json({ ok: false, message: error.message, requestId }, { status: error.status, headers: { "X-Request-Id": requestId } });
    }
    return NextResponse.json(
      { ok: false, message: `无法读取邮件正文，请稍后重试（请求编号 ${requestId}）`, requestId },
      { status: 502, headers: { "X-Request-Id": requestId } },
    );
  }
}
