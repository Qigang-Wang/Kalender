import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { MailConnectionError, type MailServerConnection } from "./imap-smtp-test";

export interface ServerInput {
  readonly host?: unknown;
  readonly port?: unknown;
  readonly secure?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}

export function withRetainedPassword(
  input: ServerInput | undefined,
  stored: MailServerConnection | undefined,
): ServerInput | undefined {
  if (!stored || (typeof input?.password === "string" && input.password.length > 0)) return input;
  return { ...input, password: stored.password };
}

export function parseServer(input: ServerInput | undefined, label: "IMAP" | "SMTP"): MailServerConnection {
  if (!input || typeof input.host !== "string" || typeof input.username !== "string" || typeof input.password !== "string") {
    throw new PublicConnectionError("INVALID_REQUEST", `请完整填写 ${label} 服务器、用户名和密码`, 400);
  }
  const host = input.host.trim().toLocaleLowerCase();
  const port = typeof input.port === "number" ? input.port : Number.NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !input.username || !input.password) {
    throw new PublicConnectionError("INVALID_REQUEST", `${label} 连接参数无效`, 400);
  }
  return { host, port, secure: input.secure !== false, username: input.username, password: input.password };
}

export async function assertPublicMailHost(host: string): Promise<void> {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new PublicConnectionError("UNSAFE_HOST", "出于安全原因，连接测试不能访问本机或 .local 地址", 400);
  }
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new PublicConnectionError("DNS_FAILED", "无法解析邮件服务器地址", 400);
      });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicConnectionError("UNSAFE_HOST", "出于安全原因，连接测试不能访问内网或保留地址", 400);
  }
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function toPublicError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof PublicConnectionError) return error;
  if (error instanceof MailConnectionError) {
    if (error.code === "AUTH_REQUIRED") return { code: error.code, message: "服务器拒绝了用户名、密码或应用专用密码", status: 401 };
    if (error.code === "NETWORK_ERROR") return { code: error.code, message: "无法连接邮件服务器，请检查地址、端口和加密方式", status: 502 };
    if (error.code === "CANCELLED") return { code: error.code, message: "连接测试超时", status: 504 };
    return { code: error.code, message: "邮件服务器拒绝了连接测试", status: 502 };
  }
  const message = error instanceof Error && /^(邮箱认证失败|无法连接邮件服务器|首次邮件同步失败)/.test(error.message)
    ? error.message
    : "操作失败";
  return { code: "REMOTE_ERROR", message, status: 502 };
}

export class PublicConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase();
  if (normalized.includes(":")) {
    return !(
      normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  const parts = normalized.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
