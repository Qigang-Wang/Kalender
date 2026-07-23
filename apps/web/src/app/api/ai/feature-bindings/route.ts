import { NextResponse } from "next/server";

import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import { listAiFeatureBindings, saveAiFeatureBinding } from "@/server/ai-provider-repository";
import { parseAiFeatureBindingInput } from "@/server/ai-provider-validation";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, bindings: await listAiFeatureBindings() });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const values = Array.isArray(body) ? body : [body];
    const bindings = [];
    for (const value of values) bindings.push(await saveAiFeatureBinding(parseAiFeatureBindingInput(value)));
    return NextResponse.json({ ok: true, bindings });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}
