import { NextResponse } from "next/server";

import { MailDraftAttachmentError } from "./mail-draft-attachment-service";
import { MailDraftRepositoryError } from "./mail-draft-repository";
import { MailDraftValidationError } from "./mail-draft-validation";
import { MailSendError } from "./mail-send-service";

export function mailDraftErrorResponse(error: unknown): NextResponse {
  if (error instanceof MailDraftRepositoryError || error instanceof MailDraftValidationError || error instanceof MailDraftAttachmentError || error instanceof MailSendError) {
    return NextResponse.json({ ok: false, code: "code" in error ? error.code : "INVALID_DRAFT", message: error.message }, { status: error.status });
  }
  console.error("Mail draft request failed", error);
  const message = process.env.NODE_ENV === "development" && error instanceof Error
    ? error.message
    : "无法处理邮件草稿";
  return NextResponse.json({ ok: false, code: "MAIL_DRAFT_ERROR", message }, { status: 500 });
}
