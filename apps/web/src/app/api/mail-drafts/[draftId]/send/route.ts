import { NextResponse } from "next/server";

import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { MailDraftValidationError } from "@/server/mail-draft-validation";
import { sendMailDraft } from "@/server/mail-send-service";
import { getCurrentAppUser, recordAuditEvent } from "@/server/auth";

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
    if (body?.confirmed !== true) throw new MailDraftValidationError("muss vor dem Versand eindeutig bestätigt werden");
    if (typeof body.accountId !== "string" || !body.accountId) throw new MailDraftValidationError("Bitte wählen und bestätigen Sie das Absender-Konto");
    if (typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{16,160}$/.test(body.idempotencyKey)) {
      throw new MailDraftValidationError("Senden Bestätigungszeichen ungültig");
    }
    const result = await sendMailDraft(draftId, body.accountId, body.idempotencyKey);
    const actor = await getCurrentAppUser();
    if (actor) {
      await recordAuditEvent({
        actorUserId: actor.id,
        targetUserId: actor.id,
        action: "mail.draft.send",
        metadata: { draftId, accountId: body.accountId },
      }).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}
