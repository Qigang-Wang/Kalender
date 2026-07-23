import { NextResponse } from "next/server";

import { toAiPublicError } from "./ai-provider-validation";

export function aiProviderErrorResponse(error: unknown): NextResponse {
  const normalized = toAiPublicError(error);
  return NextResponse.json(
    { ok: false, code: normalized.code, message: normalized.message },
    { status: normalized.status },
  );
}
