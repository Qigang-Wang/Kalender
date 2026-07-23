import { NextResponse } from "next/server";

import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { MailDraftValidationError } from "@/server/mail-draft-validation";
import { sendMailDraft } from "@/server/mail-send-service";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SendRouteContext {
  readonly params: Promise<{ readonly draftId: string }>;
}

export async function POST(request: Request, context: SendRouteContext) {
  const { draftId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as {
      readonly accountId?: unknown;
      readonly idempotencyKey?: unknown;
      readonly confirmed?: unknown;
    } | null;
    if (body?.confirmed !== true) throw new MailDraftValidationError("发送前必须明确确认");
    if (typeof body.accountId !== "string" || !body.accountId) throw new MailDraftValidationError("请选择并确认发件账户");
    if (typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{16,160}$/.test(body.idempotencyKey)) {
      throw new MailDraftValidationError("发送确认标识无效");
    }
    return NextResponse.json({ ok: true, result: await sendMailDraft(draftId, body.accountId, body.idempotencyKey) });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}
