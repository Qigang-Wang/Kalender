import { NextResponse } from "next/server";

import { AuthError, appUserRoles, deleteManagedAppUser, getCurrentAppUser, updateManagedAppUser, type AppUserRole } from "@/server/auth";

export const runtime = "nodejs";

interface UserRouteProps {
  readonly params: Promise<{ readonly userId: string }>;
}

interface UpdateUserBody {
  readonly displayName?: unknown;
  readonly email?: unknown;
  readonly password?: unknown;
  readonly role?: unknown;
  readonly disabled?: unknown;
  readonly mustChangePassword?: unknown;
}

export async function PATCH(request: Request, { params }: UserRouteProps) {
  try {
    const actor = await requireActor();
    const { userId } = await params;
    const body = await request.json().catch(() => null) as UpdateUserBody | null;
    const user = await updateManagedAppUser(actor, userId, {
      displayName: optionalString(body?.displayName),
      email: optionalString(body?.email),
      password: optionalString(body?.password),
      role: optionalRole(body?.role),
      disabled: typeof body?.disabled === "boolean" ? body.disabled : undefined,
      mustChangePassword: typeof body?.mustChangePassword === "boolean" ? body.mustChangePassword : undefined,
    });
    return NextResponse.json({ ok: true, user });
  } catch (error) {
    return userErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: UserRouteProps) {
  try {
    const actor = await requireActor();
    const { userId } = await params;
    const user = await deleteManagedAppUser(actor, userId);
    return NextResponse.json({ ok: true, user });
  } catch (error) {
    return userErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("请先登录", 401);
  return actor;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalRole(value: unknown): AppUserRole | undefined {
  return typeof value === "string" && appUserRoles.includes(value as AppUserRole) ? value as AppUserRole : undefined;
}

function userErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("用户操作失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
