import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import {
  getAiModel,
  getAiProvider,
  loadAiProviderCredential,
  updateAiModelTestStatus,
} from "@/server/ai-provider-repository";
import { AiProviderError, toAiPublicError } from "@/server/ai-provider-validation";
import { storedProviderConnection, testAiModelCapabilities } from "@/server/openai-compatible-ai";

export const runtime = "nodejs";
export const maxDuration = 60;
interface RouteContext { readonly params: Promise<{ readonly modelId: string }> }

export async function POST(_request: Request, context: RouteContext) {
  const { modelId } = await context.params;
  try {
    const model = await getAiModel(modelId);
    if (!model) throw new AiProviderError("Das KI-Modell existiert nicht", "AI_MODEL_NOT_FOUND", 404);
    const provider = await getAiProvider(model.providerId);
    if (!provider) throw new AiProviderError("KI-API existiert nicht", "AI_PROVIDER_NOT_FOUND", 404);
    try {
      const result = await testAiModelCapabilities(
        storedProviderConnection(provider), await loadAiProviderCredential(provider.id), model,
      );
      await updateAiModelTestStatus(modelId, { status: "passed", ...result });
      return NextResponse.json({ ok: true, model: await getAiModel(modelId) });
    } catch (error) {
      const normalized = toAiPublicError(error);
      await updateAiModelTestStatus(modelId, { status: "failed", errorCode: normalized.code });
      throw error;
    }
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
