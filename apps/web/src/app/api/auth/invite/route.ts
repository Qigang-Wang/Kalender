import { NextResponse } from "next/server";

import { acceptAppInvitation, AuthError, getAppInvitationByToken, setAuthCookie } from "@/server/auth";

export const runtime = "nodejs";

interface InviteBody {
  readonly token?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
  readonly confirmPassword?: unknown;
}

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const invitation = await getAppInvitationByToken(token);
    if (!invitation) throw new AuthError("邀请链接无效或已过期", 404);
    return NextResponse.json({ ok: true, invitation });
  } catch (error) {
    return inviteErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as InviteBody | null;
    const password = stringValue(body?.password);
    if (password !== stringValue(body?.confirmPassword)) throw new AuthError("两次输入的密码不一致", 400);
    const user = await acceptAppInvitation(stringValue(body?.token), {
      displayName: stringValue(body?.displayName),
      password,
    });
    const response = NextResponse.json({ ok: true, user }, { status: 201 });
    setAuthCookie(response, user, request);
    return response;
  } catch (error) {
    return inviteErrorResponse(error);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function inviteErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("邀请处理失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
