import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { AiActionError, runAiWorkspaceAction, type AiWorkspaceAction } from "@/server/ai-workspace-actions";
import { enqueueJob } from "@/server/job-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
    const body = await request.json().catch(() => null) as {
      readonly action?: unknown;
      readonly input?: unknown;
      readonly background?: unknown;
      readonly idempotencyKey?: unknown;
    } | null;
    const action = parseAction(body?.action);
    const input = body?.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? body.input as Record<string, unknown>
      : {};
    if (body?.background === false && action === "workspace.search") {
      return NextResponse.json({ ok: true, result: await runAiWorkspaceAction(actor, action, input) });
    }
    const job = await enqueueJob({
      kind: "ai.action",
      actor,
      title: `KI-Maßnahmen:${action}`,
      payload: { actorUserId: actor.id, action, input },
      idempotencyKey: typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      maxAttempts: 1,
    });
    return NextResponse.json({ ok: true, job }, { status: 202 });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof AiActionError ? error : new AiActionError("KI-Aktion fehlgeschlagen", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}

function parseAction(value: unknown): AiWorkspaceAction {
  if (
    value === "workspace.search"
    || value === "task.create"
    || value === "task.update-status"
    || value === "note.create"
    || value === "calendar.create-event"
    || value === "mail.message-action"
    || value === "mail.send-draft"
  ) return value;
  throw new AiActionError("der KI-Aktionstyp ist ungültig");
}
