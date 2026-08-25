import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import {
  getAiProvider,
  listAiModels,
  loadAiProviderCredential,
  saveAiModel,
} from "@/server/ai-provider-repository";
import { AiProviderError, parseAiModelInput } from "@/server/ai-provider-validation";
import { storedProviderConnection, testAiModelCapabilities } from "@/server/openai-compatible-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext { readonly params: Promise<{ readonly providerId: string }> }

export async function GET(_request: Request, context: RouteContext) {
  const { providerId } = await context.params;
  return NextResponse.json({ ok: true, models: await listAiModels(providerId) });
}

export async function POST(request: Request, context: RouteContext) {
  const { providerId } = await context.params;
  try {
    const provider = await getAiProvider(providerId);
    if (!provider) throw new AiProviderError("KI-API existiert nicht", "AI_PROVIDER_NOT_FOUND", 404);
    const input = parseAiModelInput(await request.json().catch(() => null), providerId);
    const result = await testAiModelCapabilities(
      storedProviderConnection(provider), await loadAiProviderCredential(providerId), input,
    );
    const model = await saveAiModel(input, result);
    return NextResponse.json({ ok: true, model }, { status: 201 });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
