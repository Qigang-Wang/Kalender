import { NextResponse } from "next/server";

import { listAiConversations } from "@/server/ai-chat-repository";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, conversations: await listAiConversations() });
}
