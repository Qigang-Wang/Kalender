import { NextResponse } from "next/server";
import { getMailDraft } from "@/server/mail-draft-repository";
import { pushExchangeDraft, reloadExchangeDraft } from "@/server/exchange-draft-sync";
import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { MailDraftValidationError } from "@/server/mail-draft-validation";

export async function POST(request: Request, context: { params: Promise<{ draftId: string }> }) {
  try {
    const { draftId } = await context.params;
    const body = await request.json();
    if (body?.resolution === "local") await pushExchangeDraft(draftId, true);
    else if (body?.resolution === "remote") await reloadExchangeDraft(draftId);
    else throw new MailDraftValidationError("请选择要保留的草稿版本");
    return NextResponse.json({ ok: true, draft: await getMailDraft(draftId) });
  } catch (error) { return mailDraftErrorResponse(error); }
}
