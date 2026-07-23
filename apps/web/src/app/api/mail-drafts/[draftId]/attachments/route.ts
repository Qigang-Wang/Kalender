import { NextResponse } from "next/server";

import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { addMailDraftAttachments } from "@/server/mail-draft-attachment-service";
import { getMailDraft } from "@/server/mail-draft-repository";

export const runtime = "nodejs";
export const maxDuration = 60;

interface AttachmentRouteContext {
  readonly params: Promise<{ readonly draftId: string }>;
}

export async function POST(request: Request, context: AttachmentRouteContext) {
  const { draftId } = await context.params;
  try {
    const formData = await request.formData();
    const files = formData.getAll("files").filter((item): item is File => item instanceof File);
    const attachments = await addMailDraftAttachments(draftId, files, { inline: formData.get("inline") === "true" });
    return NextResponse.json({ ok: true, attachments, draft: await getMailDraft(draftId) }, { status: 201 });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}
