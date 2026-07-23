import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import {
  listAiFeatureBindings,
  listAiModels,
  listAiProviders,
  saveAiProvider,
  updateAiProviderTestStatus,
} from "@/server/ai-provider-repository";
import { parseAiProviderInput } from "@/server/ai-provider-validation";
import { AiProviderError } from "@/server/ai-provider-validation";
import { testAiProviderConnection } from "@/server/openai-compatible-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const [providers, models, bindings] = await Promise.all([
    listAiProviders(), listAiModels(), listAiFeatureBindings(),
  ]);
  return NextResponse.json({ ok: true, providers, models, bindings });
}

export async function POST(request: Request) {
  try {
    const input = parseAiProviderInput(await request.json().catch(() => null));
    if (!input.apiKey) throw new AiProviderError("请输入 API Key", "AI_API_KEY_REQUIRED");
    const result = await testAiProviderConnection(input, { apiKey: input.apiKey });
    const provider = await saveAiProvider(input);
    await updateAiProviderTestStatus(provider.id, { status: "passed", latencyMs: result.latencyMs });
    return NextResponse.json({
      ok: true,
      provider: await listAiProviders().then((items) => items.find((item) => item.id === provider.id)),
      discoveredModels: result.models,
    }, { status: 201 });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
