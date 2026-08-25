import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import { generateMailAiResult, type MailAiAction } from "@/server/mail-ai-service";
import { AiProviderError } from "@/server/ai-provider-validation";

export const runtime = "nodejs";
export const maxDuration = 120;

const allowedActions = new Set<MailAiAction>(["summarize", "extract-actions", "draft-reply"]);

export async function POST(request: Request, context: { params: Promise<{ messageId: string }> }) {
  try {
    const { messageId } = await context.params;
    const body = await request.json().catch(() => null) as { action?: unknown; instruction?: unknown } | null;
    if (!body || typeof body.action !== "string" || !allowedActions.has(body.action as MailAiAction)) {
      throw new AiProviderError("Ungültiger AI-Mail-Betrieb", "INVALID_REQUEST", 400);
    }
    if (body.instruction !== undefined && typeof body.instruction !== "string") {
      throw new AiProviderError("das Antwort-Anfrage-Format ist nicht gültig", "INVALID_REQUEST", 400);
    }
    const result = await generateMailAiResult(messageId, body.action as MailAiAction, body.instruction, request.signal);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
