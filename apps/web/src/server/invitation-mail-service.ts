import { encodeNoteContent, noteContentToPlainText, type PlateNoteValue } from "../lib/note-content";

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
    subject: `${input.inviter.displayName} 邀请你加入 Dayline`,
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
    const message = error instanceof Error ? error.message : "邀请邮件发送失败";
    throw new InvitationMailDeliveryError(message, draft.id);
  }
}

export function buildInvitationMailContent(invitation: CreatedAppInvitation, inviter: AppUser): string {
  const recipient = invitation.displayName?.trim() || invitation.email;
  const role = invitation.role === "admin" ? "管理员" : invitation.role === "viewer" ? "只读用户" : "普通用户";
  const document: PlateNoteValue = [
    { type: "p", children: [{ text: `${recipient}，` }] },
    { type: "p", children: [{ text: `${inviter.displayName} 邀请你加入 Dayline 工作台。` }] },
    { type: "p", children: [{ text: `账户角色：${role}` }] },
    {
      type: "p",
      children: [
        { text: "接受邀请：" },
        { type: "a", url: invitation.inviteUrl, children: [{ text: invitation.inviteUrl }] },
      ],
    },
    { type: "p", children: [{ text: `邀请将在 ${formatInviteExpiry(invitation.expiresAt)} 失效。` }] },
    { type: "p", children: [{ text: "如果你不认识邀请人，可以忽略这封邮件。" }] },
  ];
  return encodeNoteContent(document);
}

function formatInviteExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "7 天后";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: process.env.TZ || "Europe/Berlin",
  }).format(date);
}
