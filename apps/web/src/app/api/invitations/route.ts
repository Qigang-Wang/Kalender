import { NextResponse } from "next/server";

import {
  AuthError,
  appUserRoles,
  createAppInvitation,
  getCurrentAppUser,
  listAppInvitations,
  recordAuditEvent,
  type AppUserRole,
} from "@/server/auth";
import { InvitationMailDeliveryError, sendAppInvitationMail } from "@/server/invitation-mail-service";
import { getAccount } from "@/server/mail-repository";

export const runtime = "nodejs";
export const maxDuration = 60;

interface CreateInvitationBody {
  readonly email?: unknown;
  readonly displayName?: unknown;
  readonly role?: unknown;
  readonly senderAccountId?: unknown;
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
    const senderAccountId = optionalString(body?.senderAccountId)?.trim();
    const sender = senderAccountId ? await getAccount(senderAccountId) : undefined;
    if (senderAccountId && !sender) throw new AuthError("das ausgewählte Absenderkonto existiert nicht oder der aktuelle Benutzer hat kein Nutzungsrecht", 404);
    if (sender?.syncStatus === "paused") throw new AuthError("Das ausgewählte Absenderkonto wurde gesperrt und bitte aktivieren Sie das Konto zuerst", 409);
    if (sender && sender.providerId !== "imap-smtp" && sender.providerId !== "exchange-ews") {
      throw new AuthError("Das ausgewählte Konto unterstützt nicht den Versand von E-Mails", 400);
    }
    const invitation = await createAppInvitation(actor, {
      email: stringValue(body?.email),
      displayName: optionalString(body?.displayName),
      role: roleValue(body?.role),
      origin: requestOrigin(request),
    });
    if (!sender) return NextResponse.json({ ok: true, invitation, delivery: { status: "not-requested" } }, { status: 201 });
    try {
      const delivery = await sendAppInvitationMail({ invitation, inviter: actor, sender });
      await recordInvitationDelivery(actor, invitation.id, sender.id, "sent");
      return NextResponse.json({ ok: true, invitation, delivery: { status: "sent", ...delivery } }, { status: 201 });
    } catch (error) {
      console.error("Invitation email delivery failed", error);
      await recordInvitationDelivery(actor, invitation.id, sender.id, "failed");
      const message = error instanceof InvitationMailDeliveryError ? error.message : "Einladung zum Senden von E-Mails fehlgeschlagen";
      const draftId = error instanceof InvitationMailDeliveryError ? error.draftId : undefined;
      return NextResponse.json({
        ok: true,
        invitation,
        delivery: { status: "failed", senderAccountId: sender.id, senderAddress: sender.emailAddress, draftId, message },
      }, { status: 201 });
    }
  } catch (error) {
    return invitationErrorResponse(error);
  }
}

async function recordInvitationDelivery(
  actor: Awaited<ReturnType<typeof requireActor>>,
  invitationId: string,
  senderAccountId: string,
  status: "sent" | "failed",
) {
  await recordAuditEvent({
    actorUserId: actor.id,
    action: `invitation.email.${status}`,
    metadata: { invitationId, senderAccountId },
  }).catch(() => undefined);
}

function requestOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost && (forwardedProtocol === "http" || forwardedProtocol === "https")) {
    return `${forwardedProtocol}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
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
  const normalized = error instanceof AuthError ? error : new AuthError("Einladung fehlgeschlagen", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
