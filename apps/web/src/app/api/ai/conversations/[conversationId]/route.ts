import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import { deleteAiConversation, listAiChatMessages, requireAiConversation } from "@/server/ai-chat-repository";
import { AiProviderError } from "@/server/ai-provider-validation";

export const runtime = "nodejs";
interface RouteContext { readonly params: Promise<{ readonly conversationId: string }> }

export async function GET(_request: Request, context: RouteContext) {
  const { conversationId } = await context.params;
  try {
    const conversation = await requireAiConversation(conversationId);
    return NextResponse.json({ ok: true, conversation, messages: await listAiChatMessages(conversationId) });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { conversationId } = await context.params;
  try {
    if (!await deleteAiConversation(conversationId)) throw new AiProviderError("AI 会话不存在", "AI_CONVERSATION_NOT_FOUND", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
