import { NextResponse } from "next/server";

import {
  MailSignatureError,
  type MailSignatureInput,
} from "./mail-signature-repository";

export interface MailSignatureRequestBody {
  readonly accountId?: unknown;
  readonly name?: unknown;
  readonly fullText?: unknown;
  readonly shortText?: unknown;
  readonly makeDefault?: unknown;
}

export function parseMailSignatureInput(body: MailSignatureRequestBody | null): MailSignatureInput {
  if (!body || typeof body.accountId !== "string" || typeof body.name !== "string"
    || typeof body.fullText !== "string" || typeof body.shortText !== "string") {
    throw new MailSignatureError("INVALID_SIGNATURE", "Unterschrift Version Informationen sind unvollständig", 400);
  }
  return {
    accountId: body.accountId,
    name: body.name,
    fullText: body.fullText,
    shortText: body.shortText,
    makeDefault: body.makeDefault === true,
  };
}

export function mailSignatureErrorResponse(error: unknown) {
  if (error instanceof MailSignatureError) {
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
  }
  console.error("Mail signature request failed", error);
  return NextResponse.json({ ok: false, message: "Signing fehlgeschlagen, bitte versuchen Sie es später noch einmal" }, { status: 500 });
}
