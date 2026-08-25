import { NextResponse } from "next/server";

import { getCurrentAppUser, recordAuditEvent } from "@/server/auth";
import {
  MailMessageActionError,
  performMailMessageAction,
  type MailMessageAction,
  type MailMessageActionResult,
} from "@/server/mail-message-actions";

export const runtime = "nodejs";
export const maxDuration = 300;

const actions = new Set<MailMessageAction>(["mark-read", "mark-unread", "star", "unstar", "archive", "delete"]);

interface BatchFailure {
  readonly messageId: string;
  readonly code: string;
  readonly message: string;
}

export async function PATCH(request: Request) {
  const input = await request.json().catch(() => null) as {
    readonly action?: unknown;
    readonly messageIds?: unknown;
  } | null;
  if (typeof input?.action !== "string" || !actions.has(input.action as MailMessageAction)) {
    return NextResponse.json({ ok: false, message: "Nicht unterstützte Massen-E-Mail-Operationen" }, { status: 400 });
  }
  if (!Array.isArray(input.messageIds)) {
    return NextResponse.json({ ok: false, message: "Bitte wählen Sie die zu bedienende E-Mail" }, { status: 400 });
  }
  const messageIds = [...new Set(input.messageIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))];
  if (messageIds.length === 0 || messageIds.length > 100) {
    return NextResponse.json({ ok: false, message: "1 bis 100 E-Mails pro Betrieb" }, { status: 400 });
  }

  const results: MailMessageActionResult[] = [];
  const failures: BatchFailure[] = [];
  for (const messageId of messageIds) {
    try {
      results.push(await performMailMessageAction(messageId, input.action as MailMessageAction));
    } catch (error) {
      if (error instanceof MailMessageActionError) {
        failures.push({ messageId, code: error.code, message: error.message });
      } else {
        failures.push({ messageId, code: "UNKNOWN", message: "Mail-Operation fehlgeschlagen" });
      }
    }
  }

  const actor = await getCurrentAppUser();
  if (actor) {
    await recordAuditEvent({
      actorUserId: actor.id,
      targetUserId: actor.id,
      action: `mail.message.batch.${input.action}`,
      metadata: {
        requestedCount: messageIds.length,
        succeededCount: results.length,
        failedCount: failures.length,
      },
    }).catch(() => undefined);
  }
  return NextResponse.json({
    ok: failures.length === 0,
    results,
    failures,
    message: failures.length > 0 ? `${results.length} erfolgreiche Versiegelung,${failures.length} Siegel fehlgeschlagen` : undefined,
  });
}
