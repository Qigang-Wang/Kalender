import { NextResponse } from "next/server";

import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { clearMailDraftAttachmentFiles } from "@/server/mail-draft-attachment-service";
import { deleteMailDraft, MailDraftRepositoryError, saveMailDraft } from "@/server/mail-draft-repository";
import { parseMailDraftInput, type MailDraftRequestBody } from "@/server/mail-draft-validation";

export const runtime = "nodejs";

interface DraftRouteContext {
  readonly params: Promise<{ readonly draftId: string }>;
}

export async function PATCH(request: Request, context: DraftRouteContext) {
  const { draftId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as MailDraftRequestBody | null;
    return NextResponse.json({ ok: true, draft: await saveMailDraft(parseMailDraftInput(body), draftId) });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: DraftRouteContext) {
  const { draftId } = await context.params;
  try {
    if (!await deleteMailDraft(draftId)) {
      throw new MailDraftRepositoryError("DRAFT_NOT_FOUND", "der Entwurf existiert nicht oder kann nicht gelöscht werden", 404);
    }
    await clearMailDraftAttachmentFiles(draftId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}
