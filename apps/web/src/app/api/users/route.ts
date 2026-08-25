import { NextResponse } from "next/server";

import { AuthError, appUserRoles, createManagedAppUser, getCurrentAppUser, listManagedAppUsers, type AppUserRole } from "@/server/auth";

export const runtime = "nodejs";

interface CreateUserBody {
  readonly displayName?: unknown;
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
      email: stringValue(body?.email),
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
  if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
  return actor;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function roleValue(value: unknown): AppUserRole {
  return typeof value === "string" && appUserRoles.includes(value as AppUserRole) ? value as AppUserRole : "user";
}

function userErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("Benutzerbetrieb fehlgeschlagen", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
