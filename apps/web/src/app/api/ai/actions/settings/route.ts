import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { AiActionError, getAiActionSettings, saveAiActionSettings } from "@/server/ai-workspace-actions";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireActor();
    return NextResponse.json({ ok: true, settings: await getAiActionSettings(actor) });
  } catch (error) {
    return aiActionErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireActor();
    const body = await request.json().catch(() => null) as {
      readonly autoExecutionEnabled?: unknown;
      readonly highRiskAutoEnabled?: unknown;
    } | null;
    const settings = await saveAiActionSettings(actor, {
      autoExecutionEnabled: body?.autoExecutionEnabled === true,
      highRiskAutoEnabled: body?.highRiskAutoEnabled === true,
    });
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return aiActionErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("请先登录", 401);
  return actor;
}

function aiActionErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError || error instanceof AiActionError ? error : new AiActionError("AI 动作设置失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
