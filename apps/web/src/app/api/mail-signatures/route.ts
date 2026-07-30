import { NextResponse } from "next/server";

import {
  mailSignatureErrorResponse,
  parseMailSignatureInput,
  type MailSignatureRequestBody,
} from "@/server/mail-signature-api";
import {
  createMailSignature,
  listMailSignatures,
} from "@/server/mail-signature-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const accountId = new URL(request.url).searchParams.get("accountId")?.trim() || undefined;
    return NextResponse.json({ ok: true, signatures: await listMailSignatures(accountId) });
  } catch (error) {
    return mailSignatureErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as MailSignatureRequestBody | null;
    const signature = await createMailSignature(parseMailSignatureInput(body));
    return NextResponse.json({ ok: true, signature }, { status: 201 });
  } catch (error) {
    return mailSignatureErrorResponse(error);
  }
}
