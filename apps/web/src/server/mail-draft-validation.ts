import { decodeNoteContent, encodeNoteContent, noteContentToPlainText } from "../lib/note-content";

export interface MailDraftRequestBody {
  readonly accountId?: unknown;
  readonly replyToMessageId?: unknown;
  readonly to?: unknown;
  readonly cc?: unknown;
  readonly bcc?: unknown;
  readonly subject?: unknown;
  readonly textBody?: unknown;
  readonly bodyContent?: unknown;
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
}

export class MailDraftValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MailDraftValidationError";
  }
}

export function parseMailDraftInput(body: MailDraftRequestBody | null): ParsedMailDraftInput {
  if (!body || typeof body.accountId !== "string" || !body.accountId.trim()) {
    throw new MailDraftValidationError("请选择发件账户");
  }
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const fallbackText = typeof body.textBody === "string" ? body.textBody.replace(/\r\n?/g, "\n") : "";
  const rawBodyContent = typeof body.bodyContent === "string" ? body.bodyContent : fallbackText;
  if (rawBodyContent.length > 500_000) throw new MailDraftValidationError("邮件富文本正文不能超过 500000 个字符");
  const bodyContent = encodeNoteContent(decodeNoteContent(rawBodyContent));
  const textBody = noteContentToPlainText(bodyContent);
  if (subject.length > 500) throw new MailDraftValidationError("邮件主题不能超过 500 个字符");
  if (textBody.length > 200_000) throw new MailDraftValidationError("邮件正文不能超过 200000 个字符");
  return {
    accountId: body.accountId.trim(),
    replyToMessageId: typeof body.replyToMessageId === "string" && body.replyToMessageId ? body.replyToMessageId : undefined,
    to: parseAddresses(body.to, "收件人"),
    cc: parseAddresses(body.cc, "抄送"),
    bcc: parseAddresses(body.bcc, "密送"),
    subject,
    textBody,
    bodyContent,
  };
}

export function assertDraftCanSend(input: ParsedMailDraftInput, hasInlineImage = false): void {
  if (input.to.length + input.cc.length + input.bcc.length === 0) {
    throw new MailDraftValidationError("请至少填写一个收件人");
  }
  if (!input.subject) throw new MailDraftValidationError("请输入邮件主题");
  if (!input.textBody.trim() && !hasInlineImage) throw new MailDraftValidationError("请输入邮件正文");
  for (const [label, addresses] of [["收件人", input.to], ["抄送", input.cc], ["密送", input.bcc]] as const) {
    const invalid = addresses.find((address) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address));
    if (invalid) throw new MailDraftValidationError(`${label}包含无效邮箱地址：${invalid}`);
  }
}

function parseAddresses(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new MailDraftValidationError(`${label}格式无效`);
  const unique = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") throw new MailDraftValidationError(`${label}格式无效`);
    const address = item.trim();
    if (!address || address.length > 320) throw new MailDraftValidationError(`${label}格式无效`);
    unique.set(address.toLocaleLowerCase(), address);
  }
  return [...unique.values()];
}
