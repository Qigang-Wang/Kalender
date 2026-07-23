import { ImapFlow } from "imapflow";
import * as nodemailer from "nodemailer";

export interface MailServerConnection {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
}

export interface ImapSmtpTestResult {
  readonly ok: true;
  readonly identity: string;
  readonly latencyMs: number;
  readonly checks: readonly {
    readonly name: "authentication" | "mail_read" | "smtp_connection";
    readonly status: "passed";
    readonly message?: string;
  }[];
}

const CONNECTION_TIMEOUT_MS = 12_000;

export async function testImapSmtpConnection(
  identity: string,
  imap: MailServerConnection,
  smtp: MailServerConnection,
  signal: AbortSignal,
): Promise<ImapSmtpTestResult> {
  const startedAt = Date.now();
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    servername: imap.host,
    auth: { user: imap.username, pass: imap.password },
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: 30_000,
    maxLineLength: 2 * 1024 * 1024,
    maxLiteralSize: 25 * 1024 * 1024,
    tls: { rejectUnauthorized: true, servername: imap.host },
  });
  const closeImap = () => client.close();
  signal.addEventListener("abort", closeImap, { once: true });
  let folderCount = 0;
  try {
    await client.connect();
    folderCount = (await client.list({ statusQuery: { messages: true, unseen: true } })).length;
  } catch (error) {
    throw normalizeConnectionError(error, signal);
  } finally {
    signal.removeEventListener("abort", closeImap);
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      client.close();
    }
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.username, pass: smtp.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: 30_000,
    tls: { rejectUnauthorized: true, servername: smtp.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const closeSmtp = () => transport.close();
  signal.addEventListener("abort", closeSmtp, { once: true });
  try {
    await transport.verify();
  } catch (error) {
    throw normalizeConnectionError(error, signal);
  } finally {
    signal.removeEventListener("abort", closeSmtp);
    transport.close();
  }

  return {
    ok: true,
    identity,
    latencyMs: Date.now() - startedAt,
    checks: [
      { name: "authentication", status: "passed" },
      { name: "mail_read", status: "passed", message: `${folderCount} folders available` },
      { name: "smtp_connection", status: "passed" },
    ],
  };
}

export class MailConnectionError extends Error {
  constructor(
    readonly code: "AUTH_REQUIRED" | "NETWORK_ERROR" | "CANCELLED" | "REMOTE_ERROR",
    message: string,
  ) {
    super(message);
  }
}

function normalizeConnectionError(error: unknown, signal: AbortSignal): MailConnectionError {
  if (signal.aborted) return new MailConnectionError("CANCELLED", "Mail server connection timed out");
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const responseCode = typeof error === "object" && error !== null && "responseCode" in error ? Number(error.responseCode) : undefined;
  if (/AUTH|EAUTH|LOGIN/i.test(code) || responseCode === 535) {
    return new MailConnectionError("AUTH_REQUIRED", "Mail server rejected the credentials");
  }
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ESOCKET|ECONNECTION/i.test(code)) {
    return new MailConnectionError("NETWORK_ERROR", "Unable to reach the mail server");
  }
  return new MailConnectionError("REMOTE_ERROR", "Mail server rejected the connection test");
}
