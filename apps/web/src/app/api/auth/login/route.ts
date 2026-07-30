import { NextResponse } from "next/server";

import { AuthError, authenticateAppUser, setAuthCookie } from "@/server/auth";

export const runtime = "nodejs";

interface LoginBody {
  readonly email?: unknown;
  readonly password?: unknown;
  readonly remember?: unknown;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as LoginBody | null;
    const user = await authenticateAppUser(stringValue(body?.email), stringValue(body?.password), {
      ipAddress: clientIp(request),
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    const response = NextResponse.json({ ok: true, user });
    setAuthCookie(response, user, { remember: body?.remember === true });
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function authErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("登录失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || undefined;
}
