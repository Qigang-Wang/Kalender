import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser, setAuthCookie, updateOwnProfile } from "@/server/auth";

export const runtime = "nodejs";

interface UpdateProfileBody {
  readonly displayName?: unknown;
  readonly currentPassword?: unknown;
  readonly newPassword?: unknown;
}

export async function PATCH(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("请先登录", 401);
    const body = await request.json().catch(() => null) as UpdateProfileBody | null;
    const user = await updateOwnProfile(actor, {
      displayName: optionalString(body?.displayName),
      currentPassword: optionalString(body?.currentPassword),
      newPassword: optionalString(body?.newPassword),
    });
    const response = NextResponse.json({ ok: true, user });
    setAuthCookie(response, user);
    return response;
  } catch (error) {
    return userErrorResponse(error);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function userErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("无法更新个人账号", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
