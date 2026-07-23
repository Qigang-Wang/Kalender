import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import { getAiProvider, loadAiProviderCredential } from "@/server/ai-provider-repository";
import { AiProviderError } from "@/server/ai-provider-validation";
import { discoverAiModels, storedProviderConnection } from "@/server/openai-compatible-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext { readonly params: Promise<{ readonly providerId: string }> }

export async function POST(_request: Request, context: RouteContext) {
  const { providerId } = await context.params;
  try {
    const provider = await getAiProvider(providerId);
    if (!provider) throw new AiProviderError("AI API 不存在", "AI_PROVIDER_NOT_FOUND", 404);
    const models = await discoverAiModels(storedProviderConnection(provider), await loadAiProviderCredential(providerId));
    return NextResponse.json({ ok: true, models });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
