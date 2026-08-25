import { decodeNoteContent, encodeNoteContent, noteContentToPlainText } from "../lib/note-content";
import type { MailSignatureVariant } from "../lib/mail-signature-content";

export interface MailDraftRequestBody {
  readonly accountId?: unknown;
  readonly replyToMessageId?: unknown;
  readonly to?: unknown;
  readonly cc?: unknown;
  readonly bcc?: unknown;
  readonly subject?: unknown;
  readonly textBody?: unknown;
  readonly bodyContent?: unknown;
  readonly signatureId?: unknown;
  readonly signatureVariant?: unknown;
}

export interface ParsedMailDraftInput {
  readonly accountId: string;
  readonly replyToMessageId?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  readonly bodyContent: string;
  readonly signatureId?: string;
  readonly signatureVariant?: MailSignatureVariant;
}

export class MailDraftValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MailDraftValidationError";
  }
}

export function parseMailDraftInput(body: MailDraftRequestBody | null): ParsedMailDraftInput {
  if (!body || typeof body.accountId !== "string" || !body.accountId.trim()) {
    throw new MailDraftValidationError("Wählen Sie das Absenderkonto aus");
  }
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const fallbackText = typeof body.textBody === "string" ? body.textBody.replace(/\r\n?/g, "\n") : "";
  const rawBodyContent = typeof body.bodyContent === "string" ? body.bodyContent : fallbackText;
  if (rawBodyContent.length > 500_000) throw new MailDraftValidationError("Mail Rich Text Text kann nicht mehr als 500.000 Zeichen");
  const bodyContent = encodeNoteContent(decodeNoteContent(rawBodyContent));
  const textBody = noteContentToPlainText(bodyContent);
  if (subject.length > 500) throw new MailDraftValidationError("Das E-Mail-Thema darf 500 Zeichen nicht überschreiten");
  if (textBody.length > 200_000) throw new MailDraftValidationError("Mailtext darf 200000 Zeichen nicht überschreiten");
  return {
    accountId: body.accountId.trim(),
    replyToMessageId: typeof body.replyToMessageId === "string" && body.replyToMessageId ? body.replyToMessageId : undefined,
    to: parseAddresses(body.to, "Empfänger"),
    cc: parseAddresses(body.cc, "Kopieren"),
    bcc: parseAddresses(body.bcc, "Geheimnis"),
    subject,
    textBody,
    bodyContent,
    signatureId: typeof body.signatureId === "string" && body.signatureId ? body.signatureId : undefined,
    signatureVariant: body.signatureVariant === "full" || body.signatureVariant === "short"
      ? body.signatureVariant
      : undefined,
  };
}

export function assertDraftCanSend(input: ParsedMailDraftInput, hasInlineImage = false): void {
  if (input.to.length + input.cc.length + input.bcc.length === 0) {
    throw new MailDraftValidationError("Bitte füllen Sie mindestens einen Empfänger aus");
  }
  if (!input.subject) throw new MailDraftValidationError("Bitte geben Sie das Thema für die Mail ein");
  if (!input.textBody.trim() && !hasInlineImage) throw new MailDraftValidationError("Geben Sie den Text der Mail ein");
  for (const [label, addresses] of [["Empfänger", input.to], ["Kopieren", input.cc], ["Geheimnis", input.bcc]] as const) {
    const invalid = addresses.find((address) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address));
    if (invalid) throw new MailDraftValidationError(`${label}enthält ungültige Postfachadressen:${invalid}`);
  }
}

function parseAddresses(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new MailDraftValidationError(`${label}Ungültiges Format`);
  const unique = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") throw new MailDraftValidationError(`${label}Ungültiges Format`);
    const address = item.trim();
    if (!address || address.length > 320) throw new MailDraftValidationError(`${label}Ungültiges Format`);
    unique.set(address.toLocaleLowerCase(), address);
  }
  return [...unique.values()];
}
