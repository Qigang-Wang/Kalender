"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle, Archive, Award, CalendarDays, Check, CheckCircle2, CheckSquare2,
  ChevronDown, ChevronLeft, ChevronRight, Circle, Copy, Download, FileArchive, FileText, Folder,
  Forward, ImageIcon, Link2, ListChecks, LoaderCircle, Mail, MoreHorizontal,
  MailOpen, Paperclip, Pencil, RefreshCw, Reply, ReplyAll, Search, Send, ShieldCheck,
  Sparkles, Star, Trash2, Upload, WandSparkles, X,
} from "lucide-react";
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";

import { fetchWithTimeout, readApiJson } from "@/lib/fetch-with-timeout";
import { replaceMailSignatureContent, type MailSignatureVariant } from "@/lib/mail-signature-content";
import { decodeNoteContent, EMPTY_PLATE_NOTE_CONTENT, encodeNoteContent, noteContentToPlainText } from "@/lib/note-content";
import { groupMailByDate, type MailDateGroupId } from "@/lib/mail-date-groups";
import { resolveReplyRecipients } from "@/lib/mail-reply-recipients";
import { isSmimeSignatureAttachment } from "@/lib/mail-smime";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { useVisiblePageRefresh } from "@/hooks/use-visible-page-refresh";
import { useRealtimeRefresh } from "@/components/realtime-context";
import { AppSelect } from "../app-select";
import { ContextMenu } from "../context-menu";
import { resolveContextCommands, type ContextCommandId, type MailMessageCommandId } from "../context-commands";
import { useWorkspaceAssistant, type MailAssistantAction } from "../workspace-assistant-context";
import { TransientToast } from "../workspace-shared";
import { MailProjectChip, ProjectAssociationControl, RelatedContentPanel } from "./related-content";

const MAIL_MESSAGE_DRAG_TYPE = "application/x-kalender-mail-message";
const MAIL_MESSAGE_MOVED_EVENT = "kalender:mail-message-moved";
const MAIL_SYNCED_EVENT = "kalender:mail-synced";
const MAIL_LIST_WIDTH_STORAGE_KEY = "kalender:mail-list-width";
const MIN_MAIL_LIST_WIDTH = 240;
const MAX_MAIL_LIST_WIDTH = 760;
const MIN_MAIL_DETAIL_WIDTH = 320;
const MAIL_PANE_RESIZE_HANDLE_WIDTH = 9;

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
  return ({ inbox: "Posteingang", drafts: "Entwürfe", sent: "Gesendet", archive: "Archiv", all: "Alle E-Mails", junk: "Spam", spam: "Spam", trash: "Gelöscht" } as Record<string, string>)[folder.role] ?? folder.name;
}

function mailMessageHref(messageId: string): string {
  return `/inbox?message=${encodeURIComponent(messageId)}`;
}

function clampEmailBodyFontSizes(html?: string): string | undefined {
  if (!html || typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of document.body.querySelectorAll<HTMLElement>("[style*='font-size'], font[size]")) {
    const hasOwnText = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (!hasOwnText) continue;
    const rawSize = element.style.fontSize.trim().toLowerCase();
    const match = rawSize.match(/^([\d.]+)(px|pt|em|rem|%)$/);
    const value = match ? Number.parseFloat(match[1]!) : Number.NaN;
    const unit = match?.[2];
    const pixels = unit === "px" ? value
      : unit === "pt" ? value * 4 / 3
        : unit === "em" || unit === "rem" ? value * 16
          : unit === "%" ? value * 0.16
            : element.tagName === "FONT" && element.getAttribute("size") === "1" ? 10
              : Number.NaN;
    if (Number.isFinite(pixels) && pixels < 12) {
      element.style.fontSize = "12px";
      if (element.tagName === "FONT") element.removeAttribute("size");
    }
  }
  return document.body.innerHTML;
}

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

const MailComposerEditor = dynamic(
  () => import("../editor/mail-composer-editor").then((module) => module.MailComposerEditor),
  { loading: () => <EditorLoading label="Mail-Editor wird geladen..." />, ssr: false },
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
  readonly direction?: "incoming" | "outgoing";
  readonly folderRole?: string;
  readonly correspondentName?: string;
  readonly correspondentAddress?: string;
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
  readonly direction?: "incoming" | "outgoing";
  readonly folderRole?: string;
  readonly correspondentName?: string;
  readonly correspondentAddress?: string;
}

interface MailCorrespondenceSummary {
  readonly name: string;
  readonly address: string;
  readonly totalCount: number;
  readonly unreadCount: number;
  readonly incomingCount: number;
  readonly outgoingCount: number;
  readonly lastContactAt?: string;
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

type MailAiAction = MailAssistantAction;

interface MailAiViewResult {
  readonly messageId: string;
  readonly action: MailAiAction;
  readonly text: string;
  readonly modelName: string;
  readonly usedFallback: boolean;
}

type MailUiAction = "mark-read" | "mark-unread" | "star" | "unstar" | "archive" | "delete";
type MailFilter = "all" | "unread" | "starred" | "incoming" | "outgoing" | "attachments";

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
  readonly localOnly?: boolean;
  readonly accountId: string;
  readonly replyToMessageId?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  readonly bodyContent: string;
  readonly signatureId?: string;
  readonly signatureVariant?: MailSignatureVariant;
  readonly attachments: readonly ClientMailAttachment[];
  readonly status: "draft" | "sending" | "sent" | "failed";
  readonly errorMessage?: string;
  readonly updatedAt: string;
}

interface ClientMailSignature {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly fullText: string;
  readonly shortText: string;
  readonly isDefault: boolean;
}

interface ClientMailAttachment {
  readonly id: string;
  readonly draftId?: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly inline: boolean;
  readonly contentId?: string;
  readonly createdAt: string;
}

type ComposerSaveState = "idle" | "saved" | "saving" | "error";

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
    signatureId: draft.signatureId,
    signatureVariant: draft.signatureVariant,
  };
}

function mailDraftHasContent(draft: ClientMailDraft): boolean {
  const bodyWithoutSignature = noteContentToPlainText(replaceMailSignatureContent(draft.bodyContent)).trim();
  if (bodyWithoutSignature || draft.attachments.length > 0) return true;
  if (draft.replyToMessageId) return false;
  return draft.to.length + draft.cc.length + draft.bcc.length > 0 || Boolean(draft.subject.trim());
}

function composerSaveLabel(state: ComposerSaveState, inline = false): string {
  if (state === "idle") return "nicht gespeichert";
  if (state === "saving") return "Speichern...";
  if (state === "error") return "Speichern fehlgeschlagen";
  return inline ? "automatisch gespeicherte Entwürfe" : "gespeicherter Entwurf";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function prefixedMailSubject(subject: string, prefix: "Re" | "Fwd"): string {
  const withoutPrefix = subject.replace(/^\s*(?:re|fwd|fw)\s*:\s*/i, "").trim();
  return `${prefix}: ${withoutPrefix || "Software-Interface-Text (kein Thema)"}`;
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
    preview: item.snippet || "Körper wird auf Anfrage beim Öffnen der Mail heruntergeladen werden",
    receivedAt: item.receivedAt,
    time: formatMailTime(item.receivedAt),
    accountName: item.accountName,
    accountColor: item.accountColor,
    isRead: item.isRead,
    isStarred: item.isStarred,
    canArchive: item.canArchive,
    attachments: item.attachments ?? [],
    direction: item.direction,
    folderRole: item.folderRole,
    correspondentName: item.correspondentName,
    correspondentAddress: item.correspondentAddress,
  }));
}

function mergeRefreshedInboxPage(
  current: readonly InboxDisplayItem[] | null,
  refreshed: readonly InboxDisplayItem[],
): readonly InboxDisplayItem[] {
  if (!current || current.length <= refreshed.length || refreshed.length === 0) return refreshed;
  const refreshedIds = new Set(refreshed.map((item) => item.id));
  const refreshedThreads = new Set(refreshed.map((item) => item.threadId));
  const oldestRefreshedAt = Date.parse(refreshed.at(-1)!.receivedAt);
  const olderLoadedItems = current.filter((item) =>
    !refreshedIds.has(item.id)
    && !refreshedThreads.has(item.threadId)
    && Date.parse(item.receivedAt) < oldestRefreshedAt
  );
  return [...refreshed, ...olderLoadedItems];
}

function clampMailListWidth(width: number, layoutWidth = Number.POSITIVE_INFINITY): number {
  const availableMaximum = Number.isFinite(layoutWidth)
    ? layoutWidth - MIN_MAIL_DETAIL_WIDTH - MAIL_PANE_RESIZE_HANDLE_WIDTH
    : MAX_MAIL_LIST_WIDTH;
  const maximum = Math.max(MIN_MAIL_LIST_WIDTH, Math.min(MAX_MAIL_LIST_WIDTH, availableMaximum));
  return Math.min(maximum, Math.max(MIN_MAIL_LIST_WIDTH, Math.round(width)));
}

function MailPaneResizeHandle({
  width,
  onChange,
}: {
  readonly width?: number;
  readonly onChange: (width?: number) => void;
}) {
  const dragState = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    previewWidth: number;
  } | undefined>(undefined);

  const finishResize = useCallback((element?: HTMLDivElement, pointerId?: number) => {
    if (element && pointerId !== undefined && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    dragState.current = undefined;
    document.body.classList.remove("mail-pane-is-resizing");
  }, []);

  useEffect(() => () => document.body.classList.remove("mail-pane-is-resizing"), []);

  const layoutFor = (element: HTMLDivElement) => element.closest<HTMLElement>(".mail-layout");
  const measuredListWidth = (element: HTMLDivElement) =>
    layoutFor(element)?.querySelector<HTMLElement>(".message-list")?.getBoundingClientRect().width
    ?? MIN_MAIL_LIST_WIDTH;

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const startWidth = measuredListWidth(event.currentTarget);
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      previewWidth: startWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("mail-pane-is-resizing");
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const layout = layoutFor(event.currentTarget);
    drag.previewWidth = clampMailListWidth(
      drag.startWidth + event.clientX - drag.startX,
      layout?.getBoundingClientRect().width,
    );
    layout?.style.setProperty("--mail-list-width", `${drag.previewWidth}px`);
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    finishResize(event.currentTarget, event.pointerId);
    onChange(drag.previewWidth);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const layoutWidth = layoutFor(event.currentTarget)?.getBoundingClientRect().width;
    const currentWidth = width ?? measuredListWidth(event.currentTarget);
    const step = event.shiftKey ? 24 : 8;
    let nextWidth: number | undefined;
    if (event.key === "ArrowLeft") nextWidth = currentWidth - step;
    if (event.key === "ArrowRight") nextWidth = currentWidth + step;
    if (event.key === "Home") nextWidth = MIN_MAIL_LIST_WIDTH;
    if (event.key === "End") nextWidth = MAX_MAIL_LIST_WIDTH;
    if (nextWidth === undefined) return;
    event.preventDefault();
    onChange(clampMailListWidth(nextWidth, layoutWidth));
  };

  const resetWidth = (event: ReactMouseEvent<HTMLDivElement>) => {
    layoutFor(event.currentTarget)?.style.removeProperty("--mail-list-width");
    onChange(undefined);
  };

  return (
    <div
      className="mail-pane-resize-handle"
      role="separator"
      aria-label="Passen Sie die Breite der Mailingliste an die Mail-Details an"
      aria-orientation="vertical"
      aria-valuemin={MIN_MAIL_LIST_WIDTH}
      aria-valuemax={MAX_MAIL_LIST_WIDTH}
      aria-valuenow={width}
      aria-valuetext={width ? `${width} Pixel` : "automatische Skala"}
      tabIndex={0}
      title="Ziehen, um die Breite anzupassen; Doppelklicken, um die Standardeinstellung wiederherzustellen"
      onDoubleClick={resetWidth}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
    />
  );
}

export function InboxPage({
  initialMessageId,
  initialFolderId,
  initialCorrespondent,
  initialComposeTo,
  onOpenAssistant,
}: {
  readonly initialMessageId?: string;
  readonly initialFolderId?: string;
  readonly initialCorrespondent?: string;
  readonly initialComposeTo?: string;
  readonly onOpenAssistant?: () => void;
}) {
  const router = useRouter();
  const { publish, registerCommandHandler } = useWorkspaceAssistant();
  const [remoteItems, setRemoteItems] = useState<readonly InboxDisplayItem[] | null>(null);
  const [nextInboxCursor, setNextInboxCursor] = useState<InboxPageCursor>();
  const [mailPageLoading, setMailPageLoading] = useState(false);
  const [hasAccounts, setHasAccounts] = useState(false);
  const [mailLoadError, setMailLoadError] = useState<string>();
  const [mailboxLabel, setMailboxLabel] = useState("Posteingang");
  const [correspondenceSummary, setCorrespondenceSummary] = useState<MailCorrespondenceSummary>();
  const [selectedId, setSelectedId] = useState(initialMessageId ?? "");
  const [bodies, setBodies] = useState<Readonly<Record<string, InboxBodyState>>>({});
  const [threadMessages, setThreadMessages] = useState<readonly MailThreadDisplayMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [expandedThreadMessages, setExpandedThreadMessages] = useState<ReadonlySet<string>>(() => new Set());
  const [bodyRetry, setBodyRetry] = useState(0);
  const [bodyRefreshBusyId, setBodyRefreshBusyId] = useState<string>();
  const [remoteImagesAllowed, setRemoteImagesAllowed] = useState<ReadonlySet<string>>(() => new Set());
  const [mailAccounts, setMailAccounts] = useState<readonly SavedMailAccount[]>([]);
  const [mailSignatures, setMailSignatures] = useState<readonly ClientMailSignature[]>([]);
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
  const [mailFilter, setMailFilter] = useState<MailFilter>("all");
  const [mailAccountFilter, setMailAccountFilter] = useState("all");
  const [mailQuery, setMailQuery] = useState("");
  const [mobileMailDetail, setMobileMailDetail] = useState(Boolean(initialMessageId));
  const [mailListWidth, setMailListWidth] = useState<number>();
  const [mailListWidthLoaded, setMailListWidthLoaded] = useState(false);
  const [draggedMessageId, setDraggedMessageId] = useState<string>();
  const [collapsedDateGroups, setCollapsedDateGroups] = useState<ReadonlySet<MailDateGroupId>>(() => new Set());
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string>();
  const [batchActionBusy, setBatchActionBusy] = useState<MailUiAction>();
  const [batchDeletePending, setBatchDeletePending] = useState(false);
  const [senderCardOpen, setSenderCardOpen] = useState(false);
  const [senderCardSummary, setSenderCardSummary] = useState<MailCorrespondenceSummary>();
  const [senderCardLoading, setSenderCardLoading] = useState(false);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const messageDetailRef = useRef<HTMLElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const senderCardCloseTimerRef = useRef<number | undefined>(undefined);
  const initialComposerRecipientRef = useRef("");

  useEffect(() => () => {
    if (senderCardCloseTimerRef.current) window.clearTimeout(senderCardCloseTimerRef.current);
  }, []);

  useEffect(() => {
    try {
      const storedWidth = Number(window.localStorage.getItem(MAIL_LIST_WIDTH_STORAGE_KEY));
      if (Number.isFinite(storedWidth) && storedWidth > 0) {
        setMailListWidth(clampMailListWidth(storedWidth));
      }
    } catch {
      // The default proportional layout remains available without browser storage.
    } finally {
      setMailListWidthLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!mailListWidthLoaded) return;
    const timer = window.setTimeout(() => {
      try {
        if (mailListWidth === undefined) {
          window.localStorage.removeItem(MAIL_LIST_WIDTH_STORAGE_KEY);
        } else {
          window.localStorage.setItem(MAIL_LIST_WIDTH_STORAGE_KEY, String(mailListWidth));
        }
      } catch {
        // The current session still keeps the resized layout.
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [mailListWidth, mailListWidthLoaded]);

  const refreshMailDrafts = useCallback(async () => {
    const response = await fetch("/api/mail-drafts", { cache: "no-store" });
    const payload = await response.json() as { readonly drafts?: readonly ClientMailDraft[]; readonly message?: string };
    if (!response.ok) throw new Error(payload.message || "E-Mail-Entwurf kann nicht gelesen werden");
    setMailDrafts(payload.drafts ?? []);
  }, []);

  const persistComposer = useCallback(async (draft: ClientMailDraft, force = false): Promise<ClientMailDraft> => {
    if (!force && !mailDraftHasContent(draft)) {
      setComposerSaveState("idle");
      return draft;
    }
    setComposerSaveState("saving");
    try {
      const response = await fetch(draft.localOnly ? "/api/mail-drafts" : `/api/mail-drafts/${encodeURIComponent(draft.id)}`, {
        method: draft.localOnly ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mailDraftPayload(draft)),
      });
      const payload = await response.json() as { readonly draft?: ClientMailDraft; readonly message?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.message || "Entwurfsspeicher fehlgeschlagen");
      setMailDrafts((current) => [payload.draft!, ...current.filter((item) => item.id !== payload.draft!.id)]);
      if (draft.localOnly) {
        setComposer((current) => {
          if (!current || current.id !== draft.id) return current;
          const unchanged = JSON.stringify(mailDraftPayload(current)) === JSON.stringify(mailDraftPayload(draft));
          if (unchanged) return payload.draft;
          return {
            ...current,
            id: payload.draft!.id,
            localOnly: false,
            updatedAt: payload.draft!.updatedAt,
          };
        });
      }
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
        if (!response.ok) throw new Error("Postfachkonten können nicht gelesen werden");
        return payload.accounts ?? [];
      }),
      workspaceFetch("/api/mail-drafts").then(async (response) => {
        const payload = await response.json() as { readonly drafts?: readonly ClientMailDraft[]; readonly message?: string };
        if (!response.ok) throw new Error(payload.message || "E-Mail-Entwurf kann nicht gelesen werden");
        return payload.drafts ?? [];
      }),
      fetch("/api/mail-signatures", { cache: "no-store" }).then(async (response) => {
        const payload = await response.json() as { readonly signatures?: readonly ClientMailSignature[]; readonly message?: string };
        if (!response.ok) throw new Error(payload.message || "E-Mail-Signatur kann nicht gelesen werden");
        return payload.signatures ?? [];
      }),
    ]).then(([accounts, drafts, signatures]) => {
      if (cancelled) return;
      setMailAccounts(accounts);
      setMailDrafts(drafts);
      setMailSignatures(signatures);
    }).catch((error: unknown) => {
      if (!cancelled) setMailNotice(error instanceof Error ? error.message : "E-Mail-Schreibdaten können nicht gelesen werden");
    });
    return () => { cancelled = true; };
  }, []);

  const applyComposerSignature = useCallback((selection: string) => {
    setComposer((current) => {
      if (!current) return current;
      if (selection === "none") {
        const bodyContent = replaceMailSignatureContent(current.bodyContent);
        return {
          ...current,
          bodyContent,
          textBody: noteContentToPlainText(bodyContent),
          signatureId: undefined,
          signatureVariant: undefined,
        };
      }
      const [signatureId, variantValue] = selection.split(":");
      const variant: MailSignatureVariant = variantValue === "short" ? "short" : "full";
      const signature = mailSignatures.find((item) => item.id === signatureId && item.accountId === current.accountId);
      if (!signature) return current;
      const bodyContent = replaceMailSignatureContent(current.bodyContent, {
        id: signature.id,
        variant,
        text: variant === "full" ? signature.fullText : signature.shortText,
      });
      return {
        ...current,
        bodyContent,
        textBody: noteContentToPlainText(bodyContent),
        signatureId: signature.id,
        signatureVariant: variant,
      };
    });
  }, [mailSignatures]);

  const changeComposerAccount = useCallback((accountId: string) => {
    setComposer((current) => {
      if (!current) return current;
      const signature = mailSignatures.find((item) => item.accountId === accountId && item.isDefault);
      const bodyContent = signature
        ? replaceMailSignatureContent(current.bodyContent, { id: signature.id, variant: "full", text: signature.fullText })
        : replaceMailSignatureContent(current.bodyContent);
      return {
        ...current,
        accountId,
        bodyContent,
        textBody: noteContentToPlainText(bodyContent),
        signatureId: signature?.id,
        signatureVariant: signature ? "full" : undefined,
      };
    });
  }, [mailSignatures]);

  useEffect(() => {
    const handleMovedMessage = (event: Event) => {
      const detail = (event as CustomEvent<MailMessageMovedDetail>).detail;
      if (!detail?.messageId) return;
      const nextItems = (remoteItems ?? []).filter((item) => item.id !== detail.messageId);
      setRemoteItems(nextItems);
      setSelectedId((current) => current === detail.messageId ? nextItems[0]?.id ?? "" : current);
      setDraggedMessageId(undefined);
      setMailNotice(detail.movedCount > 1
        ? `${detail.movedCount} E-Mails wurden nach „${detail.destinationName}“ verschoben`
        : `E-Mail wurde nach „${detail.destinationName}“ verschoben`);
    };
    window.addEventListener(MAIL_MESSAGE_MOVED_EVENT, handleMovedMessage);
    return () => window.removeEventListener(MAIL_MESSAGE_MOVED_EVENT, handleMovedMessage);
  }, [remoteItems]);

  useEffect(() => {
    if (!composer || composer.status === "sending" || composer.status === "sent") return;
    if (!mailDraftHasContent(composer)) {
      setComposerSaveState("idle");
      return;
    }
    setComposerSaveState("saving");
    const timer = window.setTimeout(() => {
      void persistComposer(composer).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [composer?.accountId, composer?.attachments.length, composer?.bcc, composer?.bodyContent, composer?.cc, composer?.localOnly, composer?.signatureId, composer?.signatureVariant, composer?.subject, composer?.textBody, composer?.to, persistComposer]);

  useEffect(() => {
    setInlineCopyFieldsOpen(Boolean(composer?.cc.length || composer?.bcc.length));
  }, [composer?.id]);

  const openComposer = async (
    message?: InboxDisplayItem,
    mode: "reply" | "forward" = "reply",
    initialText = "",
    recipient?: { readonly address: string; readonly accountId?: string },
  ) => {
    if (mailAccounts.length === 0) {
      setMailNotice("Bitte verbinden Sie zunächst ein Konto mit dem Mail in den Einstellungen gesendet werden kann.");
      return;
    }
    const account = message
      ? mailAccounts.find((item) => item.id === message.accountId)
      : mailAccounts.find((item) => item.id === recipient?.accountId) ?? mailAccounts[0];
    if (!account) {
      setMailNotice("Für diese E-Mail wurde kein Sendekonto gefunden.");
      return;
    }
    const currentBody = message ? bodies[message.id] : undefined;
    const forwardText = message && mode === "forward"
      ? `\n\n- -- E-Mail weiterleiten --\n Absender:${message.sender} <${message.senderAddress}>\n Thema:${message.subject}\n\n${currentBody?.status === "ready" ? currentBody.text || message.preview : message.preview}`
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
      : {
          to: message && mode === "reply"
            ? [message.senderAddress]
            : recipient?.address ? [recipient.address] : [],
          cc: [],
        };
    const signature = mailSignatures.find((item) => item.accountId === account.id && item.isDefault);
    const hasSentInThread = Boolean(message && mode === "reply" && threadMessages.some((threadMessage) =>
      threadMessage.threadId === message.threadId
      && threadMessage.accountId === account.id
      && threadMessage.folderRole === "sent",
    ));
    const signatureVariant: MailSignatureVariant = hasSentInThread ? "short" : "full";
    const signedBodyContent = signature
      ? replaceMailSignatureContent(bodyContent, {
          id: signature.id,
          variant: signatureVariant,
          text: signatureVariant === "full" ? signature.fullText : signature.shortText,
        })
      : bodyContent;
    const localDraft: ClientMailDraft = {
      id: `local:${crypto.randomUUID()}`,
      localOnly: true,
      accountId: account.id,
      replyToMessageId: message && mode === "reply" ? message.id : undefined,
      to: replyRecipients.to.length || mode !== "reply" ? replyRecipients.to : message ? [message.senderAddress] : [],
      cc: replyRecipients.cc,
      bcc: [],
      subject: message ? prefixedMailSubject(message.subject, mode === "reply" ? "Re" : "Fwd") : "",
      textBody: noteContentToPlainText(signedBodyContent),
      bodyContent: signedBodyContent,
      signatureId: signature?.id,
      signatureVariant: signature ? signatureVariant : undefined,
      attachments: [],
      status: "draft",
      updatedAt: new Date().toISOString(),
    };
    setComposer(localDraft);
    setComposerSaveState(mailDraftHasContent(localDraft) ? "saving" : "idle");
    setSendConfirmationKey(undefined);
  };

  useEffect(() => {
    const recipient = initialComposeTo?.trim();
    if (!recipient || mailAccounts.length === 0 || initialComposerRecipientRef.current === recipient) return;
    initialComposerRecipientRef.current = recipient;
    void openComposer(undefined, "reply", "", { address: recipient });
  }, [initialComposeTo, mailAccounts.length]);

  const closeComposer = async () => {
    if (!composer || sendBusy || attachmentBusy) return;
    if (!mailDraftHasContent(composer)) {
      try {
        if (!composer.localOnly) {
          const response = await fetch(`/api/mail-drafts/${encodeURIComponent(composer.id)}`, { method: "DELETE" });
          if (!response.ok && response.status !== 404) {
            const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
            throw new Error(payload?.message || "Leere Entwürfe können nicht gelöscht werden");
          }
          setMailDrafts((current) => current.filter((item) => item.id !== composer.id));
        }
        setComposer(undefined);
        setSendConfirmationKey(undefined);
      } catch (error) {
        setMailNotice(error instanceof Error ? error.message : "Leere Entwürfe können nicht geschlossen werden");
      }
      return;
    }
    try {
      await persistComposer(composer);
      setComposer(undefined);
      setSendConfirmationKey(undefined);
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "Entwurf speichern fehlgeschlagen, bitte versuchen Sie es später noch einmal");
    }
  };

  const discardComposer = async () => {
    if (!composer || sendBusy || attachmentBusy) return;
    if (composer.localOnly) {
      setComposer(undefined);
      setSendConfirmationKey(undefined);
      return;
    }
    try {
      const response = await fetch(`/api/mail-drafts/${encodeURIComponent(composer.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "Entwurf kann nicht gelöscht werden");
      setMailDrafts((current) => current.filter((item) => item.id !== composer.id));
      setComposer(undefined);
      setSendConfirmationKey(undefined);
      setMailNotice("Gestrichener Entwurf");
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "Entwurf kann nicht gelöscht werden");
    }
  };

  const uploadComposerAttachments = async (files: readonly File[], inline = false): Promise<readonly ClientMailAttachment[]> => {
    if (!composer || files.length === 0 || attachmentBusy || sendBusy) return [];
    setAttachmentBusy(true);
    try {
      const saved = await persistComposer(composer, true);
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      if (inline) formData.set("inline", "true");
      const response = await fetch(`/api/mail-drafts/${encodeURIComponent(saved.id)}/attachments`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json() as { readonly attachments?: readonly ClientMailAttachment[]; readonly draft?: ClientMailDraft; readonly message?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.message || "Es können keine Anhänge hinzugefügt werden");
      setComposer(payload.draft);
      setMailDrafts((current) => [payload.draft!, ...current.filter((item) => item.id !== payload.draft!.id)]);
      setMailNotice(inline ? `Eingefügt in Text ${files.length} ein Bild` : `hinzugefügt ${files.length} eine Anlage`);
      return (payload.attachments ?? []).map((attachment) => ({ ...attachment, draftId: saved.id }));
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "Es können keine Anhänge hinzugefügt werden");
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
      if (!response.ok || !payload.draft) throw new Error(payload.message || "keine Anhänge können gelöscht werden");
      setComposer((current) => current?.id === payload.draft!.id
        ? { ...current, attachments: payload.draft!.attachments }
        : current);
      setMailDrafts((current) => current.map((item) => item.id === payload.draft!.id
        ? { ...item, attachments: payload.draft!.attachments }
        : item));
      setMailNotice("Anhang gelöscht");
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "keine Anhänge können gelöscht werden");
    } finally {
      setAttachmentBusy(false);
    }
  };

  const requestSendConfirmation = async () => {
    if (!composer || sendBusy || attachmentBusy) return;
    if (composer.to.length + composer.cc.length + composer.bcc.length === 0) {
      setMailNotice("Bitte füllen Sie mindestens einen Empfänger aus");
      return;
    }
    if (!composer.subject.trim()) {
      setMailNotice("Bitte füllen Sie das E-Mail-Thema aus");
      return;
    }
    try {
      const saved = await persistComposer(composer);
      setComposer(saved);
      setSendConfirmationKey(`mail:${crypto.randomUUID()}`);
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "Entwurf spare fehlgeschlagen und kann nicht für den Moment gesendet werden");
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
      if (!response.ok || !payload.result) throw new Error(payload.message || "E-Mail-Sendung fehlgeschlagen");
      setComposer(undefined);
      setSendConfirmationKey(undefined);
      await refreshMailDrafts();
      setMailNotice("E-Mail gesendet");
    } catch (error) {
      setSendConfirmationKey(undefined);
      await refreshMailDrafts().catch(() => undefined);
      setMailNotice(error instanceof Error ? error.message : "E-Mail gesendet fehlgeschlagen, Entwurf beibehalten");
    } finally {
      setSendBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setRemoteItems(null);
    setMailLoadError(undefined);
    setNextInboxCursor(undefined);
    setCorrespondenceSummary(undefined);
    setSelectedMessageIds(new Set());
    setSelectionAnchorId(undefined);
    setMailFilter("all");
    setSelectedId(initialMessageId ?? "");
    setMobileMailDetail(Boolean(initialMessageId));
    const inboxParams = new URLSearchParams({ limit: "50" });
    if (initialFolderId) inboxParams.set("folder", initialFolderId);
    if (initialCorrespondent) inboxParams.set("correspondent", initialCorrespondent);
    const inboxUrl = `/api/inbox?${inboxParams}`;
    void workspaceFetch(inboxUrl)
      .then(async (response) => {
        const payload = await response.json() as {
          readonly hasAccounts?: boolean;
          readonly message?: string;
          readonly nextCursor?: InboxPageCursor;
          readonly folder?: { readonly name: string; readonly role: string; readonly accountName: string };
          readonly correspondence?: MailCorrespondenceSummary;
          readonly items?: readonly InboxApiItem[];
        };
        if (!response.ok) throw new Error(payload.message || "Inbox request failed");
        return payload;
      })
      .then(async (result) => {
        if (cancelled) return;
        const mapped = mapInboxApiItems(result.items ?? []);
        setHasAccounts(Boolean(result.hasAccounts));
        setCorrespondenceSummary(result.correspondence);
        setMailboxLabel(result.correspondence
          ? `mit ${result.correspondence.name} Transaktionen`
          : result.folder ? `${result.folder.accountName} / ${mailFolderLabel(result.folder)}` : "Einheitlicher Posteingang");
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
            setMailNotice("Aufgabengebundene Mail-Threads");
          } else if (mapped[0]) {
            setSelectedId(mapped[0].id);
            setMailNotice("assoziierte Mail archiviert, gelöscht oder nicht synchronisiert");
          }
        } else setSelectedId(mapped[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMailLoadError(error instanceof Error ? error.message : "Posteingang kann nicht gelesen werden");
          setRemoteItems([]);
        }
      });
    return () => { cancelled = true; };
  }, [initialCorrespondent, initialFolderId, initialMessageId]);

  const refreshVisibleInbox = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50" });
    if (initialFolderId) params.set("folder", initialFolderId);
    if (initialCorrespondent) params.set("correspondent", initialCorrespondent);
    const response = await workspaceFetch(`/api/inbox?${params}`, {}, 0);
    const payload = await response.json() as {
      readonly hasAccounts?: boolean;
      readonly folder?: { readonly name: string; readonly role: string; readonly accountName: string };
      readonly correspondence?: MailCorrespondenceSummary;
      readonly items?: readonly InboxApiItem[];
      readonly message?: string;
    };
    if (!response.ok) throw new Error(payload.message || "Inbox kann nicht aktualisiert werden");
    const refreshed = mapInboxApiItems(payload.items ?? []);
    setHasAccounts(Boolean(payload.hasAccounts));
    setCorrespondenceSummary(payload.correspondence);
    setMailboxLabel(payload.correspondence
      ? `mit ${payload.correspondence.name} Transaktionen`
      : payload.folder ? `${payload.folder.accountName} / ${mailFolderLabel(payload.folder)}` : "Einheitlicher Posteingang");
    setMailLoadError(undefined);
    setRemoteItems((current) => mergeRefreshedInboxPage(current, refreshed));
  }, [initialCorrespondent, initialFolderId]);
  useVisiblePageRefresh(refreshVisibleInbox);
  useRealtimeRefresh(["mail", "relation"], refreshVisibleInbox);
  useEffect(() => {
    const refreshAfterSync = () => { void refreshVisibleInbox().catch(() => undefined); };
    window.addEventListener(MAIL_SYNCED_EVENT, refreshAfterSync);
    return () => window.removeEventListener(MAIL_SYNCED_EVENT, refreshAfterSync);
  }, [refreshVisibleInbox]);

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
      if (initialCorrespondent) params.set("correspondent", initialCorrespondent);
      const response = await workspaceFetch(`/api/inbox?${params}`, {}, 0);
      const payload = await response.json() as {
        readonly items?: readonly InboxApiItem[];
        readonly nextCursor?: InboxPageCursor;
        readonly message?: string;
      };
      if (!response.ok) throw new Error(payload.message || "E-Mail kann nicht weiter geladen werden");
      const additions = mapInboxApiItems(payload.items ?? []);
      setRemoteItems((current) => {
        const existing = new Set(current?.map((item) => item.id) ?? []);
        return [...(current ?? []), ...additions.filter((item) => !existing.has(item.id))];
      });
      setNextInboxCursor(payload.nextCursor);
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "E-Mail kann nicht weiter geladen werden");
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
        if (!response.ok || !result.messages?.length) throw new Error(result.message || "Mail-Threads können nicht gelesen werden");
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
          const result = await readApiJson<{
            readonly message?: string;
            readonly body?: { readonly text?: string; readonly html?: string; readonly snippet: string; readonly cached: boolean; readonly hasBlockedRemoteImages: boolean };
          }>(response, "E-Mail-Text kann nicht gelesen werden");
          if (!response.ok || !result.body) throw new Error(result.message || "E-Mail-Text kann nicht gelesen werden");
          return result.body;
        })
        .then((body) => {
          setBodies((current) => ({ ...current, [messageId]: { status: "ready", text: body.text, html: clampEmailBodyFontSizes(body.html), cached: body.cached, hasBlockedRemoteImages: body.hasBlockedRemoteImages } }));
          setRemoteItems((current) => current?.map((item) => item.id === messageId ? { ...item, preview: body.snippet } : item) ?? current);
        })
        .catch((error: unknown) => {
          setBodies((current) => ({ ...current, [messageId]: { status: "error", message: error instanceof Error ? error.message : "E-Mail-Text kann nicht gelesen werden" } }));
        });
    }
  }, [bodyRetry, expandedThreadMessages, hasAccounts, selectedId, threadMessages]);

  const refreshMessageBody = async (messageId: string) => {
    if (bodyRefreshBusyId) return;
    setBodyRefreshBusyId(messageId);
    setMailNotice(null);
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/body?refresh=1`, { cache: "no-store" });
      const result = await readApiJson<{
        readonly message?: string;
        readonly body?: {
          readonly text?: string;
          readonly html?: string;
          readonly snippet: string;
          readonly cached: boolean;
          readonly hasBlockedRemoteImages: boolean;
        };
      }>(response, "E-Mail-Text kann nicht wieder gelesen werden");
      if (!response.ok || !result.body) throw new Error(result.message || "E-Mail-Text kann nicht wieder gelesen werden");
      const body = result.body;
      setBodies((current) => ({
        ...current,
        [messageId]: {
          status: "ready",
          text: body.text,
          html: clampEmailBodyFontSizes(body.html),
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
      setMailNotice("aktualisierter lokaler Cache");
    } catch (error) {
      setMailNotice(`${error instanceof Error ? error.message : "E-Mail-Stelle kann nicht abgerufen werden"}; fortlaufende Anzeige der ursprünglichen Caches`);
    } finally {
      setBodyRefreshBusyId(undefined);
    }
  };

  const allItems = remoteItems ?? [];
  const items = allItems.filter((item) => {
    if (mailAccountFilter !== "all" && item.accountId !== mailAccountFilter) return false;
    if (mailFilter === "unread" && item.isRead) return false;
    if (mailFilter === "starred" && !item.isStarred) return false;
    if (mailFilter === "incoming" && item.direction !== "incoming") return false;
    if (mailFilter === "outgoing" && item.direction !== "outgoing") return false;
    if (mailFilter === "attachments" && item.attachments.length === 0) return false;
    const normalized = mailQuery.trim().toLocaleLowerCase();
    return !normalized || `${item.sender} ${item.senderAddress} ${item.correspondentName ?? ""} ${item.correspondentAddress ?? ""} ${item.subject} ${item.preview}`.toLocaleLowerCase().includes(normalized);
  });
  const dateGroups = groupMailByDate(items);
  useEffect(() => {
    if (items.length && !items.some((item) => item.id === selectedId)) setSelectedId(items[0]!.id);
  }, [items, selectedId]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const selectedSenderIsOwnAccount = Boolean(selected && mailAccounts.some((account) =>
    [account.emailAddress, ...(account.aliases ?? [])].some((address) =>
      address.trim().toLocaleLowerCase() === selected.senderAddress.trim().toLocaleLowerCase()
    )
  ));
  const selectedBatchItems = items.filter((item) => selectedMessageIds.has(item.id));
  const allVisibleSelected = items.length > 0 && selectedBatchItems.length === items.length;
  const someVisibleSelected = selectedBatchItems.length > 0 && !allVisibleSelected;
  useEffect(() => {
    const visibleIds = new Set(items.map((item) => item.id));
    setSelectedMessageIds((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);
  useEffect(() => {
    if (messageDetailRef.current) messageDetailRef.current.scrollTop = 0;
  }, [selected?.id]);
  useEffect(() => {
    if (!senderCardOpen || !selected?.senderAddress) return;
    if (selectedSenderIsOwnAccount) {
      setSenderCardSummary(undefined);
      setSenderCardLoading(false);
      return;
    }
    const normalizedAddress = selected.senderAddress.trim().toLocaleLowerCase();
    if (correspondenceSummary?.address.toLocaleLowerCase() === normalizedAddress) {
      setSenderCardSummary(correspondenceSummary);
      return;
    }
    let cancelled = false;
    setSenderCardLoading(true);
    setSenderCardSummary(undefined);
    const params = new URLSearchParams({ limit: "20", correspondent: normalizedAddress });
    void fetch(`/api/inbox?${params}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { readonly correspondence?: MailCorrespondenceSummary; readonly message?: string };
        if (!response.ok) throw new Error(payload.message || "Transaktionsstatistiken können nicht gelesen werden");
        return payload.correspondence;
      })
      .then((summary) => {
        if (!cancelled) setSenderCardSummary(summary);
      })
      .catch(() => {
        if (!cancelled) setSenderCardSummary(undefined);
      })
      .finally(() => {
        if (!cancelled) setSenderCardLoading(false);
      });
    return () => { cancelled = true; };
  }, [correspondenceSummary, selected?.senderAddress, selectedSenderIsOwnAccount, senderCardOpen]);

  const showSenderCard = () => {
    if (senderCardCloseTimerRef.current) window.clearTimeout(senderCardCloseTimerRef.current);
    setSenderCardOpen(true);
  };
  const scheduleSenderCardClose = () => {
    if (senderCardCloseTimerRef.current) window.clearTimeout(senderCardCloseTimerRef.current);
    senderCardCloseTimerRef.current = window.setTimeout(() => setSenderCardOpen(false), 140);
  };
  const openCorrespondence = (address: string, messageId?: string) => {
    const params = new URLSearchParams({ correspondent: address });
    if (messageId) params.set("message", messageId);
    router.push(`/inbox?${params}`);
  };
  const copyMailAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setMailNotice("Postfach-Adresse kopiert");
    } catch {
      setMailNotice("Postfachadresse kann nicht kopiert werden");
    }
  };
  const displayedThreadMessages = [...threadMessages].reverse();
  const selectedSenderDomain = selected?.senderAddress.split("@")[1]?.toLocaleLowerCase();
  const selectedSenderSharesAccountDomain = Boolean(selectedSenderDomain && mailAccounts.some((account) =>
    account.emailAddress.split("@")[1]?.toLocaleLowerCase() === selectedSenderDomain
  ));
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
  const composerSignatures = composer ? mailSignatures.filter((signature) => signature.accountId === composer.accountId) : [];
  const composerSignatureValue = composer?.signatureId && composer.signatureVariant
    ? `${composer.signatureId}:${composer.signatureVariant}`
    : "none";
  const composerSignatureOptions = [
    { value: "none", label: "keine Unterschrift" },
    ...composerSignatures.flatMap((signature) => [
      { value: `${signature.id}:full`, label: `${signature.name} . vollständig` },
      { value: `${signature.id}:short`, label: `${signature.name} . . . . . . . . . . .` },
    ]),
  ];
  const composerHasContent = Boolean(composer && mailDraftHasContent(composer));
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
    setMailNotice("Synchronisieren mit dem Postfachserver...");
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
          readonly alreadyRemoved?: boolean;
        };
      };
      if (!response.ok || !payload.result) throw new Error(payload.message || "Mail-Operation fehlgeschlagen");
      if (payload.result.removedFromInbox) {
        const remaining = (remoteItems ?? []).filter((item) => item.id !== message.id);
        setRemoteItems(remaining);
        setSelectedMessageIds((current) => {
          if (!current.has(message.id)) return current;
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
        if (selectedId === message.id) setSelectedId(remaining[0]?.id ?? "");
        setMailNotice(
          action === "delete"
            ? payload.result.alreadyRemoved
              ? "Mail vom Server entfernt und lokale Datensätze gereinigt"
              : "E-Mail auf gelöschte E-Mail verschoben"
            : "E-Mail archiviert",
        );
      } else {
        setRemoteItems((current) => current?.map((item) => item.id === message.id ? {
          ...item,
          isRead: payload.result?.isRead ?? item.isRead,
          isStarred: payload.result?.isStarred ?? item.isStarred,
        } : item) ?? current);
        setMailNotice(action === "mark-read" || action === "mark-unread" ? "aktualisierter Lesezustand" : "aktualisierter Sternchenstatus");
      }
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "Mail-Operation fehlgeschlagen");
    } finally {
      setMessageActionBusy(false);
    }
  };

  const toggleMessageSelection = (message: InboxDisplayItem, event: ReactMouseEvent) => {
    const targetIndex = items.findIndex((item) => item.id === message.id);
    if (event.shiftKey && selectionAnchorId) {
      const anchorIndex = items.findIndex((item) => item.id === selectionAnchorId);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        setSelectedMessageIds((current) => {
          const next = new Set(current);
          for (let index = start; index <= end; index += 1) next.add(items[index]!.id);
          return next;
        });
        return;
      }
    }
    setSelectionAnchorId(message.id);
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
      return next;
    });
  };

  const handleMessageOpen = (message: InboxDisplayItem, event: ReactMouseEvent) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleMessageSelection(message, event);
      return;
    }
    setSelectedMessageIds(new Set());
    setSelectionAnchorId(message.id);
    openMessage(message);
  };

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedMessageIds(new Set());
      setSelectionAnchorId(undefined);
      return;
    }
    setSelectedMessageIds(new Set(items.map((item) => item.id)));
    setSelectionAnchorId(items[0]?.id);
  };

  const runBatchMessageAction = async (action: MailUiAction) => {
    const targets = items.filter((item) => selectedMessageIds.has(item.id));
    if (!hasAccounts || batchActionBusy || targets.length === 0) return;
    setBatchDeletePending(false);
    setBatchActionBusy(action);
    setMailNotice(`Verarbeitung ${targets.length} E-Mail...`);
    try {
      const response = await fetch("/api/messages/actions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, messageIds: targets.map((item) => item.id) }),
      });
      const payload = await response.json() as {
        readonly message?: string;
        readonly results?: readonly {
          readonly messageId: string;
          readonly isRead?: boolean;
          readonly isStarred?: boolean;
          readonly removedFromInbox: boolean;
          readonly alreadyRemoved?: boolean;
        }[];
        readonly failures?: readonly { readonly messageId: string; readonly message: string }[];
      };
      if (!payload.results || !payload.failures) throw new Error(payload.message || "Bulk-Mail-Operation fehlgeschlagen");
      const results = new Map(payload.results.map((result) => [result.messageId, result]));
      const removedIds = new Set(payload.results.filter((result) => result.removedFromInbox).map((result) => result.messageId));
      setRemoteItems((current) => current?.flatMap((item) => {
        if (removedIds.has(item.id)) return [];
        const result = results.get(item.id);
        return [{
          ...item,
          isRead: result?.isRead ?? item.isRead,
          isStarred: result?.isStarred ?? item.isStarred,
        }];
      }) ?? current);
      const failedIds = new Set(payload.failures.map((failure) => failure.messageId));
      setSelectedMessageIds(failedIds);
      if (removedIds.has(selectedId)) {
        const remaining = items.filter((item) => !removedIds.has(item.id));
        setSelectedId(remaining[0]?.id ?? "");
      }
      if (payload.failures.length > 0) {
        setMailNotice(`${payload.results.length} erfolgreiche Versiegelung,${payload.failures.length} Siegel fehlgeschlagen; fehlgeschlagene Mail bleibt ausgewählt`);
      } else {
        const alreadyRemovedCount = payload.results.filter((result) => result.alreadyRemoved).length;
        if (action === "delete" && alreadyRemovedCount > 0) {
          setMailNotice(
            alreadyRemovedCount === payload.results.length
              ? `gereinigt ${alreadyRemovedCount} Verkapselung von E-Mail-Datensätzen, die auf dem Server nicht existieren`
              : `gestrichen ${payload.results.length} eine E-Mail, davon ${alreadyRemovedCount} Siegel reinigt nur lokale Aufzeichnungen`,
          );
          return;
        }
        const label = action === "delete" ? "In gelöschte Mail verschieben"
          : action === "archive" ? "Archiv"
          : action === "mark-read" ? "als gelesen markiert"
          : action === "mark-unread" ? "als ungelesen markiert"
          : action === "star" ? "Ein Sternchen hinzufügen" : "Entkopplung von Sternchen";
        setMailNotice(`${payload.results.length} E-Mail(s) ${label}`);
      }
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "Bulk-Mail-Operation fehlgeschlagen");
    } finally {
      setBatchActionBusy(undefined);
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
      if (composer || sendConfirmationKey || contextMenu || messageActionBusy || batchActionBusy || batchDeletePending || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) return;
      if (target && target !== document.body && !target.closest(".message-list")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "a") {
        event.preventDefault();
        toggleSelectAll();
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      if (event.key === "Escape" && selectedMessageIds.size > 0) {
        event.preventDefault();
        setSelectedMessageIds(new Set());
        setSelectionAnchorId(undefined);
        return;
      }
      if (!selected || items.length === 0) return;

      const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selected.id));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.min(items.length - 1, Math.max(0, selectedIndex + offset));
        const nextItem = items[nextIndex]!;
        setSelectedId(nextItem.id);
        if (event.shiftKey) {
          const anchorId = selectionAnchorId ?? selected.id;
          const anchorIndex = Math.max(0, items.findIndex((item) => item.id === anchorId));
          const [start, end] = anchorIndex < nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
          setSelectionAnchorId(anchorId);
          setSelectedMessageIds(new Set(items.slice(start, end + 1).map((item) => item.id)));
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openMessage(selected);
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        if (selectedMessageIds.size > 0) setBatchDeletePending(true);
        else void runMessageAction(selected, "delete");
      }
    };

    window.addEventListener("keydown", handleInboxKeyboard);
    return () => window.removeEventListener("keydown", handleInboxKeyboard);
  }, [batchActionBusy, batchDeletePending, composer, contextMenu, hasAccounts, items, messageActionBusy, selected, selectedMessageIds, selectionAnchorId, sendConfirmationKey]);

  const createTaskFromMessage = async (message: InboxDisplayItem) => {
    if (messageActionBusy) return;
    closeContextMenu();
    setMessageActionBusy(true);
    setMailNotice("die Erstellung von zugehörigen Aufgaben...");
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: message.subject,
          notes: `von ${message.sender} <${message.senderAddress}>`,
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
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Aufgabe kann nicht erstellt werden");
      setMailRelatedVersion((current) => current + 1);
      setMailNotice("erstellte Aufgabe, die in Aufgaben sortiert werden kann. Infox");
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "Aufgabe kann nicht erstellt werden");
    } finally {
      setMessageActionBusy(false);
    }
  };

  const runMailAi = async (message: InboxDisplayItem, action: MailAiAction) => {
    if (mailAiBusy) return;
    onOpenAssistant?.();
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
      if (!response.ok || !payload.result) throw new Error(payload.message || "KI-Mail-Verarbeitung fehlgeschlagen");
      if (action === "draft-reply") {
        if (isInlineReplyComposer && composer) {
          const generatedContent = encodeNoteContent(decodeNoteContent(payload.result.text));
          const signature = mailSignatures.find((item) => item.id === composer.signatureId);
          const bodyContent = signature && composer.signatureVariant
            ? replaceMailSignatureContent(generatedContent, {
                id: signature.id,
                variant: composer.signatureVariant,
                text: composer.signatureVariant === "full" ? signature.fullText : signature.shortText,
              })
            : generatedContent;
          setComposer((current) => current?.id === composer.id ? {
            ...current,
            bodyContent,
            textBody: noteContentToPlainText(bodyContent),
          } : current);
          setMailAiResult(undefined);
          setMailNotice(replyInstruction ? "AI hat den Text der Antwort wie von Ihnen angefordert ersetzt" : "KI hat den Text der Antwort generiert");
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".inline-reply-composer [contenteditable='true']")?.focus());
          return;
        }
        if (replyTarget) {
          await openComposer(replyTarget, "reply", payload.result.text);
          setMailAiResult(undefined);
          setMailNotice("KI hat den Text der Antwort generiert, der vor dem Senden noch modifiziert werden kann");
          return;
        }
      }
      setMailAiResult({ messageId: message.id, ...payload.result });
    } catch (error) {
      setMailNotice(error instanceof Error ? error.message : "KI-Mail-Verarbeitung fehlgeschlagen");
    } finally {
      setMailAiBusy(undefined);
    }
  };

  useEffect(() => {
    publish({
      kind: "mail",
      hasAccounts,
      loading: remoteItems === null && !mailLoadError,
      message: selected ? {
        id: selected.id,
        subject: selected.subject,
        sender: selected.sender,
        senderAddress: selected.senderAddress,
        accountName: selected.accountName,
        receivedAt: selected.receivedAt,
        preview: selected.preview,
      } : undefined,
      aiBusy: mailAiBusy,
      actionBusy: messageActionBusy,
      result: mailAiResult?.messageId === selected?.id ? mailAiResult : undefined,
      notice: mailNotice ?? undefined,
    });
  }, [
    hasAccounts,
    mailAiBusy,
    mailAiResult,
    mailLoadError,
    mailNotice,
    messageActionBusy,
    publish,
    remoteItems,
    selected?.accountName,
    selected?.id,
    selected?.preview,
    selected?.receivedAt,
    selected?.sender,
    selected?.senderAddress,
    selected?.subject,
  ]);

  useEffect(() => () => publish(undefined), [publish]);

  useEffect(() => registerCommandHandler((command) => {
    if (command.type === "mail.clear-result") {
      setMailAiResult(undefined);
      return;
    }
    if (!selected) return;
    if (command.type === "mail.run-ai") {
      void runMailAi(selected, command.action);
      return;
    }
    if (command.type === "mail.create-task") void createTaskFromMessage(selected);
  }));

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
    <div
      className={`mail-layout panel ${mobileMailDetail ? "mobile-detail-open" : ""}`}
      style={mailListWidth === undefined
        ? undefined
        : { "--mail-list-width": `${mailListWidth}px` } as CSSProperties}
    >
      <section className="message-list" aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Control+A Meta+A Enter Delete Escape">
        {correspondenceSummary && (
          <div className="correspondence-header">
            <button aria-label="gibt den Posteingang zurück" title="gibt den Posteingang zurück" onClick={() => router.push("/inbox")}><ChevronLeft size={18} /></button>
            <span className="correspondence-avatar" style={{ background: mailSenderAvatarColor(correspondenceSummary.address, correspondenceSummary.name) }}>
              {correspondenceSummary.name.slice(0, 1).toLocaleUpperCase()}
            </span>
            <div>
              <strong>{correspondenceSummary.name}</strong>
              <small>{correspondenceSummary.address}</small>
              <em>{correspondenceSummary.totalCount} Sie decken die Transaktionen ab . {correspondenceSummary.unreadCount} Abdeckung ungelesen</em>
            </div>
            <button aria-label={`Hierher ${correspondenceSummary.name} E-Mail schreiben`} title="E-Mail schreiben" onClick={() => void openComposer(undefined, "reply", "", { address: correspondenceSummary.address })}><Pencil size={16} /></button>
          </div>
        )}
        <div className="list-toolbar">
          <div className="mail-list-summary">
            <label className="mail-select-all" title={allVisibleSelected ? "Alle auswählen" : "Wählen Sie die aktuelle Liste"}>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected}
                aria-label={allVisibleSelected ? "Wählen Sie die aktuelle Liste aus" : "Wählen Sie die aktuelle Liste"}
                onChange={toggleSelectAll}
              />
            </label>
            <AppSelect
              ariaLabel="Filtern von Mailbox-Konten"
              className="mail-account-select"
              size="compact"
              value={mailAccountFilter}
              onValueChange={setMailAccountFilter}
              options={[
                { value: "all", label: "alle Konten" },
                ...Array.from(new Map(allItems.map((item) => [item.accountId, item])).values())
                  .map((item) => ({ value: item.accountId, label: item.accountName })),
              ]}
            />
            <span className="mail-list-title">{selectedBatchItems.length > 0 ? `ausgewählt ${selectedBatchItems.length} Versiegelung` : mailboxLabel}</span>
            {selectedBatchItems.length === 0 && <span className="mail-list-count" aria-label={`${items.length} E-Mails`}>{items.length}</span>}
          </div>
          <div className="mail-list-actions">
            {selectedBatchItems.length > 0 ? <>
              <button disabled={Boolean(batchActionBusy)} aria-label="Batch-Archiv" title="Archiv" onClick={() => void runBatchMessageAction("archive")}>{batchActionBusy === "archive" ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}</button>
              <button
                disabled={Boolean(batchActionBusy)}
                aria-label={selectedBatchItems.some((item) => !item.isRead) ? "Los als gelesen markiert" : "als ungelesen markierte Partie"}
                title={selectedBatchItems.some((item) => !item.isRead) ? "als gelesen markiert" : "als ungelesen markiert"}
                onClick={() => void runBatchMessageAction(selectedBatchItems.some((item) => !item.isRead) ? "mark-read" : "mark-unread")}
              >{batchActionBusy === "mark-read" || batchActionBusy === "mark-unread" ? <LoaderCircle className="spin" size={15} /> : <MailOpen size={15} />}</button>
              <button
                disabled={Boolean(batchActionBusy)}
                aria-label={selectedBatchItems.some((item) => !item.isStarred) ? "Batch Sterne hinzufügen" : "Losdecal"}
                title={selectedBatchItems.some((item) => !item.isStarred) ? "Ein Sternchen hinzufügen" : "Entkopplung von Sternchen"}
                onClick={() => void runBatchMessageAction(selectedBatchItems.some((item) => !item.isStarred) ? "star" : "unstar")}
              >{batchActionBusy === "star" || batchActionBusy === "unstar" ? <LoaderCircle className="spin" size={15} /> : <Star size={15} />}</button>
              <button className="batch-danger" disabled={Boolean(batchActionBusy)} aria-label="Los löschen" title="Löschen" onClick={() => setBatchDeletePending(true)}><Trash2 size={15} /></button>
              <button disabled={Boolean(batchActionBusy)} aria-label="Auswahl löschen" title="Auswahl löschen" onClick={() => { setSelectedMessageIds(new Set()); setSelectionAnchorId(undefined); }}><X size={15} /></button>
            </> : <>
            {mailDrafts.length > 0 && (
              <button className="mail-drafts-button" onClick={() => { setComposer(mailDrafts[0]); setComposerSaveState("saved"); }}>
                Entwürfe {mailDrafts.length}
              </button>
            )}
            <button aria-label="Schreiben von E-Mails" title="Schreiben von E-Mails" onClick={() => void openComposer()}><Pencil size={15} /></button>
            </>}
          </div>
        </div>
        <div className="mail-filter-bar">
          <div className="mail-filter-tabs">{(initialCorrespondent
            ? (["all", "incoming", "outgoing", "attachments"] as const)
            : (["all", "unread", "starred"] as const)
          ).map((filter) => <button className={mailFilter === filter ? "active" : ""} key={filter} onClick={() => setMailFilter(filter)}>{filter === "all" ? "Alle" : filter === "unread" ? "Ungelesen" : filter === "starred" ? "Sternchen" : filter === "incoming" ? "Eintreffen" : filter === "outgoing" ? "Gesendet" : "Befestigung"}</button>)}</div>
          <label className="mail-filter-search"><Search size={14} /><input aria-label="Suche nach aktuellen Mails" value={mailQuery} onChange={(event) => setMailQuery(event.target.value)} placeholder="E-Mail filtern..." /></label>
        </div>
        <div className="message-list-scroll">
          {remoteItems === null && <div className="mail-empty"><LoaderCircle className="spin" size={18} />lokale E-Mail lesen...</div>}
          {remoteItems !== null && mailLoadError && <div className="mail-empty">{mailLoadError}</div>}
          {remoteItems !== null && !mailLoadError && !hasAccounts && <div className="mail-empty">Verbinden Sie sich nicht mit dem Postfach. Gehen Sie zu den Einstellungen, um ein echtes Postfachkonto hinzuzufügen.</div>}
          {remoteItems !== null && !mailLoadError && hasAccounts && items.length === 0 && <div className="mail-empty">{initialCorrespondent ? "Es wurde keine eingehende oder ausgehende Mail gefunden, die die aktuellen Filterbedingungen erfüllt." : "Der aktuelle Ordner hat keine synchronisierte Mail."}</div>}
          {dateGroups.map((group) => {
            const collapsed = collapsedDateGroups.has(group.id);
            return <section className={`mail-date-group ${collapsed ? "collapsed" : ""}`} aria-label={`${group.label}, ${group.items.length} E-Mails`} key={group.id}>
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
                const batchSelected = selectedMessageIds.has(message.id);
                const listSender = initialCorrespondent
                  ? message.direction === "outgoing"
                    ? `Ich... ${message.correspondentName || correspondenceSummary?.name || initialCorrespondent}`
                    : message.correspondentName || message.sender
                  : message.sender;
                return (
                  <div
                  className={`message-item ${message.id === selected?.id ? "active" : ""} ${batchSelected ? "batch-selected" : ""} ${message.isRead ? "read" : ""} ${draggedMessageId === message.id ? "dragging" : ""}`}
                  key={message.id}
                  draggable={!messageActionBusy}
                  title="Ziehen Sie zum linken Ordner zum Verschieben"
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
                  <label className="message-select" draggable={false} title={batchSelected ? "Auswählen" : "Mail auswählen"} onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={batchSelected}
                      aria-label={`${batchSelected ? "Auswählen" : "Auswahl"}: ${message.subject}`}
                      onChange={() => undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleMessageSelection(message, event);
                      }}
                    />
                  </label>
                  <button
                    className="message-open"
                    onClick={(event) => handleMessageOpen(message, event)}
                    onKeyDown={(event) => {
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                      event.preventDefault();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      openMessageContextMenu(message, bounds.right - 12, bounds.top + 28, event.currentTarget);
                    }}
                  >
                    <span><strong>{listSender}</strong><span className="message-meta">{message.threadCount > 1 && <em className="thread-count">{message.threadCount} Versiegelung</em>}{digitallySigned && <span className="smime-signature-badge" role="img" aria-label="digitale Signatur E-Mail" title="digitale Signatur E-Mail"><Award size={13} aria-hidden="true" /></span>}{message.isStarred && <Star size={12} fill="currentColor" aria-label="bereits markierte Sternchen" />}<time>{message.time}</time></span></span>
                    <b>{message.subject}</b><small>{message.preview}</small>
                  </button>
                  <button
                    className="message-menu-trigger"
                    draggable={false}
                    aria-label={`mehr E-Mail-Operationen:${message.subject}`}
                    aria-haspopup="menu"
                    aria-expanded={contextMenu?.messageId === message.id}
                    title="mehr E-Mail-Operationen"
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
            {mailPageLoading ? <><LoaderCircle className="spin" size={14} />Laden...</> : "Mehr E-Mail laden"}
          </button>}
        </div>
      </section>
      <MailPaneResizeHandle width={mailListWidth} onChange={setMailListWidth} />
      {selected ? <article className="message-detail" ref={messageDetailRef}>
        <header>
          <button className="mobile-detail-back" aria-label="gibt die Mailingliste zurück" onClick={() => setMobileMailDetail(false)}><ChevronLeft size={20} /></button>
          <div className="sender-card-anchor" onMouseEnter={showSenderCard} onMouseLeave={scheduleSenderCardClose}>
            <button
              className="sender-avatar"
              aria-label={`Informationen zum Absender anzeigen:${selected.sender}`}
              aria-expanded={senderCardOpen}
              onFocus={showSenderCard}
              onBlur={scheduleSenderCardClose}
              style={{ background: mailSenderAvatarColor(selected.senderAddress, selected.sender) }}
            >{selected.sender.slice(0, 1).toLocaleUpperCase()}</button>
            {senderCardOpen && (
              <section className="sender-card" aria-label={`${selected.sender} Kontaktinformationen`} onFocus={showSenderCard} onBlur={scheduleSenderCardClose}>
                <header>
                  <span className="sender-card-avatar" style={{ background: mailSenderAvatarColor(selected.senderAddress, selected.sender) }}>{selected.sender.slice(0, 1).toLocaleUpperCase()}</span>
                  <div><strong>{selected.sender}</strong><small>{selected.senderAddress}</small></div>
                  {selectedSenderIsOwnAccount ? <em>Eigenes Konto</em> : selectedSenderSharesAccountDomain && <em>Gleiche Domain</em>}
                </header>
                {!selectedSenderIsOwnAccount && <div className="sender-card-meta">
                  <span><b>{senderCardSummary?.totalCount ?? (senderCardLoading ? "…" : "0")}</b> E-Mails</span>
                  <span><b>{senderCardSummary?.unreadCount ?? (senderCardLoading ? "…" : "0")}</b> ungelesen</span>
                  <span><b>{senderCardSummary?.lastContactAt ? formatMailTime(senderCardSummary.lastContactAt) : "—"}</b> letzter Kontakt</span>
                </div>}
                {selectedSenderDomain && <p>{selectedSenderDomain}</p>}
                <footer>
                  <button title="E-Mail schreiben" onClick={() => void openComposer(undefined, "reply", "", { address: selected.senderAddress, accountId: selected.accountId })}><Pencil size={15} />E-Mail schreiben</button>
                  <button disabled={selectedSenderIsOwnAccount} title={selectedSenderIsOwnAccount ? "Dies ist das aktuelle Postfachkonto" : "Korrespondenz anzeigen"} onClick={() => openCorrespondence(selected.senderAddress, selected.id)}><MailOpen size={15} />Korrespondenz anzeigen</button>
                  <button title="Mailbox-Adressen kopieren" onClick={() => void copyMailAddress(selected.senderAddress)}><Copy size={15} /></button>
                  <button title="Aufgaben aus der Mail erstellen" onClick={() => void createTaskFromMessage(selected)}><CheckSquare2 size={15} /></button>
                </footer>
              </section>
            )}
          </div>
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
          ><Pencil size={15} />Antwort</button>
          <button className="secondary-button" disabled={!hasAccounts} onClick={() => void openComposer(selected, "forward")}><Send size={15} />Weiterleitung</button>
          <button className="secondary-button danger-button" disabled={!hasAccounts || messageActionBusy} onClick={() => void runMessageAction(selected, "delete")}><Trash2 size={15} />Löschen</button>
          <button className="secondary-button" disabled={messageActionBusy} onClick={() => void createTaskFromMessage(selected)}><CheckCircle2 size={15} />Aufgabe erstellen</button>
          <button className="ghost-button" disabled={Boolean(mailAiBusy)} onClick={() => void runMailAi(selected, "summarize")}>{mailAiBusy === "summarize" ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}Zusammenfassung</button>
          <button className="ghost-button" disabled={Boolean(mailAiBusy)} onClick={() => void runMailAi(selected, "extract-actions")}>{mailAiBusy === "extract-actions" ? <LoaderCircle className="spin" size={15} /> : <ListChecks size={15} />}Aktionspunkte</button>
          <button className="ghost-button" disabled={Boolean(mailAiBusy)} title={isInlineReplyComposer && composer?.textBody.trim() ? "gemäß den Anforderungen im aktuellen Texttext erstellt und durch eine vollständige Antwort ersetzt" : "Erzeugt den Text einer Antwort basierend auf dem Inhalt der Mail"} onClick={() => void runMailAi(selected, "draft-reply")}>{mailAiBusy === "draft-reply" ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}Entwurf einer Antwort</button>
          <button className="ghost-button message-detail-more" aria-label="mehr E-Mail-Operationen" title="mehr E-Mail-Operationen" aria-haspopup="menu" aria-expanded={contextMenu?.messageId === selected.id} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); openMessageContextMenu(selected, bounds.right, bounds.bottom + 4, event.currentTarget); }}><MoreHorizontal size={16} /></button>
        </div>
        {isInlineReplyComposer && composer && (
          <section className="inline-reply-composer" aria-labelledby="inline-reply-title" data-testid="inline-reply-composer">
            <header>
              <div id="inline-reply-title">
                <button
                  className={`inline-copy-toggle ${inlineCopyFieldsOpen ? "open" : ""}`}
                  aria-label={inlineCopyFieldsOpen ? "Start, Kopie-Übernahme und Pass-Through" : "Kopieren und Passwording"}
                  aria-expanded={inlineCopyFieldsOpen}
                  title={inlineCopyFieldsOpen ? "Start, Kopie-Übernahme und Pass-Through" : "eine Kopie oder ein Geheimnis hinzufügen"}
                  onClick={() => setInlineCopyFieldsOpen((open) => !open)}
                ><ChevronDown size={15} /></button>
                <span>Antwort auf</span><strong>{inlineReplyRecipient}</strong>
              </div>
              <button className="composer-icon-button" aria-label={composerHasContent ? "schließen und speichern Sie Entwürfe von Antworten" : "Schließt die Leerantwort"} title={composerHasContent ? "Entwürfe schließen und speichern" : "Schließen"} disabled={sendBusy || attachmentBusy || composerSaveState === "saving"} onClick={() => void closeComposer()}><X size={18} /></button>
            </header>
            {inlineCopyFieldsOpen && <div className="inline-copy-fields">
              <label><span>Kopieren</span><input aria-label="Kopieren" value={composer.cc.join(", ")} disabled={sendBusy || attachmentBusy} placeholder="name@example.com" onChange={(event) => setComposer({ ...composer, cc: splitMailAddresses(event.target.value) })} /></label>
              <label><span>Geheimnis</span><input aria-label="Geheimnis" value={composer.bcc.join(", ")} disabled={sendBusy || attachmentBusy} placeholder="name@example.com" onChange={(event) => setComposer({ ...composer, bcc: splitMailAddresses(event.target.value) })} /></label>
            </div>}
            <div className="inline-reply-body">
              {composerFileAttachments.length > 0 && (
                <div className="mail-attachment-list" aria-label="E-Mail-Anhänger">
                  {composerFileAttachments.map((attachment) => (
                    <div key={attachment.id}>
                      <Paperclip size={14} />
                      <span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.sizeBytes)}</small></span>
                      <button aria-label={`Anhänge löschen:${attachment.filename}`} disabled={attachmentBusy || sendBusy} onClick={() => void removeComposerAttachment(attachment.id)}><X size={14} /></button>
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
                  url: `/api/mail-drafts/${encodeURIComponent(attachment.draftId ?? composer.id)}/attachments/${encodeURIComponent(attachment.id)}`,
                }))}
                onChange={(bodyContent) => setComposer((current) => current ? {
                  ...current,
                  bodyContent,
                  textBody: noteContentToPlainText(bodyContent),
                } : current)}
              />
              {composer.errorMessage && <div className="composer-error"><AlertCircle size={14} />Zuletzt gesendet fehlgeschlagen:{composer.errorMessage}</div>}
            </div>
            <footer>
              <div className="inline-reply-secondary">
                <input
                  ref={attachmentInputRef}
                  className="mail-attachment-input"
                  type="file"
                  multiple
                  aria-label="Auswahl von E-Mail-Anhängern"
                  onChange={(event) => void uploadComposerAttachments(Array.from(event.target.files ?? []))}
                />
                <button className="composer-attach" disabled={sendBusy || attachmentBusy || composerSaveState === "saving" || composer.attachments.length >= 10} onClick={() => attachmentInputRef.current?.click()}>
                  {attachmentBusy ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}Anhänge hinzufügen
                </button>
                {composerSignatures.length > 0 && <AppSelect
                  ariaLabel="Unterschrift antworten"
                  className="composer-signature-select"
                  size="compact"
                  value={composerSignatureValue}
                  disabled={sendBusy || attachmentBusy}
                  onValueChange={applyComposerSignature}
                  options={composerSignatureOptions}
                />}
                <span className={`composer-save-state ${composerSaveState}`}>
                  {composerSaveLabel(composerSaveState, true)}
                </span>
              </div>
              <div>
                <button className="secondary-button" disabled={sendBusy || attachmentBusy} onClick={() => void closeComposer()}>Abbrechen</button>
                <button className="primary-button" disabled={sendBusy || attachmentBusy || composerSaveState === "saving"} onClick={() => void requestSendConfirmation()}><Send size={15} />Senden</button>
              </div>
            </footer>
          </section>
        )}
        <div className="message-related-content"><RelatedContentPanel kind="mail" entityId={selected.id} refreshKey={mailRelatedVersion} hideWhenEmpty excludeRelations={["project-item"]} /></div>
        <div className="message-body">
          {hasAccounts && threadLoading && <div className="body-status"><LoaderCircle className="spin" size={18} />Organisation von Mail Threads...</div>}
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
                  <span className="thread-message-summary"><strong>{threadMessage.senderName}</strong><small>{threadMessage.folderRole === "sent" ? "Gesendet" : `Senden ${threadMessage.to.map((item) => item.name || item.address).join(", ") || "I. ENTWICKLUNG DER RECHTSVORSCHRIFTEN"}`}</small>{!expanded && <em>{threadMessage.snippet || "der Körper wird auf dem Rollout gelesen"}</em>}</span>
                  <span className="thread-message-meta">{digitallySigned && <span className="smime-signature-badge" role="img" aria-label="digitale Signatur E-Mail" title="digitale Signatur E-Mail"><Award size={13} aria-hidden="true" /></span>}{threadMessage.isStarred && <Star size={12} fill="currentColor" />}{body?.status === "ready" && <button className="thread-refresh-button" aria-label="E-Mail-Text vom Server abrufen" title="Abrufen vom Server" disabled={Boolean(bodyRefreshBusyId)} onClick={(event) => { event.stopPropagation(); void refreshMessageBody(threadMessage.id); }}>{bodyRefreshBusyId === threadMessage.id ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}</button>}{body?.status === "ready" && <span className="thread-cache-state"><ShieldCheck size={12} />{body.cached ? "Lokaler Cache" : "sicher gelesen und zwischengespeichert"}</span>}<time>{formatMailTime(threadMessage.receivedAt)}</time><ChevronDown size={15} /></span>
                </div>
                {expanded && <div className="thread-message-content">
                  {(!body || body.status === "loading") && <div className="body-status" data-testid="mail-body-loading"><LoaderCircle className="spin" size={17} />Text sicher lesen...</div>}
                  {body?.status === "error" && <div className="body-error" data-testid="mail-body-error"><p>{body.message}</p><button className="secondary-button" onClick={() => setBodyRetry((value) => value + 1)}>Erneut versuchen</button></div>}
                  {body?.status === "ready" && <div data-testid={index === 0 ? "mail-body-content" : undefined}>
                    {body.hasBlockedRemoteImages && !remoteImagesAllowed.has(threadMessage.id) && <div className="body-security-bar"><button className="ghost-button show-mail-images" onClick={() => setRemoteImagesAllowed((current) => new Set([...current, threadMessage.id]))}><ImageIcon size={14} />Bilder anzeigen</button></div>}
                    {html ? <div className="mail-body-html" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="mail-body-text">{body.text || "(E-Mail-Stelle leer)"}</div>}
                  </div>}
                  {visibleAttachments.length > 0 && <section className="incoming-attachments" aria-label="E-Mail-Anhänger"><header><Paperclip size={14} /><strong>Befestigung</strong><span>{visibleAttachments.length}</span></header><div>{threadMessage.attachments.map((attachment, attachmentIndex) => attachment.inline || isSmimeSignatureAttachment(attachment) ? null : <a href={`/api/messages/${encodeURIComponent(threadMessage.id)}/attachments/${attachmentIndex}`} key={`${attachment.filename}:${attachmentIndex}`}><FileText size={16} /><span><strong>{attachment.filename}</strong><small>{attachment.contentType} · {formatFileSize(attachment.sizeBytes)}</small></span><em>herunterladen</em></a>)}</div></section>}
                </div>}
              </section>;
            })}
          </div>}
        </div>
      </article> : <article className="message-detail empty-detail" ref={messageDetailRef}><Mail size={30} /><p>Wählen Sie eine E-Mail, um Inhalte anzuzeigen</p></article>}
    </div>
    {contextMenu && contextMessage && (
      <ContextMenu
        anchor={{ x: contextMenu.x, y: contextMenu.y }}
        ariaLabel={`E-Mail-Betrieb:${contextMessage.subject}`}
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
          <header><div><h2 id="mail-project-dialog-title">Link zum Projekt</h2></div><button aria-label="Schließen" onClick={() => setMailProjectTargetId(undefined)}><X size={18} /></button></header>
          <p className="mail-project-dialog-subject">{mailProjectTarget.subject}</p>
          <ProjectAssociationControl kind="mail" entityId={mailProjectTarget.id} onChanged={() => {
            setMailRelatedVersion((current) => current + 1);
            setMailProjectTargetId(undefined);
            setMailNotice("aktualisierte E-Mail-Projekt-Assoziation");
          }} />
        </section>
      </div>
    )}
    {composer && !isInlineReplyComposer && (
      <div className="mail-composer-backdrop" data-testid="mail-composer-backdrop">
        <section className="mail-composer" role="dialog" aria-modal="true" aria-labelledby="mail-composer-title" data-testid="mail-composer">
          <header>
            <div>
              <h2 id="mail-composer-title">{composer.replyToMessageId ? "Auf E-Mail antworten" : "Schreiben von E-Mails"}</h2>
              <span className={`composer-save-state ${composerSaveState}`}>
                {composerSaveLabel(composerSaveState)}
              </span>
            </div>
            <button className="composer-icon-button" aria-label={composerHasContent ? "Entwürfe schließen und speichern" : "Leere E-Mail schließen"} title={composerHasContent ? "Entwürfe schließen und speichern" : "Schließen"} disabled={sendBusy || attachmentBusy || composerSaveState === "saving"} onClick={() => void closeComposer()}><X size={18} /></button>
          </header>
          <div className="mail-composer-fields">
            <label>
              <span>Von</span>
              <AppSelect
                ariaLabel="Konto des Abgangskontos"
                value={composer.accountId}
                disabled={Boolean(composer.replyToMessageId) || sendBusy || attachmentBusy}
                variant="ghost"
                onValueChange={changeComposerAccount}
                options={mailAccounts.map((account) => ({
                  value: account.id,
                  label: `${account.displayName} <${account.emailAddress}>`,
                }))}
              />
            </label>
            <label>
              <span>Empfänger</span>
              <input aria-label="Empfänger" value={composer.to.join(", ")} disabled={sendBusy || attachmentBusy} placeholder="name@example.com" onChange={(event) => setComposer({ ...composer, to: splitMailAddresses(event.target.value) })} />
            </label>
            <details className="composer-copy-fields" open={composer.cc.length > 0 || composer.bcc.length > 0}>
              <summary>Kopie/Geheimnis</summary>
              <label><span>Kopieren</span><input aria-label="Kopieren" value={composer.cc.join(", ")} disabled={sendBusy || attachmentBusy} onChange={(event) => setComposer({ ...composer, cc: splitMailAddresses(event.target.value) })} /></label>
              <label><span>Geheimnis</span><input aria-label="Geheimnis" value={composer.bcc.join(", ")} disabled={sendBusy || attachmentBusy} onChange={(event) => setComposer({ ...composer, bcc: splitMailAddresses(event.target.value) })} /></label>
            </details>
            <label>
              <span>Thema</span>
              <input aria-label="E-Mail-Design" value={composer.subject} disabled={sendBusy || attachmentBusy} placeholder="E-Mail-Design" onChange={(event) => setComposer({ ...composer, subject: event.target.value })} />
            </label>
            {composerFileAttachments.length > 0 && (
              <div className="mail-attachment-list" aria-label="E-Mail-Anhänger">
                {composerFileAttachments.map((attachment) => (
                  <div key={attachment.id}>
                    <Paperclip size={14} />
                    <span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.sizeBytes)}</small></span>
                    <button aria-label={`Anhänge löschen:${attachment.filename}`} disabled={attachmentBusy || sendBusy} onClick={() => void removeComposerAttachment(attachment.id)}><X size={14} /></button>
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
                url: `/api/mail-drafts/${encodeURIComponent(attachment.draftId ?? composer.id)}/attachments/${encodeURIComponent(attachment.id)}`,
              }))}
              onChange={(bodyContent) => setComposer((current) => current ? {
                ...current,
                bodyContent,
                textBody: noteContentToPlainText(bodyContent),
              } : current)}
            />
            {composer.errorMessage && <div className="composer-error"><AlertCircle size={14} />Zuletzt gesendet fehlgeschlagen:{composer.errorMessage}</div>}
          </div>
          <footer>
            <div className="mail-compose-secondary-actions">
              <button className="composer-discard" disabled={sendBusy || attachmentBusy || composerSaveState === "saving"} onClick={() => void discardComposer()}><Trash2 size={15} />{composer.localOnly ? "E-Mail aufgeben" : "Entwurf streichen"}</button>
              <input
                ref={attachmentInputRef}
                className="mail-attachment-input"
                type="file"
                multiple
                aria-label="Auswahl von E-Mail-Anhängern"
                onChange={(event) => void uploadComposerAttachments(Array.from(event.target.files ?? []))}
              />
              <button className="composer-attach" disabled={sendBusy || attachmentBusy || composerSaveState === "saving" || composer.attachments.length >= 10} onClick={() => attachmentInputRef.current?.click()}>
                {attachmentBusy ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}Anhänge hinzufügen
              </button>
              {composerSignatures.length > 0 && <AppSelect
                ariaLabel="E-Mail-Signatur"
                className="composer-signature-select"
                size="compact"
                value={composerSignatureValue}
                disabled={sendBusy || attachmentBusy}
                onValueChange={applyComposerSignature}
                options={composerSignatureOptions}
              />}
            </div>
            <div>
              <button className="secondary-button" disabled={sendBusy || attachmentBusy} onClick={() => void closeComposer()}>später senden</button>
              <button className="primary-button" disabled={sendBusy || attachmentBusy || composerSaveState === "saving"} onClick={() => void requestSendConfirmation()}><Send size={15} />überprüfen und senden</button>
            </div>
          </footer>
        </section>
      </div>
    )}
    {composer && sendConfirmationKey && (
      <div className="mail-send-confirmation-backdrop">
        <section className="mail-send-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="mail-send-confirmation-title" data-testid="mail-send-confirmation">
          <div className="confirmation-icon"><Send size={20} /></div>
          <h2 id="mail-send-confirmation-title">E-Mail senden?</h2>
          <dl>
            <div><dt>Von</dt><dd>{composerAccount?.displayName} &lt;{composerAccount?.emailAddress}&gt;</dd></div>
            <div><dt>Empfänger</dt><dd>{[...composer.to, ...composer.cc, ...composer.bcc].join(", ")}</dd></div>
            <div><dt>Thema</dt><dd>{composer.subject}</dd></div>
            {composerFileAttachments.length > 0 && <div><dt>Befestigung</dt><dd>{composerFileAttachments.length} Eins... {formatFileSize(composerFileAttachments.reduce((total, item) => total + item.sizeBytes, 0))}</dd></div>}
            {composerInlineImages.length > 0 && <div><dt>Körperbilder</dt><dd>{composerInlineImages.length} Änderung</dd></div>}
          </dl>
          <p>kann nach dem Versand nicht zurückgezogen werden.</p>
          <footer>
            <button className="secondary-button" disabled={sendBusy} onClick={() => setSendConfirmationKey(undefined)}>gibt Änderungen zurück</button>
            <button className="primary-button" disabled={sendBusy} onClick={() => void confirmSend()}>{sendBusy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}Senden</button>
          </footer>
        </section>
      </div>
    )}
    {batchDeletePending && selectedBatchItems.length > 0 && (
      <div className="mail-send-confirmation-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !batchActionBusy) setBatchDeletePending(false);
      }}>
        <section className="mail-send-confirmation batch-delete-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="batch-delete-confirmation-title">
          <div className="confirmation-icon danger"><Trash2 size={20} /></div>
          <h2 id="batch-delete-confirmation-title">Ausgewählte löschen {selectedBatchItems.length} Eine E-Mail?</h2>
          <p>Die E-Mail wird in den Ordner " Gelöschte E-Mail " des jeweiligen Kontos verschoben; das fehlgeschlagene Element bleibt ausgewählt.</p>
          <footer>
            <button className="secondary-button" disabled={Boolean(batchActionBusy)} onClick={() => setBatchDeletePending(false)}>Abbrechen</button>
            <button className="danger-confirm-button" disabled={Boolean(batchActionBusy)} onClick={() => void runBatchMessageAction("delete")}>
              {batchActionBusy === "delete" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}Löschung bestätigen
            </button>
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
    return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}
