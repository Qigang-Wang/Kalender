import { NextResponse } from "next/server";

import { testImapSmtpConnection } from "@/server/imap-smtp-test";
import {
  assertPublicMailHost,
  isEmail,
  parseServer,
  toPublicError,
  withRetainedPassword,
  type ServerInput,
} from "@/server/mail-account-validation";
import { getAccount, loadImapSmtpCredential } from "@/server/mail-repository";

export const runtime = "nodejs";

interface TestConnectionBody {
  readonly accountId?: unknown;
  readonly providerId?: unknown;
  readonly emailAddress?: unknown;
  readonly displayName?: unknown;
  readonly imap?: ServerInput;
  readonly smtp?: ServerInput;
}

export async function POST(request: Request) {
  let body: TestConnectionBody;
  try {
    body = await request.json() as TestConnectionBody;
  } catch {
    return NextResponse.json({ ok: false, message: "Ungültiges angefordertes Format" }, { status: 400 });
  }
  if (typeof body.emailAddress !== "string" || !isEmail(body.emailAddress)) {
    return NextResponse.json({ ok: false, message: "Bitte geben Sie eine gültige Postfachadresse ein" }, { status: 400 });
  }
  if (typeof body.providerId !== "string") {
    return NextResponse.json({ ok: false, message: "Bitte wählen Sie die Art der Mailbox" }, { status: 400 });
  }

  if (body.providerId !== "imap") {
    return NextResponse.json(
      { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Der echte Mailbox-Anschluss ist nicht konfiguriert und steht derzeit nicht zur Verfügung, um das erfolgreiche Ergebnis der Verbindung zu verfälschen." },
      { status: 501 },
    );
  }

  try {
    const accountId = typeof body.accountId === "string" && body.accountId ? body.accountId : undefined;
    const account = accountId ? await getAccount(accountId) : undefined;
    if (accountId && !account) {
      return NextResponse.json({ ok: false, message: "Mailbox-Konten existieren nicht" }, { status: 404 });
    }
    const stored = accountId ? await loadImapSmtpCredential(accountId) : undefined;
    const imap = parseServer(withRetainedPassword(body.imap, stored?.imap), "IMAP");
    const smtp = parseServer(withRetainedPassword(body.smtp, stored?.smtp), "SMTP");
    await Promise.all([assertPublicMailHost(imap.host), assertPublicMailHost(smtp.host)]);
    const result = await testImapSmtpConnection(body.emailAddress, imap, smtp, AbortSignal.timeout(30_000));
    return NextResponse.json({ ...result, message: `IMAP und SMTP erfolgreich verbunden, verifiziert ${result.identity}` });
  } catch (error) {
    const normalized = toPublicError(error);
    return NextResponse.json({ ok: false, code: normalized.code, message: normalized.message }, { status: normalized.status });
  }
}
