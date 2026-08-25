import { encodeNoteContent, noteContentToPlainText, type PlateNoteValue } from "../lib/note-content";
import { invitationBlock, type DaylineInvitationTemplateData } from "../lib/mail-invitation-content";

import type { AppUser, CreatedAppInvitation } from "./auth";
import { createMailDraft } from "./mail-draft-repository";
import { sendMailDraft } from "./mail-send-service";
import type { StoredAccount } from "./mail-repository";

export interface InvitationMailDelivery {
  readonly draftId: string;
  readonly senderAccountId: string;
  readonly senderAddress: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export class InvitationMailDeliveryError extends Error {
  constructor(message: string, readonly draftId: string) {
    super(message);
    this.name = "InvitationMailDeliveryError";
  }
}

export async function sendAppInvitationMail(input: {
  readonly invitation: CreatedAppInvitation;
  readonly inviter: AppUser;
  readonly sender: StoredAccount;
}): Promise<InvitationMailDelivery> {
  const bodyContent = buildInvitationMailContent(input.invitation, input.inviter);
  const draft = await createMailDraft({
    accountId: input.sender.id,
    to: [input.invitation.email],
    cc: [],
    bcc: [],
    subject: `${input.inviter.displayName} lädt Sie zu Dayline ein`,
    textBody: noteContentToPlainText(bodyContent),
    bodyContent,
  });
  try {
    const result = await sendMailDraft(draft.id, input.sender.id, `invitation:${input.invitation.id}`);
    return {
      draftId: draft.id,
      senderAccountId: input.sender.id,
      senderAddress: input.sender.emailAddress,
      accepted: result.accepted,
      rejected: result.rejected,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Die Einladungs-E-Mail konnte nicht gesendet werden";
    throw new InvitationMailDeliveryError(message, draft.id);
  }
}

export function buildInvitationMailContent(invitation: CreatedAppInvitation, inviter: AppUser): string {
  const recipient = invitation.displayName?.trim() || invitation.email;
  const role = invitation.role === "admin" ? "Administrator" : invitation.role === "viewer" ? "Nur Lesen" : "Mitglied";
  const template: DaylineInvitationTemplateData = {
    recipient,
    inviterName: inviter.displayName,
    inviterEmail: inviter.email,
    roleLabel: role,
    expiresAtLabel: formatInviteExpiry(invitation.expiresAt),
    inviteUrl: invitation.inviteUrl,
  };
  const document: PlateNoteValue = [
    invitationBlock("Einladung zu Dayline", template),
    invitationBlock(`Hallo ${recipient},`),
    invitationBlock(`${inviter.displayName} lädt Sie zum Dayline-Arbeitsbereich ein, um E-Mails, Kalender, Aufgaben, Projekte und Notizen gemeinsam zu verwalten.`),
    invitationBlock(`Eingeladen von: ${inviter.displayName} <${inviter.email}>`),
    invitationBlock(`Kontorolle: ${role}`),
    invitationBlock(`Gültig bis: ${template.expiresAtLabel}`),
    {
      type: "p",
      qgwBlockKind: "dayline-invitation",
      children: [
        { text: "Einladung annehmen: " },
        { type: "a", url: invitation.inviteUrl, children: [{ text: invitation.inviteUrl }] },
      ],
    },
    invitationBlock("Wenn Sie den Einladenden nicht kennen, können Sie die Nachricht sicher ignorieren."),
  ];
  return encodeNoteContent(document);
}

function formatInviteExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "in 7 Tagen";
  return new Intl.DateTimeFormat("de-DE", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: process.env.TZ || "Europe/Berlin",
  }).format(date);
}
