import { ImapFlow } from "imapflow";
import PostalMime, { type Attachment } from "postal-mime";
import sanitizeHtml from "sanitize-html";

import {
  configuredMailBodyCacheMaxAgeMs,
  getAccount,
  getStoredMessageRemote,
  getStoredMessageBody,
  loadExchangeMailCredential,
  loadImapSmtpCredential,
  MAIL_BODY_CACHE_VERSION,
  saveMessageBody,
  type StoredMessageBody,
} from "./mail-repository";
import { fetchExchangeMailMessageDetails, getExchangeAttachment, type ExchangeMailAttachment } from "./exchange-mail";

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i;
const SAFE_LOCAL_INLINE_IMAGE_URL = /^\/api\/messages\/[a-z0-9%._~-]+\/attachments\/\d+$/i;
const SAFE_CSS_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-z]{3,24})$/i;
const SAFE_CSS_LENGTH = /^(?:auto|0|\d+(?:\.\d+)?(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|%))$/i;
const SAFE_CSS_BOX = /^(?:auto|0|\d+(?:\.\d+)?(?:px|pt|em|rem|%))(?:\s+(?:auto|0|\d+(?:\.\d+)?(?:px|pt|em|rem|%))){0,3}$/i;

declare global {
  var kalenderActiveBodyLoads: Map<string, Promise<MailBodyResult>> | undefined;
}

export interface MailBodyResult {
  readonly text?: string;
  readonly html?: string;
  readonly snippet: string;
  readonly loadedAt: string;
  readonly cached: boolean;
  readonly hasBlockedRemoteImages: boolean;
}

export interface DownloadedMailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly inline: boolean;
}

export class MailBodyNotFoundError extends Error {
  constructor(message = "邮件不存在或已被移动") {
    super(message);
    this.name = "MailBodyNotFoundError";
  }
}

export function shouldUseMailBodyCache(
  loadedAt: string | undefined,
  cacheVersion: number,
  forceRefresh = false,
  now = Date.now(),
  maxAgeMs = configuredMailBodyCacheMaxAgeMs(),
): boolean {
  if (forceRefresh || !loadedAt || cacheVersion < MAIL_BODY_CACHE_VERSION) return false;
  const loadedAtMs = Date.parse(loadedAt);
  return Number.isFinite(loadedAtMs) && now - loadedAtMs <= Math.max(0, maxAgeMs);
}

export async function getMailBody(
  messageId: string,
  options: { readonly forceRefresh?: boolean } = {},
): Promise<MailBodyResult> {
  const stored = await getStoredMessageBody(messageId);
  if (!stored) throw new MailBodyNotFoundError();
  const forceRefresh = Boolean(options.forceRefresh);
  if (shouldUseMailBodyCache(stored.loadedAt, stored.cacheVersion, forceRefresh)) return toResult(stored, true);

  const activeLoads = globalThis.kalenderActiveBodyLoads ??= new Map();
  const existing = activeLoads.get(messageId);
  if (existing) return existing;
  const load = fetchAndCacheBody(stored)
    .catch((error: unknown) => {
      if (stored.loadedAt && !forceRefresh) return toResult(stored, true);
      throw error;
    })
    .finally(() => activeLoads.delete(messageId));
  activeLoads.set(messageId, load);
  return load;
}

export async function getMailAttachment(messageId: string, attachmentIndex: number): Promise<DownloadedMailAttachment> {
  if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex > 99) throw new MailBodyNotFoundError("附件不存在");
  const stored = await getStoredMessageBody(messageId);
  if (!stored) throw new MailBodyNotFoundError();
  const account = await getAccount(stored.accountId);
  if (account?.providerId === "exchange-ews") {
    const remote = await getStoredMessageRemote(messageId);
    const metadata = remote?.attachments[attachmentIndex];
    if (!metadata?.id) throw new MailBodyNotFoundError("附件不存在");
    const credential = await loadExchangeMailCredential(stored.accountId);
    const attachment = await getExchangeAttachment(credential, metadata.id, AbortSignal.timeout(30_000));
    if (attachment.content.byteLength > MAX_MESSAGE_BYTES) throw new Error("附件超过 25 MB 安全上限");
    return {
      filename: safeAttachmentFilename(attachment.filename || metadata.filename || `attachment-${attachmentIndex + 1}`),
      contentType: attachment.contentType || metadata.contentType || "application/octet-stream",
      content: attachment.content,
      inline: Boolean(metadata.inline),
    };
  }
  const parsed = await fetchParsedMessage(stored);
  const attachment = parsed.attachments[attachmentIndex];
  if (!attachment) throw new MailBodyNotFoundError("附件不存在");
  const content = attachmentBytes(attachment);
  if (!content) throw new MailBodyNotFoundError("附件内容不可用");
  if (content.byteLength > MAX_MESSAGE_BYTES) throw new Error("附件超过 25 MB 安全上限");
  return {
    filename: safeAttachmentFilename(attachment.filename ?? `attachment-${attachmentIndex + 1}`),
    contentType: attachment.mimeType || "application/octet-stream",
    content,
    inline: attachment.disposition === "inline" || Boolean(attachment.related),
  };
}

export function sanitizeEmailHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: [
      "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4",
      "hr", "i", "img", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td",
      "tfoot", "th", "thead", "tr", "u", "ul",
    ],
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, target: "_blank", rel: "noopener noreferrer" },
      }),
      img: (_tagName, attributes) => sanitizeImageTag(attributes),
    },
    allowedAttributes: {
      "*": ["style", "align", "dir", "title"],
      a: ["href", "title", "target", "rel", "style"],
      img: ["src", "data-remote-src", "alt", "title", "width", "height", "style", "loading", "referrerpolicy"],
      table: ["width", "height", "align", "cellpadding", "cellspacing", "border", "bgcolor", "role", "style"],
      td: ["width", "height", "align", "valign", "colspan", "rowspan", "bgcolor", "style"],
      th: ["width", "height", "align", "valign", "colspan", "rowspan", "bgcolor", "style"],
    },
    allowedStyles: {
      "*": {
        color: [SAFE_CSS_COLOR],
        "background-color": [SAFE_CSS_COLOR],
        display: [/^(?:none|block|inline|inline-block|table|table-row|table-cell)$/i],
        "font-family": [/^[\w\s,'".-]{1,160}$/],
        "font-size": [SAFE_CSS_LENGTH],
        "font-style": [/^(?:normal|italic|oblique)$/i],
        "font-weight": [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
        "line-height": [/^(?:normal|\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:px|pt|em|rem|%))$/i],
        "letter-spacing": [SAFE_CSS_LENGTH],
        "text-align": [/^(?:left|right|center|justify|start|end)$/i],
        "text-decoration": [/^(?:none|underline|line-through)$/i],
        "text-transform": [/^(?:none|uppercase|lowercase|capitalize)$/i],
        "vertical-align": [/^(?:baseline|top|middle|bottom|text-top|text-bottom|sub|super)$/i, SAFE_CSS_LENGTH],
        width: [SAFE_CSS_LENGTH],
        "min-width": [SAFE_CSS_LENGTH],
        "max-width": [SAFE_CSS_LENGTH],
        height: [SAFE_CSS_LENGTH],
        "min-height": [SAFE_CSS_LENGTH],
        "max-height": [SAFE_CSS_LENGTH],
        margin: [SAFE_CSS_BOX],
        "margin-top": [SAFE_CSS_LENGTH],
        "margin-right": [SAFE_CSS_LENGTH],
        "margin-bottom": [SAFE_CSS_LENGTH],
        "margin-left": [SAFE_CSS_LENGTH],
        padding: [SAFE_CSS_BOX],
        "padding-top": [SAFE_CSS_LENGTH],
        "padding-right": [SAFE_CSS_LENGTH],
        "padding-bottom": [SAFE_CSS_LENGTH],
        "padding-left": [SAFE_CSS_LENGTH],
        "border-radius": [SAFE_CSS_BOX],
        "border-collapse": [/^(?:collapse|separate)$/i],
        "white-space": [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i],
        "word-break": [/^(?:normal|break-all|keep-all|break-word)$/i],
        overflow: [/^(?:visible|hidden|auto|scroll)$/i],
      },
    },
  });
}

export function resolveExchangeInlineImages(
  input: string,
  attachments: readonly ExchangeMailAttachment[],
  messageId: string,
): string {
  const sourceByContentId = new Map<string, string>();
  attachments.forEach((attachment, index) => {
    if (!attachment.inline || !attachment.contentId || !/^image\/(?:png|jpe?g|gif|webp)$/i.test(attachment.contentType)) return;
    const contentId = normalizeContentId(attachment.contentId);
    if (!contentId) return;
    sourceByContentId.set(contentId, `/api/messages/${encodeURIComponent(messageId)}/attachments/${index}`);
  });
  if (!sourceByContentId.size) return input;
  return input.replace(/cid:([^\s"'<>]+)/gi, (original, rawId: string) => {
    const contentId = normalizeContentId(rawId);
    return contentId ? sourceByContentId.get(contentId) ?? original : original;
  });
}

export function resolveCidImages(input: string, attachments: readonly Attachment[]): string {
  const inlineImages = new Map<string, string>();
  let totalBytes = 0;
  for (const attachment of attachments) {
    const contentId = normalizeContentId(attachment.contentId);
    if (!contentId || !/^image\/(?:png|jpe?g|gif|webp)$/i.test(attachment.mimeType)) continue;
    const bytes = attachmentBytes(attachment);
    if (!bytes || bytes.byteLength > MAX_INLINE_IMAGE_BYTES || totalBytes + bytes.byteLength > MAX_TOTAL_INLINE_IMAGE_BYTES) continue;
    totalBytes += bytes.byteLength;
    inlineImages.set(contentId, `data:${attachment.mimeType.toLocaleLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`);
  }
  if (!inlineImages.size) return input;
  return input.replace(/cid:([^\s"'<>]+)/gi, (original, rawId: string) => {
    const contentId = normalizeContentId(rawId);
    return contentId ? inlineImages.get(contentId) ?? original : original;
  });
}

async function fetchAndCacheBody(stored: StoredMessageBody): Promise<MailBodyResult> {
  const account = await getAccount(stored.accountId);
  if (account?.providerId === "exchange-ews") return fetchAndCacheExchangeBody(stored);
  const parsed = await fetchParsedMessage(stored);
  const text = cleanText(parsed.text);
  const html = parsed.html ? sanitizeEmailHtml(resolveCidImages(parsed.html, parsed.attachments)) : undefined;
  const snippet = createSnippet(text || htmlToText(html) || "（邮件正文为空）");
  const saved = await saveMessageBody(stored.id, text || undefined, html || undefined, snippet);
  if (!saved?.loadedAt) throw new Error("无法缓存邮件正文");
  return toResult(saved, false);
}

async function fetchAndCacheExchangeBody(stored: StoredMessageBody): Promise<MailBodyResult> {
  const remote = await getStoredMessageRemote(stored.id);
  if (!remote?.providerMessageId) throw new MailBodyNotFoundError();
  const credential = await loadExchangeMailCredential(stored.accountId);
  const [message] = await fetchExchangeMailMessageDetails(
    credential,
    [{ itemId: remote.providerMessageId }],
    AbortSignal.timeout(30_000),
  );
  if (!message) throw new MailBodyNotFoundError();
  const html = message.htmlBody
    ? sanitizeEmailHtml(resolveExchangeInlineImages(message.htmlBody, message.attachments, stored.id))
    : undefined;
  const text = cleanText(message.textBody);
  const snippet = createSnippet(text || htmlToText(html) || "（邮件正文为空）");
  const saved = await saveMessageBody(stored.id, text || undefined, html || undefined, snippet);
  if (!saved?.loadedAt) throw new Error("无法缓存 Exchange 邮件正文");
  return toResult(saved, false);
}

async function fetchParsedMessage(stored: StoredMessageBody) {
  const account = await getAccount(stored.accountId);
  if (!account || account.syncStatus === "paused") throw new MailBodyNotFoundError("邮箱账户不可用");
  const credential = await loadImapSmtpCredential(stored.accountId);
  const client = new ImapFlow({
    host: credential.imap.host,
    port: credential.imap.port,
    secure: credential.imap.secure,
    servername: credential.imap.host,
    auth: { user: credential.imap.username, pass: credential.imap.password },
    logger: false,
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 30_000,
    maxLineLength: 2 * 1024 * 1024,
    maxLiteralSize: MAX_MESSAGE_BYTES,
    tls: { rejectUnauthorized: true, servername: credential.imap.host },
  });

  try {
    await client.connect();
    await client.mailboxOpen(stored.providerFolderId, { readOnly: true });
    const message = await client.fetchOne(
      String(stored.providerUid),
      { uid: true, source: { maxLength: MAX_MESSAGE_BYTES + 1 } },
      { uid: true },
    );
    if (!message || !message.source) throw new MailBodyNotFoundError();
    if (message.source.length > MAX_MESSAGE_BYTES) throw new Error("邮件正文超过 25 MB 安全上限");

    return await PostalMime.parse(message.source, {
      maxHeadersSize: 256 * 1024,
      maxNestingDepth: 20,
    });
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function safeAttachmentFilename(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  return (sanitized || "attachment").slice(0, 180);
}

function cleanText(value?: string): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

function htmlToText(value?: string): string {
  if (!value) return "";
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
}

function createSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
}

function sanitizeImageTag(attributes: Record<string, string>): sanitizeHtml.Tag {
  const source = attributes.src?.trim();
  const attribs: Record<string, string> = { ...attributes, loading: "lazy", referrerpolicy: "no-referrer" };
  delete attribs.src;
  delete attribs["data-remote-src"];
  if (source && SAFE_LOCAL_INLINE_IMAGE_URL.test(source)) {
    attribs.src = source;
  } else if (source && SAFE_IMAGE_DATA_URL.test(source) && source.length <= Math.ceil(MAX_INLINE_IMAGE_BYTES * 4 / 3) + 128) {
    attribs.src = source;
  } else {
    const remoteSource = safeRemoteImageUrl(source);
    if (remoteSource) attribs["data-remote-src"] = remoteSource;
  }
  return { tagName: "img", attribs };
}

function safeRemoteImageUrl(value?: string): string | undefined {
  if (!value || value.length > 4096) return undefined;
  const normalized = value.startsWith("//") ? `https:${value}` : value;
  try {
    const url = new URL(normalized);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeContentId(value?: string): string | undefined {
  if (!value) return undefined;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Keep the original MIME identifier. */ }
  const normalized = decoded.trim().replace(/^<|>$/g, "").toLocaleLowerCase();
  return normalized || undefined;
}

function attachmentBytes(attachment: Attachment): Uint8Array | undefined {
  if (typeof attachment.content === "string") {
    try {
      return attachment.encoding === "base64"
        ? new Uint8Array(Buffer.from(attachment.content, "base64"))
        : new Uint8Array(Buffer.from(attachment.content));
    } catch {
      return undefined;
    }
  }
  return attachment.content instanceof Uint8Array
    ? attachment.content
    : new Uint8Array(attachment.content);
}

function toResult(stored: StoredMessageBody, cached: boolean): MailBodyResult {
  return {
    text: stored.textBody,
    html: stored.htmlBody,
    snippet: stored.snippet,
    loadedAt: stored.loadedAt!,
    cached,
    hasBlockedRemoteImages: Boolean(stored.htmlBody?.includes("data-remote-src=")),
  };
}
