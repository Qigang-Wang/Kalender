import { NextResponse } from "next/server";

import { mailDraftErrorResponse } from "@/server/mail-draft-api";
import { createMailDraft, listMailDrafts } from "@/server/mail-draft-repository";
import { parseMailDraftInput, type MailDraftRequestBody } from "@/server/mail-draft-validation";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, drafts: await listMailDrafts() });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as MailDraftRequestBody | null;
    const draft = await createMailDraft(parseMailDraftInput(body));
    return NextResponse.json({ ok: true, draft }, { status: 201 });
  } catch (error) {
    return mailDraftErrorResponse(error);
  }
}
