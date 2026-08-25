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
    throw new PublicConnectionError("INVALID_REQUEST", `bitte ausfüllen ${label} Server, Benutzername und Passwort`, 400);
  }
  const host = input.host.trim().toLocaleLowerCase();
  const port = typeof input.port === "number" ? input.port : Number.NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !input.username || !input.password) {
    throw new PublicConnectionError("INVALID_REQUEST", `${label} Verbindungsparameter ungültig`, 400);
  }
  return { host, port, secure: input.secure !== false, username: input.username, password: input.password };
}

export async function assertPublicMailHost(host: string): Promise<void> {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new PublicConnectionError("UNSAFE_HOST", "Aus Sicherheitsgründen erlaubt der Verbindungstest keinen Zugriff auf den Host oder die lokale Adresse.", 400);
  }
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new PublicConnectionError("DNS_FAILED", "E-Mail-Server-Adresse kann nicht geparst werden", 400);
      });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicConnectionError("UNSAFE_HOST", "Aus Sicherheitsgründen kann der Verbindungstest nicht auf das Intranet zugreifen oder die Adresse behalten", 400);
  }
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function toPublicError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof PublicConnectionError) return error;
  if (error instanceof MailConnectionError) {
    if (error.code === "AUTH_REQUIRED") return { code: error.code, message: "der Server hat einen Benutzernamen, ein Passwort oder ein Anwendungspasswort abgelehnt", status: 401 };
    if (error.code === "NETWORK_ERROR") return { code: error.code, message: "Verbindung zu Mailserver, Adresse, Port und Verschlüsselung nicht möglich", status: 502 };
    if (error.code === "CANCELLED") return { code: error.code, message: "Zeitabschaltung des Verbindungstests", status: 504 };
    return { code: error.code, message: "der Mailserver lehnte den Verbindungstest ab", status: 502 };
  }
  const message = error instanceof Error && /^(?:Postfachauthentifizierung fehlgeschlagen|Verbindung zum Mailserver nicht möglich|Erste E-Mail-Synchronisierung fehlgeschlagen)/i.test(error.message)
    ? error.message
    : "Betrieb fehlgeschlagen";
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
