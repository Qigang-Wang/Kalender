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
    if (!input.apiKey && !input.providerId) throw new AiProviderError("请输入 API Key", "AI_API_KEY_REQUIRED");
    const credential = input.apiKey
      ? { apiKey: input.apiKey }
      : await loadAiProviderCredential(input.providerId!);
    const result = await testAiProviderConnection(input, credential);
    return NextResponse.json({
      ok: true,
      latencyMs: result.latencyMs,
      message: `连接成功，发现 ${result.models.length} 个模型`,
      discoveredModels: result.models,
    });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
