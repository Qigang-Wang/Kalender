import { NextResponse } from "next/server";

import { AuthError, appUserRoles, createManagedAppUser, getCurrentAppUser, listManagedAppUsers, type AppUserRole } from "@/server/auth";

export const runtime = "nodejs";

interface CreateUserBody {
  readonly displayName?: unknown;
  readonly username?: unknown;
  readonly email?: unknown;
  readonly password?: unknown;
  readonly role?: unknown;
  readonly mustChangePassword?: unknown;
}

export async function GET() {
  try {
    const actor = await requireActor();
    return NextResponse.json({ ok: true, users: await listManagedAppUsers(actor) });
  } catch (error) {
    return userErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor();
    const body = await request.json().catch(() => null) as CreateUserBody | null;
    const user = await createManagedAppUser(actor, {
      displayName: stringValue(body?.displayName),
      username: stringValue(body?.username),
      email: optionalString(body?.email),
      password: stringValue(body?.password),
      role: roleValue(body?.role),
      mustChangePassword: body?.mustChangePassword !== false,
    });
    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (error) {
    return userErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("请先登录", 401);
  return actor;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function roleValue(value: unknown): AppUserRole {
  return typeof value === "string" && appUserRoles.includes(value as AppUserRole) ? value as AppUserRole : "user";
}

function userErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("用户操作失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
