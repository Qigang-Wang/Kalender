import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import { deleteAiModel, getAiModel, saveAiModel } from "@/server/ai-provider-repository";
import { AiProviderError, parseAiModelInput } from "@/server/ai-provider-validation";

export const runtime = "nodejs";
interface RouteContext { readonly params: Promise<{ readonly modelId: string }> }

export async function PATCH(request: Request, context: RouteContext) {
  const { modelId } = await context.params;
  try {
    const current = await getAiModel(modelId);
    if (!current) throw new AiProviderError("AI 模型不存在", "AI_MODEL_NOT_FOUND", 404);
    const body = await request.json().catch(() => null);
    const input = parseAiModelInput({ ...(body as object ?? {}), modelId }, current.providerId);
    return NextResponse.json({ ok: true, model: await saveAiModel(input) });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { modelId } = await context.params;
  try {
    if (!await deleteAiModel(modelId)) throw new AiProviderError("AI 模型不存在", "AI_MODEL_NOT_FOUND", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
