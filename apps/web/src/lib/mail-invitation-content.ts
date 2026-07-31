import type { PlateElementNode, PlateNoteValue } from "./note-content";

export const DAYLINE_INVITATION_BLOCK_KIND = "dayline-invitation";

export interface DaylineInvitationTemplateData {
  readonly recipient: string;
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly roleLabel: string;
  readonly expiresAtLabel: string;
  readonly inviteUrl: string;
}

export function invitationBlock(
  text: string,
  template?: DaylineInvitationTemplateData,
): PlateElementNode {
  return {
    type: "p",
    qgwBlockKind: DAYLINE_INVITATION_BLOCK_KIND,
    ...(template ? { qgwInvitation: template } : {}),
    children: [{ text }],
  };
}

export function isDaylineInvitationBlock(node: PlateElementNode): boolean {
  return node.qgwBlockKind === DAYLINE_INVITATION_BLOCK_KIND;
}

export function readDaylineInvitationTemplate(value: PlateNoteValue): DaylineInvitationTemplateData | undefined {
  for (const node of value) {
    if (!isDaylineInvitationBlock(node)) continue;
    const candidate = node.qgwInvitation;
    if (!candidate || typeof candidate !== "object") continue;
    const data = candidate as Partial<Record<keyof DaylineInvitationTemplateData, unknown>>;
    if (
      typeof data.recipient === "string"
      && typeof data.inviterName === "string"
      && typeof data.inviterEmail === "string"
      && typeof data.roleLabel === "string"
      && typeof data.expiresAtLabel === "string"
      && typeof data.inviteUrl === "string"
      && /^https?:\/\//i.test(data.inviteUrl)
    ) {
      return {
        recipient: data.recipient,
        inviterName: data.inviterName,
        inviterEmail: data.inviterEmail,
        roleLabel: data.roleLabel,
        expiresAtLabel: data.expiresAtLabel,
        inviteUrl: data.inviteUrl,
      };
    }
  }
  return undefined;
}
