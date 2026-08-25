import { NextResponse } from "next/server";

import {
  mailSignatureErrorResponse,
  parseMailSignatureInput,
  type MailSignatureRequestBody,
} from "@/server/mail-signature-api";
import {
  deleteMailSignature,
  MailSignatureError,
  setDefaultMailSignature,
  updateMailSignature,
} from "@/server/mail-signature-repository";

export const runtime = "nodejs";

interface SignatureRouteContext {
  readonly params: Promise<{ readonly signatureId: string }>;
}

export async function PATCH(request: Request, context: SignatureRouteContext) {
  const { signatureId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as MailSignatureRequestBody | null;
    return NextResponse.json({
      ok: true,
      signature: await updateMailSignature(signatureId, parseMailSignatureInput(body)),
    });
  } catch (error) {
    return mailSignatureErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: SignatureRouteContext) {
  const { signatureId } = await context.params;
  try {
    if (!await deleteMailSignature(signatureId)) {
      throw new MailSignatureError("SIGNATURE_NOT_FOUND", "Die Signatur-Version existiert nicht", 404);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return mailSignatureErrorResponse(error);
  }
}

export async function POST(request: Request, context: SignatureRouteContext) {
  const { signatureId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as { readonly action?: unknown } | null;
    if (body?.action !== "set-default") {
      throw new MailSignatureError("INVALID_SIGNATURE", "Nicht unterstützte Unterschriftenoperationen", 400);
    }
    return NextResponse.json({ ok: true, signature: await setDefaultMailSignature(signatureId) });
  } catch (error) {
    return mailSignatureErrorResponse(error);
  }
}
