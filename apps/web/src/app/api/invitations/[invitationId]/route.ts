import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser, revokeAppInvitation } from "@/server/auth";

export const runtime = "nodejs";

interface InvitationRouteProps {
  readonly params: Promise<{ readonly invitationId: string }>;
}

export async function DELETE(_request: Request, { params }: InvitationRouteProps) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
    const { invitationId } = await params;
    return NextResponse.json({ ok: true, invitation: await revokeAppInvitation(actor, invitationId) });
  } catch (error) {
    const normalized = error instanceof AuthError ? error : new AuthError("Einladung fehlgeschlagen", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
