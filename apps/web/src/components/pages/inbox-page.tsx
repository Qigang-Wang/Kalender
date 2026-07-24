"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  AlertCircle, Archive, Award, CalendarDays, Check, CheckCircle2, ChevronDown,
  ChevronLeft, ChevronRight, Circle, Download, FileArchive, FileText, Folder,
  Forward, ImageIcon, Link2, ListChecks, LoaderCircle, Mail, MoreHorizontal,
  Paperclip, Pencil, RefreshCw, Reply, ReplyAll, Search, Send, ShieldCheck,
  Sparkles, Star, Trash2, Upload, WandSparkles, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";

import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { decodeNoteContent, EMPTY_PLATE_NOTE_CONTENT, encodeNoteContent, noteContentToPlainText } from "@/lib/note-content";
import { groupMailByDate, type MailDateGroupId } from "@/lib/mail-date-groups";
import { resolveReplyRecipients } from "@/lib/mail-reply-recipients";
import { isSmimeSignatureAttachment } from "@/lib/mail-smime";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { ContextMenu } from "../context-menu";
import { resolveContextCommands, type ContextCommandId, type MailMessageCommandId } from "../context-commands";
import { TransientToast } from "../workspace-shared";
import { MailProjectChip, ProjectAssociationControl, RelatedContentPanel } from "./related-content";

const MAIL_MESSAGE_DRAG_TYPE = "application/x-kalender-mail-message";
const MAIL_MESSAGE_MOVED_EVENT = "kalender:mail-message-moved";

interface MailMessageDragPayload {
  readonly messageId: string;
  readonly accountId: string;
  readonly subject: string;
}

interface MailMessageMovedDetail extends MailMessageDragPayload {
  readonly destinationFolderId: string;
  readonly destinationName: string;
  readonly movedCount: number;
}

type AccountSyncStatus = "idle" | "syncing" | "ready" | "error" | "paused";
type AccountSyncMode = "quick" | "recommended" | "full";

interface SavedMailAccount {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly emailAddress: string;
  readonly aliases?: readonly string[];
  readonly color: string;
  readonly syncMode: AccountSyncMode;
  readonly syncStatus: AccountSyncStatus;
  readonly syncError?: string;
  readonly lastSyncAt?: string;
}

function mailFolderLabel(folder: { readonly role: string; readonly name: string }): string {
  return ({ inbox: "收件箱", drafts: "草稿", sent: "已发送", archive: "归档", all: "所有邮件", junk: "垃圾邮件", spam: "垃圾邮件", trash: "已删除" } as Record<string, string>)[folder.role] ?? folder.name;
}

function mailMessageHref(messageId: string): string {
  return `/inbox?message=${encodeURIComponent(messageId)}`;
}

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

const MailComposerEditor = dynamic(
  () => import("../editor/mail-composer-editor").then((module) => module.MailComposerEditor),
  { loading: () => <EditorLoading label="正在加载邮件编辑器…" />, ssr: false },
);

function mailSenderAvatarColor(senderAddress: string, senderName: string): string {
  const identity = (senderAddress.trim() || senderName.trim() || "unknown-sender").normalize("NFKC").toLowerCase();
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const unsignedHash = hash >>> 0;
  const hue = unsignedHash / 0xffff_ffff * 360;
  const chroma = 0.09 + (unsignedHash >>> 8) % 5 * 0.008;
  const lightness = 0.76 + (unsignedHash >>> 16) % 5 * 0.01;
  return `oklch(${lightness.toFixed(2)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`;
}

interface InboxDisplayItem {
  readonly id: string;
  readonly threadId: string;
  readonly threadCount: number;
  readonly unreadCount: number;
  readonly accountId: string;
  readonly sender: string;
  readonly senderAddress: string;
  readonly subject: string;
  readonly preview: string;
  readonly receivedAt: string;
  readonly time: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly canArchive: boolean;
  readonly attachments: readonly InboxAttachment[];
}

interface InboxApiItem {
  readonly id: string;
  readonly threadId: string;
  readonly threadCount: number;
  readonly unreadCount: number;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly senderName: string;
  readonly senderAddress: string;
  readonly subject: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly canArchive: boolean;
  readonly attachments: readonly InboxAttachment[];
}

interface InboxPageCursor {
  readonly receivedAt: string;
  readonly id: string;
}

interface MailThreadDisplayMessage {
  readonly id: string;
  readonly threadId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly senderName: string;
  readonly senderAddress: string;
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc: readonly { readonly address: string; readonly name?: string }[];
  readonly subject: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly folderRole: string;
  readonly attachments: readonly InboxAttachment[];
}

interface InboxAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly inline: boolean;
}

interface MailContextMenuState {
  readonly messageId: string;
  readonly x: number;
  readonly y: number;
}

type MailAiAction = "summarize" | "extract-actions" | "draft-reply";

interface MailAiViewResult {
  readonly messageId: string;
  readonly action: MailAiAction;
  readonly text: string;
  readonly modelName: string;
  readonly usedFallback: boolean;
}

type MailUiAction = "mark-read" | "mark-unread" | "star" | "unstar" | "archive" | "delete";

const mailUiActionByCommand: Partial<Record<MailMessageCommandId, MailUiAction>> = {
  "mail.toggle-read": "mark-read",
  "mail.toggle-star": "star",
  "mail.archive": "archive",
  "mail.delete": "delete",
};

type InboxBodyState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly text?: string;
      readonly html?: string;
      readonly cached: boolean;
      readonly hasBlockedRemoteImages: boolean;
    };

interface ClientMailDraft {
  readonly id: string;
  readonly accountId: string;
  readonly replyToMessageId?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  readonly bodyContent: string;
  readonly attachments: readonly ClientMailAttachment[];
  readonly status: "draft" | "sending" | "sent" | "failed";
  readonly errorMessage?: string;
  readonly updatedAt: string;
}

interface ClientMailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly inline: boolean;
  readonly contentId?: string;
  readonly createdAt: string;
}

type ComposerSaveState = "saved" | "saving" | "error";

function splitMailAddresses(value: string): readonly string[] {
  return value.split(/[;,]/).map((address) => address.trim()).filter(Boolean);
}

function mailDraftPayload(draft: ClientMailDraft) {
  return {
    accountId: draft.accountId,
    replyToMessageId: draft.replyToMessageId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    textBody: draft.textBody,
    bodyContent: draft.bodyContent,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function prefixedMailSubject(subject: string, prefix: "Re" | "Fwd"): string {
  const withoutPrefix = subject.replace(/^\s*(?:re|fwd|fw)\s*:\s*/i, "").trim();
  return `${prefix}: ${withoutPrefix || "（无主题）"}`;
}

function mapInboxApiItems(items: readonly InboxApiItem[]): readonly InboxDisplayItem[] {
  return items.map((item) => ({
    id: item.id,
    threadId: item.threadId,
    threadCount: item.threadCount,
    unreadCount: item.unreadCount,
    accountId: item.accountId,
    sender: item.senderName,
    senderAddress: item.senderAddress,
    subject: item.subject,
    preview: item.snippet || "正文将在打开邮件时按需下载",
    receivedAt: item.receivedAt,
    time: formatMailTime(item.receivedAt),
    accountName: item.accountName,
    accountColor: item.accountColor,
    isRead: item.isRead,
    isStarred: item.isStarred,
    canArchive: item.canArchive,
    attachments: item.attachments ?? [],
  }));
}

export function InboxPage({ initialMessageId, initialFolderId }: { readonly initialMessageId?: string; readonly initialFolderId?: string }) {
  const [remoteItems, setRemoteItems] = useState<readonly InboxDisplayItem[] | null>(null);
  const [nextInboxCursor, setNextInboxCursor] = useState<InboxPageCursor>();
  const [mailPageLoading, setMailPageLoading] = useState(false);
  const [hasAccounts, setHasAccounts] = useState(false);
  const [mailLoadError, setMailLoadError] = useState<string>();
  const [mailboxLabel, setMailboxLabel] = useState("收件箱");
  const [selectedId, setSelectedId] = useState(initialMessageId ?? "");
  const [bodies, setBodies] = useState<Readonly<Record<string, InboxBodyState>>>({});
  const [threadMessages, setThreadMessages] = useState<readonly MailThreadDisplayMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [expandedThreadMessages, setExpandedThreadMessages] = useState<ReadonlySet<string>>(() => new Set());
  const [bodyRetry, setBodyRetry] = useState(0);
  const [bodyRefreshBusyId, setBodyRefreshBusyId] = useState<string>();
  const [remoteImagesAllowed, setRemoteImagesAllowed] = useState<ReadonlySet<string>>(() => new Set());
  const [mailAccounts, setMailAccounts] = useState<readonly SavedMailAccount[]>([]);
  const [mailDrafts, setMailDrafts] = useState<readonly ClientMailDraft[]>([]);
  const [composer, setComposer] = useState<ClientMailDraft>();
  const [composerSaveState, setComposerSaveState] = useState<ComposerSaveState>("saved");
  const [inlineCopyFieldsOpen, setInlineCopyFieldsOpen] = useState(false);
  const [sendConfirmationKey, setSendConfirmationKey] = useState<string>();
  const [sendBusy, setSendBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<MailContextMenuState | null>(null);
  const [messageActionBusy, setMessageActionBusy] = useState(false);
  const [mailAiBusy, setMailAiBusy] = useState<MailAiAction>();
  const [mailAiResult, setMailAiResult] = useState<MailAiViewResult>();
  const [mailNotice, setMailNotice] = useState<string | null>(null);
  const [mailRelatedVersion, setMailRelatedVersion] = useState(0);
  const [mailProjectTargetId, setMailProjectTargetId] = useState<string>();
  const [mailFilter, setMailFilter] = useState<"all" | "unread" | "starred">("all");
  const [mailAccountFilter, setMailAccountFilter] = useState("all");
  const [mailQuery, setMailQuery] = useState("");
  const [mobileMailDetail, setMobileMailDetail] = useState(Boolean(initialMessageId));
  const [draggedMessageId, setDraggedMessageId] = useState<string>();
  const [collapsedDateGroups, setCollapsedDateGroups] = useState<ReadonlySet<MailDateGroupId>>(() => new Set());
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const messageDetailRef = useRef<HTMLElement | null>(null);

  const refreshMailDrafts = useCallback(async () => {
    const response = await fetch("/api/mail-drafts", { cache: "no-store" });
    const payload = await response.json() as { readonly drafts?: readonly ClientMailDraft[]; readonly message?: string };
    if (!response.ok) throw new Error(payload.message || "无法读取邮件草稿");
    setMailDrafts(payload.drafts ?? []);
  }, []);

  const persistComposer = useCallback(async (draft: ClientMailDraft): Promise<ClientMailDraft> => {
    setComposerSaveState("saving");
    try {
      const response = await fetch(`/api/mail-drafts/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mailDraftPayload(draft)),
      });
      const payload = await response.json() as { readonly draft?: ClientMailDraft; readonly message?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.message || "草稿保存失败");
      setMailDrafts((current) => [payload.draft!, ...current.filter((item) => item.id !== payload.draft!.id)]);
      setComposerSaveState("saved");
      return payload.draft;
    } catch (error) {
      setComposerSaveState("error");
      throw error;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      workspaceFetch("/api/mail-accounts").then(async (response) => {
        const payload = await response.json() as { readonly accounts?: readonly SavedMailAccount[] };
        if (!response.ok) throw new Error("无法读取邮箱账户");
        return payload.accounts ?? [];
      }),
      workspaceFetch("/api/mail-drafts").then(async (response) => {
        const payload = await response.json() as { readonly drafts?: readonly ClientMailDraft[]; readonly message?: string };
        if (!response.ok) throw new Error(payload.message || "无法读取邮件草稿");
        return payload.drafts ?? [];
      }),
    ]).then(([accounts, drafts]) => {
      if (cancelled) return;
      setMailAccounts(accounts);
      setMailDrafts(drafts);
    }).catch((error: unknown) => {
      if (!cancelled) setMailNotice(error instanceof Error ? error.message : "无法读取邮件写作数据");
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleMovedMessage = (event: Event) => {
      const detail = (event as CustomEvent<MailMessageMovedDetail>).detail;
      if (!detail?.messageId) return;
      const nextItems = (remoteItems ?? []).filter((item) => item.id !== detail.messageId);
      setRemoteItems(nextItems);
      setSelectedId((current) => current === detail.messageId ? nextItems[0]?.id ?? "" : current);
      setDraggedMessageId(undefined);
      setMailNotice(detail.movedCount > 1
        ? `会话中的 ${detail.movedCount} 封邮件已移动到“${detail.destinationName}”`
        : `邮件已移动到“${detail.destinationName}”`);
    };
    window.addEventListener(MAIL_MESSAGE_MOVED_EVENT, handleMovedMessage);
    return () => window.removeEventListener(MAIL_MESSAGE_MOVED_EVENT, handleMovedMessage);
  }, [remoteItems]);

  useEffect(() => {
    if (!composer || composer.status === "sending" || composer.status === "sent") return;
    setComposerSaveState("saving");
    const timer = window.setTimeout(() => {
      void persistComposer(composer).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [composer?.accountId, composer?.bcc, composer?.bodyContent, composer?.cc, composer?.subject, composer?.textBody, composer?.to, persistComposer]);

  useEffect(() => {
    setInlineCopyFieldsOpen(Boolean(composer?.cc.length || composer?.bcc.length));
  }, [composer?.id]);

  const openComposer = async (message?: InboxDisplayItem, mode: "reply" | "forward" = "reply", initialText = "") => {
    if (mailAccounts.length === 0) {
      setMailNotice("请先在设置中连接一个可发送邮件的账户");
      return;
    }
    const account = message
      ? mailAccounts.find((item) => item.id === message.accountId)
      : mailAccounts[0];
    if (!account) {
      setMailNotice("找不到这封邮件对应的发件账户，请检查账户连接");
      return;
    }
    const currentBody = message ? bodies[message.id] : undefined;
    const forwardText = message && mode === "forward"
      ? `\n\n--- 转发邮件 ---\n发件人：${message.sender} <${message.senderAddress}>\n主题：${message.subject}\n\n${currentBody?.status === "ready" ? currentBody.text || message.preview : message.preview}`
      : initialText;
    const bodyContent = encodeNoteContent(decodeNoteContent(forwardText));
    const replySource = message && mode === "reply"
      ? threadMessages.find((threadMessage) => threadMessage.id === message.id)
      : undefined;
    const selfAddresses = [
      account.emailAddress,
      ...(account.aliases ?? []),
      ...threadMessages
        .filter((threadMessage) => threadMessage.accountId === account.id && threadMessage.folderRole === "sent")
        .map((threadMessage) => threadMessage.senderAddress),
    ];
    const replyRecipients = replySource
      ? resolveReplyRecipients({
        senderAddress: replySource.senderAddress,
        to: replySource.to,
        cc: replySource.cc,
        selfAddresses,
      })
      : { to: message && mode === "reply" ? [message.senderAddress] : [], cc: [] };
    try {
      const response = await fetch("/api/mail-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          replyToMessageId: message && mode === "reply" ? message.id : undefined,
          to: replyRecipients.to.length || mode !== "reply" ? replyRecipients.to : message ? [message.senderAddress] : [],
          cc: replyRecipients.cc,
          bcc: [],
          subject: message ? prefixedMailSubject(message.subject, mode === "reply" ? "Re" : "Fwd") : "",
          textBody: forwardText,
          bodyContent,
        }),
      });
      const payload = await response.json() as { readonly draft?: ClientMailDraft; readonly message?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.message || "无法创建草稿");
      setMailDrafts((current) => [payload.draft!, ...current.filter((item) => item.id !== payload.draft!.id)]);
      setComposer(payload.draft);
      setComposerSaveState("saved");
      setSendConfirmationKey(undefined);
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "无法创建草稿");
    }
  };

  const closeComposer = async () => {
    if (!composer || sendBusy || attachmentBusy) return;
    try {
      await persistComposer(composer);
      setComposer(undefined);
      setSendConfirmationKey(undefined);
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "草稿保存失败，请稍后重试");
    }
  };

  const discardComposer = async () => {
    if (!composer || sendBusy || attachmentBusy) return;
    try {
      const response = await fetch(`/api/mail-drafts/${encodeURIComponent(composer.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "无法删除草稿");
      setMailDrafts((current) => current.filter((item) => item.id !== composer.id));
      setComposer(undefined);
      setSendConfirmationKey(undefined);
      setMailNotice("草稿已删除");
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "无法删除草稿");
    }
  };

  const uploadComposerAttachments = async (files: readonly File[], inline = false): Promise<readonly ClientMailAttachment[]> => {
    if (!composer || files.length === 0 || attachmentBusy || sendBusy) return [];
    setAttachmentBusy(true);
    try {
      const saved = await persistComposer(composer);
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      if (inline) formData.set("inline", "true");
      const response = await fetch(`/api/mail-drafts/${encodeURIComponent(saved.id)}/attachments`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json() as { readonly attachments?: readonly ClientMailAttachment[]; readonly draft?: ClientMailDraft; readonly message?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.message || "无法添加附件");
      setComposer(payload.draft);
      setMailDrafts((current) => [payload.draft!, ...current.filter((item) => item.id !== payload.draft!.id)]);
      setMailNotice(inline ? `已在正文插入 ${files.length} 张图片` : `已添加 ${files.length} 个附件`);
      return payload.attachments ?? [];
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "无法添加附件");
      return [];
    } finally {
      setAttachmentBusy(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  };

  const removeComposerAttachment = async (attachmentId: string) => {
    if (!composer || attachmentBusy || sendBusy) return;
    setAttachmentBusy(true);
    try {
      const response = await fetch(
        `/api/mail-drafts/${encodeURIComponent(composer.id)}/attachments/${encodeURIComponent(attachmentId)}`,
        { method: "DELETE" },
      );
      const payload = await response.json() as { readonly draft?: ClientMailDraft; readonly message?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.message || "无法删除附件");
      setComposer((current) => current?.id === payload.draft!.id
        ? { ...current, attachments: payload.draft!.attachments }
        : current);
      setMailDrafts((current) => current.map((item) => item.id === payload.draft!.id
        ? { ...item, attachments: payload.draft!.attachments }
        : item));
      setMailNotice("附件已删除");
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "无法删除附件");
    } finally {
      setAttachmentBusy(false);
    }
  };

  const requestSendConfirmation = async () => {
    if (!composer || sendBusy || attachmentBusy) return;
    if (composer.to.length + composer.cc.length + composer.bcc.length === 0) {
      setMailNotice("请至少填写一位收件人");
      return;
    }
    if (!composer.subject.trim()) {
      setMailNotice("请填写邮件主题");
      return;
    }
    try {
      const saved = await persistComposer(composer);
      setComposer(saved);
      setSendConfirmationKey(`mail:${crypto.randomUUID()}`);
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "草稿保存失败，暂时无法发送");
    }
  };

  const confirmSend = async () => {
    if (!composer || !sendConfirmationKey || sendBusy) return;
    setSendBusy(true);
    try {
      const response = await fetch(`/api/mail-drafts/${encodeURIComponent(composer.id)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, accountId: composer.accountId, idempotencyKey: sendConfirmationKey }),
      });
      const payload = await response.json() as { readonly result?: { readonly providerMessageId?: string }; readonly message?: string };
      if (!response.ok || !payload.result) throw new Error(payload.message || "邮件发送失败");
      setComposer(undefined);
      setSendConfirmationKey(undefined);
      await refreshMailDrafts();
      setMailNotice("邮件已发送");
    } catch (error) {
      setSendConfirmationKey(undefined);
      await refreshMailDrafts().catch(() => undefined);
      setMailNotice(error instanceof Error ? error.message : "邮件发送失败，草稿已保留");
    } finally {
      setSendBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setRemoteItems(null);
    setMailLoadError(undefined);
    setNextInboxCursor(undefined);
    setSelectedId(initialMessageId ?? "");
    setMobileMailDetail(Boolean(initialMessageId));
    const inboxParams = new URLSearchParams({ limit: "50" });
    if (initialFolderId) inboxParams.set("folder", initialFolderId);
    const inboxUrl = `/api/inbox?${inboxParams}`;
    void workspaceFetch(inboxUrl)
      .then(async (response) => {
        const payload = await response.json() as {
          readonly hasAccounts?: boolean;
          readonly message?: string;
          readonly nextCursor?: InboxPageCursor;
          readonly folder?: { readonly name: string; readonly role: string; readonly accountName: string };
          readonly items?: readonly InboxApiItem[];
        };
        if (!response.ok) throw new Error(payload.message || "Inbox request failed");
        return payload;
      })
      .then(async (result) => {
        if (cancelled) return;
        const mapped = mapInboxApiItems(result.items ?? []);
        setHasAccounts(Boolean(result.hasAccounts));
        setMailboxLabel(result.folder ? `${result.folder.accountName} / ${mailFolderLabel(result.folder)}` : "统一收件箱");
        setMailLoadError(undefined);
        setRemoteItems(mapped);
        setNextInboxCursor(result.nextCursor);
        if (initialMessageId) {
          let target = mapped.find((item) => item.id === initialMessageId);
          if (!target) {
            const threadResponse = await fetch(`/api/messages/${encodeURIComponent(initialMessageId)}/thread`, { cache: "no-store" });
            if (threadResponse.ok) {
              const threadPayload = await threadResponse.json() as { readonly threadId?: string };
              target = mapped.find((item) => item.threadId === threadPayload.threadId);
            }
          }
          if (cancelled) return;
          if (target) {
            setSelectedId(target.id);
            setMailNotice("已打开任务关联的邮件线程");
          } else if (mapped[0]) {
            setSelectedId(mapped[0].id);
            setMailNotice("关联邮件已归档、删除或尚未同步");
          }
        } else setSelectedId(mapped[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMailLoadError(error instanceof Error ? error.message : "无法读取收件箱");
          setRemoteItems([]);
        }
      });
    return () => { cancelled = true; };
  }, [initialFolderId, initialMessageId]);

  const loadMoreMail = async () => {
    if (!nextInboxCursor || mailPageLoading) return;
    setMailPageLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "50",
        before: nextInboxCursor.receivedAt,
        beforeId: nextInboxCursor.id,
      });
      if (initialFolderId) params.set("folder", initialFolderId);
      const response = await workspaceFetch(`/api/inbox?${params}`, {}, 0);
      const payload = await response.json() as {
        readonly items?: readonly InboxApiItem[];
        readonly nextCursor?: InboxPageCursor;
        readonly message?: string;
      };
      if (!response.ok) throw new Error(payload.message || "无法继续加载邮件");
      const additions = mapInboxApiItems(payload.items ?? []);
      setRemoteItems((current) => {
        const existing = new Set(current?.map((item) => item.id) ?? []);
        return [...(current ?? []), ...additions.filter((item) => !existing.has(item.id))];
      });
      setNextInboxCursor(payload.nextCursor);
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "无法继续加载邮件");
    } finally {
      setMailPageLoading(false);
    }
  };

  useEffect(() => {
    if (!hasAccounts || !selectedId) {
      setThreadMessages([]);
      setExpandedThreadMessages(new Set());
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    void fetch(`/api/messages/${encodeURIComponent(selectedId)}/thread`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { readonly messages?: readonly MailThreadDisplayMessage[]; readonly message?: string };
        if (!response.ok || !result.messages?.length) throw new Error(result.message || "无法读取邮件线程");
        return result.messages;
      })
      .then((thread) => {
        if (cancelled) return;
        setThreadMessages(thread);
        setExpandedThreadMessages(new Set([thread[thread.length - 1]!.id]));
      })
      .catch(() => {
        if (cancelled) return;
        setThreadMessages([]);
        setExpandedThreadMessages(new Set([selectedId]));
      })
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
  }, [hasAccounts, selectedId]);

  useEffect(() => {
    if (!hasAccounts) return;
    const targets = threadMessages.length
      ? threadMessages.filter((message) => expandedThreadMessages.has(message.id)).map((message) => message.id)
      : selectedId ? [selectedId] : [];
    const pending = targets.filter((messageId) => bodies[messageId]?.status !== "ready" && bodies[messageId]?.status !== "loading");
    if (!pending.length) return;
    for (const messageId of pending) {
      setBodies((current) => ({ ...current, [messageId]: { status: "loading" } }));
      void fetch(`/api/messages/${encodeURIComponent(messageId)}/body`, { cache: "no-store" })
        .then(async (response) => {
          const result = await response.json() as {
            readonly message?: string;
            readonly body?: { readonly text?: string; readonly html?: string; readonly snippet: string; readonly cached: boolean; readonly hasBlockedRemoteImages: boolean };
          };
          if (!response.ok || !result.body) throw new Error(result.message || "无法读取邮件正文");
          return result.body;
        })
        .then((body) => {
          setBodies((current) => ({ ...current, [messageId]: { status: "ready", text: body.text, html: body.html, cached: body.cached, hasBlockedRemoteImages: body.hasBlockedRemoteImages } }));
          setRemoteItems((current) => current?.map((item) => item.id === messageId ? { ...item, preview: body.snippet } : item) ?? current);
        })
        .catch((error: unknown) => {
          setBodies((current) => ({ ...current, [messageId]: { status: "error", message: error instanceof Error ? error.message : "无法读取邮件正文" } }));
        });
    }
  }, [bodyRetry, expandedThreadMessages, hasAccounts, selectedId, threadMessages]);

  const refreshMessageBody = async (messageId: string) => {
    if (bodyRefreshBusyId) return;
    setBodyRefreshBusyId(messageId);
    setMailNotice(null);
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/body?refresh=1`, { cache: "no-store" });
      const result = await response.json() as {
        readonly message?: string;
        readonly body?: {
          readonly text?: string;
          readonly html?: string;
          readonly snippet: string;
          readonly cached: boolean;
          readonly hasBlockedRemoteImages: boolean;
        };
      };
      if (!response.ok || !result.body) throw new Error(result.message || "无法重新读取邮件正文");
      const body = result.body;
      setBodies((current) => ({
        ...current,
        [messageId]: {
          status: "ready",
          text: body.text,
          html: body.html,
          cached: body.cached,
          hasBlockedRemoteImages: body.hasBlockedRemoteImages,
        },
      }));
      setRemoteItems((current) => current?.map((item) => item.id === messageId ? { ...item, preview: body.snippet } : item) ?? current);
      setRemoteImagesAllowed((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
      setMailNotice("已更新本地缓存");
    } catch (error) {
      setMailNotice(`${error instanceof Error ? error.message : "无法获取邮件正文"}；继续显示原本地缓存`);
    } finally {
      setBodyRefreshBusyId(undefined);
    }
  };

  const allItems = remoteItems ?? [];
  const items = allItems.filter((item) => {
    if (mailAccountFilter !== "all" && item.accountId !== mailAccountFilter) return false;
    if (mailFilter === "unread" && item.isRead) return false;
    if (mailFilter === "starred" && !item.isStarred) return false;
    const normalized = mailQuery.trim().toLocaleLowerCase();
    return !normalized || `${item.sender} ${item.senderAddress} ${item.subject} ${item.preview}`.toLocaleLowerCase().includes(normalized);
  });
  const dateGroups = groupMailByDate(items);
  useEffect(() => {
    if (items.length && !items.some((item) => item.id === selectedId)) setSelectedId(items[0]!.id);
  }, [items, selectedId]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  useEffect(() => {
    if (messageDetailRef.current) messageDetailRef.current.scrollTop = 0;
  }, [selected?.id]);
  const displayedThreadMessages = [...threadMessages].reverse();
  const replyThreadMessage = displayedThreadMessages.find((message) => message.folderRole === "inbox");
  const replyTarget = selected && replyThreadMessage ? {
    ...selected,
    id: replyThreadMessage.id,
    sender: replyThreadMessage.senderName,
    senderAddress: replyThreadMessage.senderAddress,
    subject: replyThreadMessage.subject,
    preview: replyThreadMessage.snippet,
    attachments: replyThreadMessage.attachments,
  } : selected;
  const composerAccount = composer ? mailAccounts.find((account) => account.id === composer.accountId) : undefined;
  const isInlineReplyComposer = Boolean(composer?.replyToMessageId && selected && threadMessages.some((message) => message.id === composer.replyToMessageId));
  const composerFileAttachments = composer?.attachments.filter((attachment) => !attachment.inline) ?? [];
  const composerInlineImages = composer?.attachments.filter((attachment) => attachment.inline) ?? [];
  const inlineReplySource = composer?.replyToMessageId
    ? threadMessages.find((message) => message.id === composer.replyToMessageId)
    : undefined;
  const inlineReplyRecipient = inlineReplySource
    ? `${inlineReplySource.senderName} <${inlineReplySource.senderAddress}>`
    : composer?.to.join(", ") ?? "";
  const contextMessage = contextMenu
    ? items.find((item) => item.id === contextMenu.messageId)
    : undefined;
  const mailProjectTarget = mailProjectTargetId
    ? items.find((item) => item.id === mailProjectTargetId)
    : undefined;
  const contextCommands = contextMessage ? resolveContextCommands({
    kind: "mail-message",
    id: contextMessage.id,
    subject: contextMessage.subject,
    connected: hasAccounts,
    busy: messageActionBusy,
    isRead: contextMessage.isRead,
    isStarred: contextMessage.isStarred,
    canArchive: contextMessage.canArchive,
  }) : [];
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const openMessageContextMenu = (
    message: InboxDisplayItem,
    x: number,
    y: number,
    returnFocus: HTMLElement | null,
  ) => {
    menuReturnFocusRef.current = returnFocus;
    setSelectedId(message.id);
    setContextMenu({ messageId: message.id, x, y });
  };

  const runMessageAction = async (message: InboxDisplayItem, action: MailUiAction) => {
    if (!hasAccounts || messageActionBusy) return;
    closeContextMenu();
    setMessageActionBusy(true);
    setMailNotice("正在同步到邮箱服务器…");
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(message.id)}/actions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as {
        readonly message?: string;
        readonly result?: {
          readonly isRead?: boolean;
          readonly isStarred?: boolean;
          readonly removedFromInbox: boolean;
        };
      };
      if (!response.ok || !payload.result) throw new Error(payload.message || "邮件操作失败");
      if (payload.result.removedFromInbox) {
        const remaining = (remoteItems ?? []).filter((item) => item.id !== message.id);
        setRemoteItems(remaining);
        if (selectedId === message.id) setSelectedId(remaining[0]?.id ?? "");
        setMailNotice(action === "delete" ? "邮件已移至已删除邮件" : "邮件已归档");
      } else {
        setRemoteItems((current) => current?.map((item) => item.id === message.id ? {
          ...item,
          isRead: payload.result?.isRead ?? item.isRead,
          isStarred: payload.result?.isStarred ?? item.isStarred,
        } : item) ?? current);
        setMailNotice(action === "mark-read" || action === "mark-unread" ? "已更新已读状态" : "已更新星标状态");
      }
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "邮件操作失败");
    } finally {
      setMessageActionBusy(false);
    }
  };

  const openMessage = (message: InboxDisplayItem) => {
    closeContextMenu();
    setSelectedId(message.id);
    setMobileMailDetail(true);
    if (hasAccounts && !message.isRead) void runMessageAction(message, "mark-read");
  };

  useEffect(() => {
    const handleInboxKeyboard = (event: globalThis.KeyboardEvent) => {
      if (composer || sendConfirmationKey || contextMenu || messageActionBusy || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) return;
      if (target && target !== document.body && !target.closest(".message-list")) return;
      if (!selected || items.length === 0) return;

      const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selected.id));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.min(items.length - 1, Math.max(0, selectedIndex + offset));
        setSelectedId(items[nextIndex]!.id);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openMessage(selected);
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        void runMessageAction(selected, "delete");
      }
    };

    window.addEventListener("keydown", handleInboxKeyboard);
    return () => window.removeEventListener("keydown", handleInboxKeyboard);
  }, [composer, contextMenu, hasAccounts, items, messageActionBusy, selected, sendConfirmationKey]);

  const createTaskFromMessage = async (message: InboxDisplayItem) => {
    if (messageActionBusy) return;
    closeContextMenu();
    setMessageActionBusy(true);
    setMailNotice("正在创建关联任务…");
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: message.subject,
          notes: `来自 ${message.sender} <${message.senderAddress}>`,
          status: "inbox",
          important: false,
          urgencyMode: "auto",
          areaName: message.accountName,
          sourceReferences: [{
            kind: "mail",
            sourceId: message.id,
            label: message.subject,
            href: mailMessageHref(message.id),
          }],
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法创建任务");
      setMailRelatedVersion((current) => current + 1);
      setMailNotice("已创建任务，可在 Tasks · Inbox 中整理");
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "无法创建任务");
    } finally {
      setMessageActionBusy(false);
    }
  };

  const runMailAi = async (message: InboxDisplayItem, action: MailAiAction) => {
    if (mailAiBusy) return;
    const replyInstruction = action === "draft-reply" && isInlineReplyComposer && composer
      ? composer.textBody.trim()
      : "";
    setMailAiBusy(action);
    setMailNotice(null);
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(message.id)}/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, instruction: replyInstruction || undefined }),
      });
      const payload = await response.json() as {
        readonly result?: Omit<MailAiViewResult, "messageId">;
        readonly message?: string;
      };
      if (!response.ok || !payload.result) throw new Error(payload.message || "AI 邮件处理失败");
      if (action === "draft-reply") {
        if (isInlineReplyComposer && composer) {
          const bodyContent = encodeNoteContent(decodeNoteContent(payload.result.text));
          setComposer((current) => current?.id === composer.id ? {
            ...current,
            bodyContent,
            textBody: payload.result!.text,
          } : current);
          setMailAiResult(undefined);
          setMailNotice(replyInstruction ? "AI 已根据您的要求替换回复正文" : "AI 已生成回复正文");
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".inline-reply-composer [contenteditable='true']")?.focus());
          return;
        }
        if (replyTarget) {
          await openComposer(replyTarget, "reply", payload.result.text);
          setMailAiResult(undefined);
          setMailNotice("AI 已生成回复正文，发送前仍可修改");
          return;
        }
      }
      setMailAiResult({ messageId: message.id, ...payload.result });
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "AI 邮件处理失败");
    } finally {
      setMailAiBusy(undefined);
    }
  };

  const handleContextCommand = (commandId: ContextCommandId) => {
    if (!contextMessage) return;
    if (!commandId.startsWith("mail.")) return;
    const mailCommandId = commandId as MailMessageCommandId;
    let action = mailUiActionByCommand[mailCommandId];
    if (mailCommandId === "mail.toggle-read") action = contextMessage.isRead ? "mark-unread" : "mark-read";
    if (mailCommandId === "mail.toggle-star") action = contextMessage.isStarred ? "unstar" : "star";
    if (mailCommandId === "mail.create-task") void createTaskFromMessage(contextMessage);
    if (mailCommandId === "mail.assign-project") setMailProjectTargetId(contextMessage.id);
    if (action) void runMessageAction(contextMessage, action);
  };

  return (
    <>
    <div className={`mail-layout panel ${mobileMailDetail ? "mobile-detail-open" : ""}`}>
      <section className="message-list" aria-keyshortcuts="ArrowUp ArrowDown Enter Delete">
        <div className="list-toolbar">
          <div className="mail-list-summary">
            <span>{mailboxLabel} · {items.length}</span>
            <small title="邮件列表键盘快捷键">↑↓ 选择 · Enter 打开 · Entf 归档</small>
          </div>
          <div className="mail-list-actions">
            {mailDrafts.length > 0 && (
              <button className="mail-drafts-button" onClick={() => { setComposer(mailDrafts[0]); setComposerSaveState("saved"); }}>
                草稿 {mailDrafts.length}
              </button>
            )}
            <button aria-label="撰写邮件" title="撰写邮件" onClick={() => void openComposer()}><Pencil size={15} /></button>
          </div>
        </div>
        <div className="mail-filter-bar">
          <div>{(["all", "unread", "starred"] as const).map((filter) => <button className={mailFilter === filter ? "active" : ""} key={filter} onClick={() => setMailFilter(filter)}>{filter === "all" ? "全部" : filter === "unread" ? "未读" : "星标"}</button>)}</div>
          <select aria-label="筛选邮箱账户" value={mailAccountFilter} onChange={(event) => setMailAccountFilter(event.target.value)}><option value="all">所有账户</option>{Array.from(new Map(allItems.map((item) => [item.accountId, item])).values()).map((item) => <option value={item.accountId} key={item.accountId}>{item.accountName}</option>)}</select>
          <label><Search size={13} /><input aria-label="搜索当前邮件" value={mailQuery} onChange={(event) => setMailQuery(event.target.value)} placeholder="筛选邮件…" /></label>
        </div>
        <div className="message-list-scroll">
          {remoteItems === null && <div className="mail-empty"><LoaderCircle className="spin" size={18} />正在读取本地邮件…</div>}
          {remoteItems !== null && mailLoadError && <div className="mail-empty">{mailLoadError}</div>}
          {remoteItems !== null && !mailLoadError && !hasAccounts && <div className="mail-empty">尚未连接邮箱，请前往设置添加真实邮箱账户。</div>}
          {remoteItems !== null && !mailLoadError && hasAccounts && items.length === 0 && <div className="mail-empty">当前文件夹没有已同步的邮件。</div>}
          {dateGroups.map((group) => {
            const collapsed = collapsedDateGroups.has(group.id);
            return <section className={`mail-date-group ${collapsed ? "collapsed" : ""}`} aria-label={`${group.label}，${group.items.length} 封邮件`} key={group.id}>
              <button
                className="mail-date-group-header"
                aria-expanded={!collapsed}
                onClick={() => setCollapsedDateGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                  return next;
                })}
              >
                <span><ChevronDown size={14} /><strong>{group.label}</strong></span>
                <em>{group.items.length}</em>
              </button>
              {!collapsed && group.items.map((message) => {
                const digitallySigned = message.attachments.some(isSmimeSignatureAttachment);
                return (
                  <div
                  className={`message-item ${message.id === selected?.id ? "active" : ""} ${message.isRead ? "read" : ""} ${draggedMessageId === message.id ? "dragging" : ""}`}
                  key={message.id}
                  draggable={!messageActionBusy}
                  title="拖到左侧文件夹移动"
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(MAIL_MESSAGE_DRAG_TYPE, JSON.stringify({
                      messageId: message.id,
                      accountId: message.accountId,
                      subject: message.subject,
                    } satisfies MailMessageDragPayload));
                    event.dataTransfer.setData("text/plain", message.subject);
                    setDraggedMessageId(message.id);
                    closeContextMenu();
                  }}
                  onDragEnd={() => setDraggedMessageId(undefined)}
                  onContextMenu={(event) => {
                    if (event.shiftKey) return;
                    event.preventDefault();
                    openMessageContextMenu(
                      message,
                      event.clientX,
                      event.clientY,
                      event.currentTarget.querySelector<HTMLElement>(".message-open"),
                    );
                  }}
                >
                  <button
                    className="message-open"
                    onClick={() => openMessage(message)}
                    onKeyDown={(event) => {
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                      event.preventDefault();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      openMessageContextMenu(message, bounds.right - 12, bounds.top + 28, event.currentTarget);
                    }}
                  >
                    <span><strong>{message.sender}</strong><span className="message-meta">{message.threadCount > 1 && <em className="thread-count">{message.threadCount} 封</em>}{digitallySigned && <span className="smime-signature-badge" role="img" aria-label="数字签名邮件" title="数字签名邮件"><Award size={13} aria-hidden="true" /></span>}{message.isStarred && <Star size={12} fill="currentColor" aria-label="已星标" />}<time>{message.time}</time></span></span>
                    <b>{message.subject}</b><small>{message.preview}</small>
                  </button>
                  <button
                    className="message-menu-trigger"
                    draggable={false}
                    aria-label={`更多邮件操作：${message.subject}`}
                    aria-haspopup="menu"
                    aria-expanded={contextMenu?.messageId === message.id}
                    title="更多邮件操作"
                    onClick={(event) => {
                      event.stopPropagation();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      openMessageContextMenu(message, bounds.right, bounds.bottom + 4, event.currentTarget);
                    }}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  </div>
                );
              })}
            </section>;
          })}
          {nextInboxCursor && <button
            className="mail-load-more secondary-button"
            disabled={mailPageLoading}
            onClick={() => void loadMoreMail()}
          >
            {mailPageLoading ? <><LoaderCircle className="spin" size={14} />正在加载…</> : "加载更多邮件"}
          </button>}
        </div>
      </section>
      {selected ? <article className="message-detail" ref={messageDetailRef}>
        <header>
          <button className="mobile-detail-back" aria-label="返回邮件列表" onClick={() => setMobileMailDetail(false)}><ChevronLeft size={20} /></button>
          <div className="sender-avatar">{selected.sender.slice(0, 1).toLocaleUpperCase()}</div>
          <div><span className="sender-line"><i className="account-dot" style={{ background: selected.accountColor }} />{selected.accountName}</span><h2>{selected.subject}</h2><p>{selected.sender} &lt;{selected.senderAddress}&gt; · {selected.time}</p><MailProjectChip entityId={selected.id} refreshKey={mailRelatedVersion} onEdit={() => setMailProjectTargetId(selected.id)} /></div>
        </header>
        <div className="message-actions">
          <button
            className="primary-button"
            disabled={!hasAccounts || !replyTarget}
            aria-expanded={isInlineReplyComposer}
            onClick={() => {
              if (isInlineReplyComposer) {
                document.querySelector<HTMLElement>(".inline-reply-composer [contenteditable='true']")?.focus();
                return;
              }
              void openComposer(replyTarget, "reply");
            }}
          ><Pencil size={15} />回复</button>
          <button className="secondary-button" disabled={!hasAccounts} onClick={() => void openComposer(selected, "forward")}><Send size={15} />转发</button>
          <button className="secondary-button danger-button" disabled={!hasAccounts || messageActionBusy} onClick={() => void runMessageAction(selected, "delete")}><Trash2 size={15} />删除</button>
          <button className="secondary-button" disabled={messageActionBusy} onClick={() => void createTaskFromMessage(selected)}><CheckCircle2 size={15} />创建任务</button>
          <button className="ghost-button" disabled={Boolean(mailAiBusy)} onClick={() => void runMailAi(selected, "summarize")}>{mailAiBusy === "summarize" ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}摘要</button>
          <button className="ghost-button" disabled={Boolean(mailAiBusy)} onClick={() => void runMailAi(selected, "extract-actions")}>{mailAiBusy === "extract-actions" ? <LoaderCircle className="spin" size={15} /> : <ListChecks size={15} />}行动项</button>
          <button className="ghost-button" disabled={Boolean(mailAiBusy)} title={isInlineReplyComposer && composer?.textBody.trim() ? "根据当前正文中的要求生成，并替换为完整回复" : "根据邮件内容生成回复正文"} onClick={() => void runMailAi(selected, "draft-reply")}>{mailAiBusy === "draft-reply" ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}回复草稿</button>
          <button className="ghost-button message-detail-more" aria-label="更多邮件操作" title="更多邮件操作" aria-haspopup="menu" aria-expanded={contextMenu?.messageId === selected.id} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); openMessageContextMenu(selected, bounds.right, bounds.bottom + 4, event.currentTarget); }}><MoreHorizontal size={16} /></button>
        </div>
        {isInlineReplyComposer && composer && (
          <section className="inline-reply-composer" aria-labelledby="inline-reply-title" data-testid="inline-reply-composer">
            <header>
              <div id="inline-reply-title">
                <button
                  className={`inline-copy-toggle ${inlineCopyFieldsOpen ? "open" : ""}`}
                  aria-label={inlineCopyFieldsOpen ? "收起抄送和密送" : "展开抄送和密送"}
                  aria-expanded={inlineCopyFieldsOpen}
                  title={inlineCopyFieldsOpen ? "收起抄送和密送" : "添加抄送或密送"}
                  onClick={() => setInlineCopyFieldsOpen((open) => !open)}
                ><ChevronDown size={15} /></button>
                <span>回复给</span><strong>{inlineReplyRecipient}</strong>
              </div>
              <button className="composer-icon-button" aria-label="关闭并保存回复草稿" title="关闭并保存草稿" disabled={sendBusy || attachmentBusy} onClick={() => void closeComposer()}><X size={18} /></button>
            </header>
            {inlineCopyFieldsOpen && <div className="inline-copy-fields">
              <label><span>抄送</span><input aria-label="抄送" value={composer.cc.join(", ")} disabled={sendBusy || attachmentBusy} placeholder="name@example.com" onChange={(event) => setComposer({ ...composer, cc: splitMailAddresses(event.target.value) })} /></label>
              <label><span>密送</span><input aria-label="密送" value={composer.bcc.join(", ")} disabled={sendBusy || attachmentBusy} placeholder="name@example.com" onChange={(event) => setComposer({ ...composer, bcc: splitMailAddresses(event.target.value) })} /></label>
            </div>}
            <div className="inline-reply-body">
              {composerFileAttachments.length > 0 && (
                <div className="mail-attachment-list" aria-label="邮件附件">
                  {composerFileAttachments.map((attachment) => (
                    <div key={attachment.id}>
                      <Paperclip size={14} />
                      <span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.sizeBytes)}</small></span>
                      <button aria-label={`删除附件：${attachment.filename}`} disabled={attachmentBusy || sendBusy} onClick={() => void removeComposerAttachment(attachment.id)}><X size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
              <MailComposerEditor
                draftId={composer.id}
                content={composer.bodyContent || EMPTY_PLATE_NOTE_CONTENT}
                disabled={sendBusy || attachmentBusy}
                onPasteImages={async (files) => (await uploadComposerAttachments(files, true)).map((attachment) => ({
                  attachmentId: attachment.id,
                  filename: attachment.filename,
                  url: `/api/mail-drafts/${encodeURIComponent(composer.id)}/attachments/${encodeURIComponent(attachment.id)}`,
                }))}
                onChange={(bodyContent) => setComposer((current) => current ? {
                  ...current,
                  bodyContent,
                  textBody: noteContentToPlainText(bodyContent),
                } : current)}
              />
              {composer.errorMessage && <div className="composer-error"><AlertCircle size={14} />上次发送失败：{composer.errorMessage}</div>}
            </div>
            <footer>
              <div className="inline-reply-secondary">
                <input
                  ref={attachmentInputRef}
                  className="mail-attachment-input"
                  type="file"
                  multiple
                  aria-label="选择邮件附件"
                  onChange={(event) => void uploadComposerAttachments(Array.from(event.target.files ?? []))}
                />
                <button className="composer-attach" disabled={sendBusy || attachmentBusy || composer.attachments.length >= 10} onClick={() => attachmentInputRef.current?.click()}>
                  {attachmentBusy ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}添加附件
                </button>
                <span className={`composer-save-state ${composerSaveState}`}>
                  {composerSaveState === "saving" ? "正在保存…" : composerSaveState === "error" ? "保存失败" : "草稿自动保存"}
                </span>
              </div>
              <div>
                <button className="secondary-button" disabled={sendBusy || attachmentBusy} onClick={() => void closeComposer()}>取消</button>
                <button className="primary-button" disabled={sendBusy || attachmentBusy || composerSaveState === "saving"} onClick={() => void requestSendConfirmation()}><Send size={15} />发送</button>
              </div>
            </footer>
          </section>
        )}
        {mailAiResult?.messageId === selected.id && (
          <section className="mail-ai-result" aria-live="polite">
            <header><Sparkles size={15} /><strong>{mailAiResult.action === "summarize" ? "AI 摘要" : mailAiResult.action === "extract-actions" ? "AI 行动项" : "AI 回复草稿"}<small>{mailAiResult.modelName}{mailAiResult.usedFallback ? " · 已使用备用模型" : ""}</small></strong><button aria-label="关闭 AI 结果" onClick={() => setMailAiResult(undefined)}><X size={14} /></button></header>
            <div>{mailAiResult.text}</div>
            {mailAiResult.action === "draft-reply" && replyTarget && <button className="secondary-button" onClick={() => void openComposer(replyTarget, "reply", mailAiResult.text)}><Pencil size={14} />放入回复草稿</button>}
          </section>
        )}
        <div className="message-related-content"><RelatedContentPanel kind="mail" entityId={selected.id} refreshKey={mailRelatedVersion} hideWhenEmpty excludeRelations={["project-item"]} /></div>
        <div className="message-body">
          {hasAccounts && threadLoading && <div className="body-status"><LoaderCircle className="spin" size={18} />正在整理邮件线程…</div>}
          {hasAccounts && !threadLoading && <div className="mail-thread" data-testid="mail-thread">
            {displayedThreadMessages.map((threadMessage, index) => {
              const expanded = expandedThreadMessages.has(threadMessage.id);
              const body = bodies[threadMessage.id];
              const html = body?.status === "ready" && body.html
                ? remoteImagesAllowed.has(threadMessage.id) ? enableRemoteEmailImages(body.html) : body.html
                : undefined;
              const digitallySigned = threadMessage.attachments.some(isSmimeSignatureAttachment);
              const visibleAttachments = threadMessage.attachments.filter((attachment) => !attachment.inline && !isSmimeSignatureAttachment(attachment));
              return <section className={`thread-message ${expanded ? "expanded" : "collapsed"}`} key={threadMessage.id}>
                <div className="thread-message-toggle" role="button" tabIndex={0} aria-expanded={expanded} onClick={() => setExpandedThreadMessages((current) => {
                  const next = new Set(current);
                  if (next.has(threadMessage.id)) next.delete(threadMessage.id); else next.add(threadMessage.id);
                  return next;
                })} onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                  event.preventDefault();
                  setExpandedThreadMessages((current) => {
                    const next = new Set(current);
                    if (next.has(threadMessage.id)) next.delete(threadMessage.id); else next.add(threadMessage.id);
                    return next;
                  });
                }}>
                  <span className="thread-avatar" style={{ background: mailSenderAvatarColor(threadMessage.senderAddress, threadMessage.senderName) }}>{threadMessage.senderName.slice(0, 1).toLocaleUpperCase()}</span>
                  <span className="thread-message-summary"><strong>{threadMessage.senderName}</strong><small>{threadMessage.folderRole === "sent" ? "已发送" : `发送给 ${threadMessage.to.map((item) => item.name || item.address).join(", ") || "我"}`}</small>{!expanded && <em>{threadMessage.snippet || "正文将在展开时读取"}</em>}</span>
                  <span className="thread-message-meta">{digitallySigned && <span className="smime-signature-badge" role="img" aria-label="数字签名邮件" title="数字签名邮件"><Award size={13} aria-hidden="true" /></span>}{threadMessage.isStarred && <Star size={12} fill="currentColor" />}{body?.status === "ready" && <button className="thread-refresh-button" aria-label="重新从服务器获取邮件正文" title="重新从服务器获取" disabled={Boolean(bodyRefreshBusyId)} onClick={(event) => { event.stopPropagation(); void refreshMessageBody(threadMessage.id); }}>{bodyRefreshBusyId === threadMessage.id ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}</button>}{body?.status === "ready" && <span className="thread-cache-state"><ShieldCheck size={12} />{body.cached ? "本地缓存" : "已安全读取并缓存"}</span>}<time>{formatMailTime(threadMessage.receivedAt)}</time><ChevronDown size={15} /></span>
                </div>
                {expanded && <div className="thread-message-content">
                  {(!body || body.status === "loading") && <div className="body-status" data-testid="mail-body-loading"><LoaderCircle className="spin" size={17} />正在安全读取正文…</div>}
                  {body?.status === "error" && <div className="body-error" data-testid="mail-body-error"><p>{body.message}</p><button className="secondary-button" onClick={() => setBodyRetry((value) => value + 1)}>重试</button></div>}
                  {body?.status === "ready" && <div data-testid={index === 0 ? "mail-body-content" : undefined}>
                    {body.hasBlockedRemoteImages && !remoteImagesAllowed.has(threadMessage.id) && <div className="body-security-bar"><button className="ghost-button show-mail-images" onClick={() => setRemoteImagesAllowed((current) => new Set([...current, threadMessage.id]))}><ImageIcon size={14} />显示图片</button></div>}
                    {html ? <div className="mail-body-html" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="mail-body-text">{body.text || "（邮件正文为空）"}</div>}
                  </div>}
                  {visibleAttachments.length > 0 && <section className="incoming-attachments" aria-label="邮件附件"><header><Paperclip size={14} /><strong>附件</strong><span>{visibleAttachments.length}</span></header><div>{threadMessage.attachments.map((attachment, attachmentIndex) => attachment.inline || isSmimeSignatureAttachment(attachment) ? null : <a href={`/api/messages/${encodeURIComponent(threadMessage.id)}/attachments/${attachmentIndex}`} key={`${attachment.filename}:${attachmentIndex}`}><FileText size={16} /><span><strong>{attachment.filename}</strong><small>{attachment.contentType} · {formatFileSize(attachment.sizeBytes)}</small></span><em>下载</em></a>)}</div></section>}
                </div>}
              </section>;
            })}
          </div>}
        </div>
      </article> : <article className="message-detail empty-detail" ref={messageDetailRef}><Mail size={30} /><p>选择一封邮件查看内容</p></article>}
    </div>
    {contextMenu && contextMessage && (
      <ContextMenu
        anchor={{ x: contextMenu.x, y: contextMenu.y }}
        ariaLabel={`邮件操作：${contextMessage.subject}`}
        commands={contextCommands}
        heading={contextMessage.subject}
        returnFocus={menuReturnFocusRef.current}
        testId="mail-context-menu"
        onClose={closeContextMenu}
        onSelect={handleContextCommand}
      />
    )}
    {mailProjectTarget && (
      <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMailProjectTargetId(undefined); }}>
        <section className="calendar-dialog mail-project-dialog panel" role="dialog" aria-modal="true" aria-labelledby="mail-project-dialog-title">
          <header><div><span>只关联需要长期保留上下文的邮件</span><h2 id="mail-project-dialog-title">关联到项目</h2></div><button aria-label="关闭" onClick={() => setMailProjectTargetId(undefined)}><X size={18} /></button></header>
          <p className="mail-project-dialog-subject">{mailProjectTarget.subject}</p>
          <ProjectAssociationControl kind="mail" entityId={mailProjectTarget.id} onChanged={() => {
            setMailRelatedVersion((current) => current + 1);
            setMailProjectTargetId(undefined);
            setMailNotice("已更新邮件项目关联");
          }} />
          <footer><small>普通通知和临时沟通无需归入项目。</small><div><button className="secondary-button" onClick={() => setMailProjectTargetId(undefined)}>完成</button></div></footer>
        </section>
      </div>
    )}
    {composer && !isInlineReplyComposer && (
      <div className="mail-composer-backdrop" data-testid="mail-composer-backdrop">
        <section className="mail-composer" role="dialog" aria-modal="true" aria-labelledby="mail-composer-title" data-testid="mail-composer">
          <header>
            <div>
              <h2 id="mail-composer-title">{composer.replyToMessageId ? "回复邮件" : "撰写邮件"}</h2>
              <span className={`composer-save-state ${composerSaveState}`}>
                {composerSaveState === "saving" ? "正在保存…" : composerSaveState === "error" ? "保存失败" : "已保存草稿"}
              </span>
            </div>
            <button className="composer-icon-button" aria-label="关闭并保存草稿" title="关闭并保存草稿" disabled={sendBusy || attachmentBusy} onClick={() => void closeComposer()}><X size={18} /></button>
          </header>
          <div className="mail-composer-fields">
            <label>
              <span>发件人</span>
              <select
                aria-label="发件账户"
                value={composer.accountId}
                disabled={Boolean(composer.replyToMessageId) || sendBusy || attachmentBusy}
                onChange={(event) => setComposer({ ...composer, accountId: event.target.value })}
              >
                {mailAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName} &lt;{account.emailAddress}&gt;</option>)}
              </select>
            </label>
            <label>
              <span>收件人</span>
              <input aria-label="收件人" value={composer.to.join(", ")} disabled={sendBusy || attachmentBusy} placeholder="name@example.com" onChange={(event) => setComposer({ ...composer, to: splitMailAddresses(event.target.value) })} />
            </label>
            <details className="composer-copy-fields" open={composer.cc.length > 0 || composer.bcc.length > 0}>
              <summary>抄送 / 密送</summary>
              <label><span>抄送</span><input aria-label="抄送" value={composer.cc.join(", ")} disabled={sendBusy || attachmentBusy} onChange={(event) => setComposer({ ...composer, cc: splitMailAddresses(event.target.value) })} /></label>
              <label><span>密送</span><input aria-label="密送" value={composer.bcc.join(", ")} disabled={sendBusy || attachmentBusy} onChange={(event) => setComposer({ ...composer, bcc: splitMailAddresses(event.target.value) })} /></label>
            </details>
            <label>
              <span>主题</span>
              <input aria-label="邮件主题" value={composer.subject} disabled={sendBusy || attachmentBusy} placeholder="邮件主题" onChange={(event) => setComposer({ ...composer, subject: event.target.value })} />
            </label>
            {composerFileAttachments.length > 0 && (
              <div className="mail-attachment-list" aria-label="邮件附件">
                {composerFileAttachments.map((attachment) => (
                  <div key={attachment.id}>
                    <Paperclip size={14} />
                    <span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.sizeBytes)}</small></span>
                    <button aria-label={`删除附件：${attachment.filename}`} disabled={attachmentBusy || sendBusy} onClick={() => void removeComposerAttachment(attachment.id)}><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <MailComposerEditor
              draftId={composer.id}
              content={composer.bodyContent || EMPTY_PLATE_NOTE_CONTENT}
              disabled={sendBusy || attachmentBusy}
              onPasteImages={async (files) => (await uploadComposerAttachments(files, true)).map((attachment) => ({
                attachmentId: attachment.id,
                filename: attachment.filename,
                url: `/api/mail-drafts/${encodeURIComponent(composer.id)}/attachments/${encodeURIComponent(attachment.id)}`,
              }))}
              onChange={(bodyContent) => setComposer((current) => current ? {
                ...current,
                bodyContent,
                textBody: noteContentToPlainText(bodyContent),
              } : current)}
            />
            {composer.errorMessage && <div className="composer-error"><AlertCircle size={14} />上次发送失败：{composer.errorMessage}</div>}
          </div>
          <footer>
            <div className="mail-compose-secondary-actions">
              <button className="composer-discard" disabled={sendBusy || attachmentBusy} onClick={() => void discardComposer()}><Trash2 size={15} />删除草稿</button>
              <input
                ref={attachmentInputRef}
                className="mail-attachment-input"
                type="file"
                multiple
                aria-label="选择邮件附件"
                onChange={(event) => void uploadComposerAttachments(Array.from(event.target.files ?? []))}
              />
              <button className="composer-attach" disabled={sendBusy || attachmentBusy || composer.attachments.length >= 10} onClick={() => attachmentInputRef.current?.click()}>
                {attachmentBusy ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}添加附件
              </button>
            </div>
            <div>
              <button className="secondary-button" disabled={sendBusy || attachmentBusy} onClick={() => void closeComposer()}>稍后发送</button>
              <button className="primary-button" disabled={sendBusy || attachmentBusy || composerSaveState === "saving"} onClick={() => void requestSendConfirmation()}><Send size={15} />检查并发送</button>
            </div>
          </footer>
        </section>
      </div>
    )}
    {composer && sendConfirmationKey && (
      <div className="mail-send-confirmation-backdrop">
        <section className="mail-send-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="mail-send-confirmation-title" data-testid="mail-send-confirmation">
          <div className="confirmation-icon"><Send size={20} /></div>
          <h2 id="mail-send-confirmation-title">确认发送这封邮件？</h2>
          <dl>
            <div><dt>发件人</dt><dd>{composerAccount?.displayName} &lt;{composerAccount?.emailAddress}&gt;</dd></div>
            <div><dt>收件人</dt><dd>{[...composer.to, ...composer.cc, ...composer.bcc].join(", ")}</dd></div>
            <div><dt>主题</dt><dd>{composer.subject}</dd></div>
            {composerFileAttachments.length > 0 && <div><dt>附件</dt><dd>{composerFileAttachments.length} 个 · {formatFileSize(composerFileAttachments.reduce((total, item) => total + item.sizeBytes, 0))}</dd></div>}
            {composerInlineImages.length > 0 && <div><dt>正文图片</dt><dd>{composerInlineImages.length} 张</dd></div>}
          </dl>
          <p>点击“确认发送”后会立即通过邮箱服务器发出，无法撤回。</p>
          <footer>
            <button className="secondary-button" disabled={sendBusy} onClick={() => setSendConfirmationKey(undefined)}>返回修改</button>
            <button className="primary-button" disabled={sendBusy} onClick={() => void confirmSend()}>{sendBusy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}确认发送</button>
          </footer>
        </section>
      </div>
    )}
    {mailNotice && <TransientToast message={mailNotice} onClose={() => setMailNotice(null)} testId="mail-action-notice" />}
    </>
  );
}

function enableRemoteEmailImages(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll<HTMLImageElement>("img[data-remote-src]").forEach((image) => {
    const source = image.dataset.remoteSrc;
    if (!source || !/^https?:\/\//i.test(source)) return;
    image.src = source;
    image.removeAttribute("data-remote-src");
  });
  return document.body.innerHTML;
}

function formatMailTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}
