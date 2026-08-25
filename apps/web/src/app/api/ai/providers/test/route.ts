import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import { loadAiProviderCredential } from "@/server/ai-provider-repository";
import { parseAiProviderInput } from "@/server/ai-provider-validation";
import { AiProviderError } from "@/server/ai-provider-validation";
import { testAiProviderConnection } from "@/server/openai-compatible-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const input = parseAiProviderInput(await request.json().catch(() => null));
    if (!input.apiKey && !input.providerId) throw new AiProviderError("API-Schlüssel eingeben", "AI_API_KEY_REQUIRED");
    const credential = input.apiKey
      ? { apiKey: input.apiKey }
      : await loadAiProviderCredential(input.providerId!);
    const result = await testAiProviderConnection(input, credential);
    return NextResponse.json({
      ok: true,
      latencyMs: result.latencyMs,
      message: `erfolgreich verbunden, gefunden ${result.models.length} ein Modell`,
      discoveredModels: result.models,
    });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
