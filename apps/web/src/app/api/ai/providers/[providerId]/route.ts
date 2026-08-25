import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import {
  deleteAiProvider,
  getAiProvider,
  loadAiProviderCredential,
  saveAiProvider,
  updateAiProviderTestStatus,
} from "@/server/ai-provider-repository";
import { AiProviderError, parseAiProviderInput } from "@/server/ai-provider-validation";
import { testAiProviderConnection } from "@/server/openai-compatible-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext { readonly params: Promise<{ readonly providerId: string }> }

export async function PATCH(request: Request, context: RouteContext) {
  const { providerId } = await context.params;
  try {
    if (!await getAiProvider(providerId)) throw new AiProviderError("KI-API existiert nicht", "AI_PROVIDER_NOT_FOUND", 404);
    const body = await request.json().catch(() => null);
    const input = parseAiProviderInput({ ...(body as object ?? {}), providerId });
    const credential = input.apiKey ? { apiKey: input.apiKey } : await loadAiProviderCredential(providerId);
    try {
      const result = await testAiProviderConnection(input, credential);
      const provider = await saveAiProvider(input);
      await updateAiProviderTestStatus(providerId, { status: "passed", latencyMs: result.latencyMs });
      return NextResponse.json({ ok: true, provider: await getAiProvider(provider.id), discoveredModels: result.models });
    } catch (error) {
      const normalized = error instanceof AiProviderError ? error : new AiProviderError("AI API ist derzeit nicht verfügbar", "AI_PROVIDER_UNAVAILABLE", 502);
      await updateAiProviderTestStatus(providerId, { status: "failed", errorCode: normalized.code });
      throw error;
    }
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { providerId } = await context.params;
  try {
    if (!await deleteAiProvider(providerId)) throw new AiProviderError("KI-API existiert nicht", "AI_PROVIDER_NOT_FOUND", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
