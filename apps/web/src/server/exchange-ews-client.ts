import { assertPublicMailHost, PublicConnectionError } from "./mail-account-validation";

export const RWTH_EWS_URL = "https://mail.rwth-aachen.de/EWS/Exchange.asmx";

export interface ExchangeCredential {
  readonly kind: "exchange";
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
}

export type ExchangeSoapAction =
  | "GetFolder"
  | "CreateFolder"
  | "UpdateFolder"
  | "MoveFolder"
  | "DeleteFolder"
  | "FindFolder"
  | "FindItem"
  | "GetItem"
  | "GetAttachment"
  | "CreateItem"
  | "CreateAttachment"
  | "UpdateItem"
  | "MoveItem"
  | "DeleteItem"
  | "SendItem"
  | "SyncFolderItems";

export class ExchangeEwsError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ExchangeEwsError";
  }
}

export function parseExchangeCredential(input: unknown): ExchangeCredential {
  if (!input || typeof input !== "object") {
    throw new PublicConnectionError("INVALID_REQUEST", "请完整填写 Exchange 用户名和密码", 400);
  }
  const value = input as Record<string, unknown>;
  const rawServerUrl = typeof value.serverUrl === "string" && value.serverUrl.trim()
    ? value.serverUrl.trim()
    : RWTH_EWS_URL;
  if (typeof value.username !== "string" || typeof value.password !== "string" || !value.username.trim() || !value.password) {
    throw new PublicConnectionError("INVALID_REQUEST", "请完整填写 Exchange 用户名和密码", 400);
  }
  let url: URL;
  try {
    url = new URL(rawServerUrl);
  } catch {
    throw new PublicConnectionError("INVALID_URL", "Exchange EWS 服务地址无效", 400);
  }
  if (url.protocol !== "https:") {
    throw new PublicConnectionError("HTTPS_REQUIRED", "Exchange EWS 服务必须使用 HTTPS", 400);
  }
  url.hash = "";
  return {
    kind: "exchange",
    serverUrl: url.toString(),
    username: value.username.trim(),
    password: value.password,
  };
}

export async function exchangeSoapRequest(
  credential: ExchangeCredential,
  action: ExchangeSoapAction,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
      xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
      xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
      <s:Header>
        <t:RequestServerVersion Version="Exchange2016"/>
        <t:TimeZoneContext><t:TimeZoneDefinition Id="W. Europe Standard Time"/></t:TimeZoneContext>
      </s:Header>
      <s:Body>${body}</s:Body>
    </s:Envelope>`;
  let url = new URL(credential.serverUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (url.protocol !== "https:") throw new ExchangeEwsError("HTTPS_REQUIRED", "Exchange EWS 服务必须使用 HTTPS", 400);
    await assertPublicMailHost(url.hostname);
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`,
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `http://schemas.microsoft.com/exchange/services/2006/messages/${action}`,
      },
      body: envelope,
      signal,
    });
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ExchangeEwsError("INVALID_REDIRECT", "Exchange 服务器返回了无效跳转", 502);
      url = new URL(location, url);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new ExchangeEwsError("AUTH_REQUIRED", "Exchange 拒绝了登录。请检查 RWTH-E-Mail 用户名和密码", 401);
    }
    const xml = await response.text();
    if (!response.ok) {
      const message = elementText(xml, "MessageText") || `Exchange 服务器返回 HTTP ${response.status}`;
      throw new ExchangeEwsError("REMOTE_ERROR", message, 502);
    }
    assertExchangeSuccess(xml);
    return xml;
  }
  throw new ExchangeEwsError("TOO_MANY_REDIRECTS", "Exchange 服务器跳转次数过多", 502);
}

export function assertExchangeSuccess(xml: string): void {
  const responseCodes = elementContents(xml, "ResponseCode").map((value) => decodeXml(stripTags(value).trim())).filter(Boolean);
  const failedCode = responseCodes.find((code) => code !== "NoError");
  if (!failedCode && responseCodes.length) return;
  if (!responseCodes.length && !elementContent(xml, "Fault")) return;
  const message = elementText(xml, "MessageText") || elementText(xml, "faultstring") || failedCode || "Exchange 返回了无法识别的错误";
  const authError = /AccessDenied|InvalidUser|NonExistentMailbox|InvalidCredentials/i.test(`${failedCode} ${message}`);
  const conflictError = /ChangeKey|IrresolvableConflict|ItemNotFound|StaleObject/i.test(`${failedCode} ${message}`);
  throw new ExchangeEwsError(
    authError ? "AUTH_REQUIRED" : conflictError ? "REMOTE_CONFLICT" : failedCode || "SOAP_ERROR",
    conflictError ? "RWTH 项目已在其他客户端发生变化，请先同步后重试" : message,
    authError ? 401 : conflictError ? 409 : 502,
  );
}

export function elementContents(xml: string, name: string): readonly string[] {
  const expression = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, "gi");
  return [...xml.matchAll(expression)].map((match) => match[1] ?? "");
}

export function elementContent(xml: string, name: string): string | undefined {
  return elementContents(xml, name)[0];
}

export function elementText(xml: string, name: string): string {
  const content = elementContent(xml, name);
  return content === undefined ? "" : decodeXml(stripTags(content).trim());
}

export function openingTag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>`, "i"))?.[0];
}

export function attributeValue(tag: string, name: string): string | undefined {
  const value = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

export function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

export function toExchangePublicError(error: unknown): { readonly code: string; readonly message: string; readonly status: number } {
  if (error instanceof ExchangeEwsError || error instanceof PublicConnectionError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof Error && (error.name === "AbortError" || /timeout|aborted/i.test(error.message))) {
    return { code: "TIMEOUT", message: "Exchange 连接或同步超时", status: 504 };
  }
  return { code: "EXCHANGE_ERROR", message: "无法连接 Exchange 服务", status: 502 };
}
