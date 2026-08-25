import { NextResponse } from "next/server";

import { listMailThread } from "@/server/mail-repository";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await context.params;
  const messages = await listMailThread(messageId);
  if (!messages.length) return NextResponse.json({ ok: false, message: "Der Mail Thread existiert nicht" }, { status: 404 });
  return NextResponse.json({ ok: true, threadId: messages[0]!.threadId, messages });
}
