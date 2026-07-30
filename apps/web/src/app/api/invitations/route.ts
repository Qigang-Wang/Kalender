import { NextResponse } from "next/server";

import {
  AuthError,
  appUserRoles,
  createAppInvitation,
  getCurrentAppUser,
  listAppInvitations,
  type AppUserRole,
} from "@/server/auth";

export const runtime = "nodejs";

interface CreateInvitationBody {
  readonly email?: unknown;
  readonly displayName?: unknown;
  readonly role?: unknown;
}

export async function GET() {
  try {
    const actor = await requireActor();
    return NextResponse.json({ ok: true, invitations: await listAppInvitations(actor) });
  } catch (error) {
    return invitationErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor();
    const body = await request.json().catch(() => null) as CreateInvitationBody | null;
    const invitation = await createAppInvitation(actor, {
      email: stringValue(body?.email),
      displayName: optionalString(body?.displayName),
      role: roleValue(body?.role),
      origin: new URL(request.url).origin,
    });
    return NextResponse.json({ ok: true, invitation }, { status: 201 });
  } catch (error) {
    return invitationErrorResponse(error);
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
  return typeof value === "string" ? value : undefined;
}

function roleValue(value: unknown): AppUserRole {
  return typeof value === "string" && appUserRoles.includes(value as AppUserRole) ? value as AppUserRole : "user";
}

function invitationErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("邀请操作失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
