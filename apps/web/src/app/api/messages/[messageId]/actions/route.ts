import { NextResponse } from "next/server";

import {
  MailMessageActionError,
  performMailMessageAction,
  type MailMessageAction,
} from "@/server/mail-message-actions";
import { getCurrentAppUser, recordAuditEvent } from "@/server/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const actions = new Set<MailMessageAction>(["mark-read", "mark-unread", "star", "unstar", "archive", "delete", "move"]);

interface MessageActionRouteContext {
  readonly params: Promise<{ readonly messageId: string }>;
}

export async function PATCH(request: Request, context: MessageActionRouteContext) {
  const { messageId } = await context.params;
  const input = await request.json().catch(() => null) as { readonly action?: unknown; readonly folderId?: unknown } | null;
  if (typeof input?.action !== "string" || !actions.has(input.action as MailMessageAction)) {
    return NextResponse.json({ ok: false, message: "nicht unterstützte E-Mail-Operationen" }, { status: 400 });
  }
  try {
    const actor = await getCurrentAppUser();
    const result = await performMailMessageAction(
      messageId,
      input.action as MailMessageAction,
      typeof input.folderId === "string" ? input.folderId : undefined,
    );
    if (actor) {
      await recordAuditEvent({
        actorUserId: actor.id,
        targetUserId: actor.id,
        action: `mail.message.${input.action}`,
        metadata: { messageId, folderId: typeof input.folderId === "string" ? input.folderId : undefined },
      }).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof MailMessageActionError) {
      return NextResponse.json(
        { ok: false, code: error.code, message: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json({ ok: false, message: "Mail-Operation fehlgeschlagen" }, { status: 500 });
  }
}
