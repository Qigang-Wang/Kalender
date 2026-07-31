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
  const template: DaylineInvitationTemplateData = {
    recipient,
    inviterName: inviter.displayName,
    inviterEmail: inviter.email,
    roleLabel: role,
    expiresAtLabel: formatInviteExpiry(invitation.expiresAt),
    inviteUrl: invitation.inviteUrl,
  };
  const document: PlateNoteValue = [
    invitationBlock("你受邀加入 Dayline", template),
    invitationBlock(`你好，${recipient}：`),
    invitationBlock(`${inviter.displayName} 邀请你加入 Dayline 工作台，一起管理邮件、日历、任务、项目和笔记。`),
    invitationBlock(`邀请人：${inviter.displayName} <${inviter.email}>`),
    invitationBlock(`账号角色：${role}`),
    invitationBlock(`有效期至：${template.expiresAtLabel}`),
    {
      type: "p",
      qgwBlockKind: "dayline-invitation",
      children: [
        { text: "接受邀请：" },
        { type: "a", url: invitation.inviteUrl, children: [{ text: invitation.inviteUrl }] },
      ],
    },
    invitationBlock("如果你不认识邀请人，可以安全地忽略这封邮件。"),
  ];
  return encodeNoteContent(document);
}

function formatInviteExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "7 天后";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: process.env.TZ || "Europe/Berlin",
  }).format(date);
}
