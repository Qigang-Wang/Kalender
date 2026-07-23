"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Archive,
  AlertCircle,
  Award,
  CalendarDays,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  DatabaseBackup,
  Download,
  FileText,
  FileArchive,
  Folder,
  GripVertical,
  FolderPlus,
  HardDrive,
  Inbox,
  ImageIcon,
  LayoutGrid,
  Link2,
  ListChecks,
  LoaderCircle,
  Mail,
  MapPin,
  MoreHorizontal,
  NotebookPen,
  Pause,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Pin,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Upload,
  WandSparkles,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { ContextMenu } from "./context-menu";
import { AiProviderSettings } from "./ai-provider-settings";
import { AiCommand } from "./ai-command";
import { GlobalCommandBar } from "./global-command-bar";
import { decodeNoteContent, EMPTY_PLATE_NOTE_CONTENT, encodeNoteContent, noteContentToPlainText } from "@/lib/note-content";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { groupMailByDate, type MailDateGroupId } from "@/lib/mail-date-groups";
import { resolveReplyRecipients } from "@/lib/mail-reply-recipients";
import { isSmimeSignatureAttachment } from "@/lib/mail-smime";
import {
  resolveContextCommands,
  type CalendarEventCommandId,
  type CalendarSlotCommandId,
  type ContextCommandId,
  type MailMessageCommandId,
  type MailFolderCommandId,
  type NoteCommandId,
  type ResolvedContextCommand,
  type TaskCommandId,
} from "./context-commands";

const MailComposerEditor = dynamic(
  () => import("./editor/mail-composer-editor").then((module) => module.MailComposerEditor),
  {
    loading: () => <EditorLoading label="正在加载邮件编辑器…" />,
    ssr: false,
  },
);

const PlateNoteEditor = dynamic(
  () => import("./editor/plate-editor").then((module) => module.PlateNoteEditor),
  {
    loading: () => <EditorLoading label="正在加载笔记编辑器…" />,
    ssr: false,
  },
);

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

export const sections = ["today", "inbox", "calendar", "tasks", "notes", "ai", "settings"] as const;
export type WorkspaceSection = (typeof sections)[number];

interface SidebarMailAccount {
  readonly id: string;
  readonly displayName: string;
  readonly color: string;
  readonly unreadCount: number;
  readonly lastSyncAt?: string;
}

interface SidebarMailFolder {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly role: string;
  readonly parentId?: string;
  readonly unreadCount?: number;
  readonly totalCount?: number;
  readonly sortOrder?: number;
  readonly manualSortOrder?: number;
}

const navigation: ReadonlyArray<{
  section: WorkspaceSection;
  label: string;
  icon: typeof Inbox;
}> = [
  { section: "today", label: "Today", icon: Sparkles },
  { section: "inbox", label: "Inbox", icon: Inbox },
  { section: "calendar", label: "Calendar", icon: CalendarDays },
  { section: "tasks", label: "Tasks", icon: CheckCircle2 },
  { section: "notes", label: "Notes", icon: NotebookPen },
  { section: "ai", label: "AI Command", icon: WandSparkles },
];

const pageCopy: Record<WorkspaceSection, { title: string; subtitle: string; assistant: string }> = {
  today: { title: "Today", subtitle: "当天日程、需要推进的任务和未读邮件。", assistant: "每日简报" },
  inbox: { title: "统一收件箱", subtitle: "两个账户 · 16 封未读", assistant: "邮件助手" },
  calendar: { title: "日历", subtitle: "在周视图和月视图中管理时间", assistant: "日程建议" },
  tasks: { title: "Today Tasks", subtitle: "从沟通到执行的统一任务列表", assistant: "任务建议" },
  notes: { title: "Notes", subtitle: "按项目组织思考、会议与行动记录", assistant: "笔记助手" },
  ai: { title: "AI Command", subtitle: "真实流式对话；当前阶段不读取或修改工作区数据。", assistant: "安全边界" },
  settings: { title: "连接账户", subtitle: "统一管理邮箱和日历连接。", assistant: "连接安全" },
};

const DEFAULT_SIDEBAR_WIDTH = 176;
const MIN_SIDEBAR_WIDTH = 156;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = "kalender:workspace-sidebar-width";
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

interface MailFolderConfirmation {
  readonly kind: "move-root" | "move-child" | "delete";
  readonly sourceId: string;
  readonly targetId?: string;
  readonly title: string;
  readonly description: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function WorkspaceApp({
  section,
  initialMessageId,
  initialMailFolderId,
  initialTaskId,
  initialScheduleTaskId,
  initialEventId,
  initialCalendarDate,
  initialNoteId,
}: {
  readonly section: WorkspaceSection;
  readonly initialMessageId?: string;
  readonly initialMailFolderId?: string;
  readonly initialTaskId?: string;
  readonly initialScheduleTaskId?: string;
  readonly initialEventId?: string;
  readonly initialCalendarDate?: string;
  readonly initialNoteId?: string;
}) {
  useVisualViewportLayout();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarWidthLoaded, setSidebarWidthLoaded] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sidebarMailAccounts, setSidebarMailAccounts] = useState<readonly SidebarMailAccount[]>();
  const [sidebarMailFolders, setSidebarMailFolders] = useState<readonly SidebarMailFolder[]>([]);
  const [expandedMailAccounts, setExpandedMailAccounts] = useState<ReadonlySet<string>>(() => new Set());
  const userMenuRef = useRef<HTMLDivElement>(null);
  const copy = pageCopy[section];
  const sidebarUnreadCount = sidebarMailAccounts?.reduce((total, account) => total + account.unreadCount, 0) ?? 0;

  useEffect(() => {
    try {
      const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
      if (Number.isFinite(storedWidth) && storedWidth > 0) setSidebarWidth(clampSidebarWidth(storedWidth));
    } catch {
      // Keep the default width when browser storage is unavailable.
    } finally {
      setSidebarWidthLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!sidebarWidthLoaded) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
      } catch {
        // Resizing still works when browser storage is unavailable.
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [sidebarWidth, sidebarWidthLoaded]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setUserMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [userMenuOpen]);

  const refreshSidebarMail = useCallback(async () => {
    const [accountPayload, folderPayload] = await Promise.all([
      fetchWithTimeout("/api/mail-accounts", { cache: "no-store" }).then((response) => response.json()) as Promise<{ readonly accounts?: readonly { readonly id: string; readonly displayName: string; readonly color: string; readonly lastSyncAt?: string }[] }>,
      fetchWithTimeout("/api/mail-folders", { cache: "no-store" }).then((response) => response.json()) as Promise<{ readonly folders?: readonly SidebarMailFolder[] }>,
    ]);
    const folders = folderPayload.folders ?? [];
    const accounts = (accountPayload.accounts ?? []).map((account) => ({
      ...account,
      unreadCount: folders.filter((folder) => folder.accountId === account.id && folder.role === "inbox")
        .reduce((total, folder) => total + (folder.unreadCount ?? 0), 0),
    }));
    setSidebarMailAccounts(accounts);
    setSidebarMailFolders(folders);
    setExpandedMailAccounts((current) => current.size ? current : new Set(accounts.map((account) => account.id)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refreshSidebarMail().catch(() => {
      if (!cancelled) setSidebarMailAccounts([]);
    });
    return () => { cancelled = true; };
  }, [refreshSidebarMail]);

  return (
    <div className="app-shell" style={{ "--workspace-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div><strong>个人工作台</strong><span>Quiet Intelligence</span></div>
          <button className="mobile-close" aria-label="关闭导航" onClick={() => setSidebarOpen(false)}><X /></button>
        </div>

        <nav className="primary-nav" aria-label="主导航">
          {navigation.map(({ section: item, label, icon: Icon }) => (
            <Link className={item === section ? "active" : ""} href={`/${item}`} key={item} onClick={() => setSidebarOpen(false)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {item === "inbox" && sidebarUnreadCount > 0 && <em>{sidebarUnreadCount}</em>}
            </Link>
          ))}
        </nav>

        <div className="account-block">
          <p className="eyebrow">邮箱账户</p>
          {sidebarMailAccounts === undefined ? <small>正在读取账户…</small> : sidebarMailAccounts.length ? <>
            {sidebarMailAccounts.map((account) => {
              const expanded = expandedMailAccounts.has(account.id);
              return <div className="mail-account-tree" key={account.id}>
                <button
                  className="mail-account-toggle"
                  aria-expanded={expanded}
                  onClick={() => setExpandedMailAccounts((current) => {
                    const next = new Set(current);
                    if (next.has(account.id)) next.delete(account.id); else next.add(account.id);
                    return next;
                  })}
                >
                  <ChevronDown className={expanded ? "" : "collapsed"} size={13} />
                  <i className="account-dot" style={{ background: account.color }} />
                  <strong>{account.displayName}</strong>
                  {account.unreadCount > 0 && <span>{account.unreadCount}</span>}
                </button>
                {section === "inbox" && expanded && <MailFolderTree
                  accountId={account.id}
                  folders={sidebarMailFolders}
                  selectedFolderId={initialMailFolderId}
                  onNavigate={() => setSidebarOpen(false)}
                  onRefresh={refreshSidebarMail}
                />}
              </div>;
            })}
            <small>{formatSidebarSyncTime(sidebarMailAccounts)}</small>
          </> : <Link className="sidebar-connect-mail" href="/settings"><Plus size={13} />连接邮箱</Link>}
        </div>

        <div className="sidebar-user-area" ref={userMenuRef}>
          {userMenuOpen && (
            <div className="sidebar-user-menu" role="menu">
              <Link href="/settings" role="menuitem" onClick={() => { setUserMenuOpen(false); setSidebarOpen(false); }}>
                <Settings size={16} /><span><strong>账户设置</strong><small>邮件、日历与服务连接</small></span>
              </Link>
            </div>
          )}
          <button
            className={`sidebar-footer ${section === "settings" ? "active" : ""}`}
            aria-expanded={userMenuOpen}
            aria-haspopup="menu"
            onClick={() => setUserMenuOpen((value) => !value)}
          >
            <div className="avatar">A</div>
            <div><strong>Adam</strong><span>个人空间</span></div>
            <ChevronDown className={userMenuOpen ? "user-menu-chevron-open" : ""} size={15} />
          </button>
        </div>
        <SidebarResizeHandle width={sidebarWidth} onChange={setSidebarWidth} />
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

      <section className="workspace">
        <GlobalCommandBar onOpenSidebar={() => setSidebarOpen(true)} />

        <div className={`page-grid ${section === "notes" ? "notes-page-grid" : ""} ${section === "today" ? "today-page-grid" : ""}`}>
          <main className="page-main">
            {(section === "today" || section === "settings") && <header className="page-heading">
              <div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
              <PageAction section={section} />
            </header>}
            <PageContent section={section} initialMessageId={initialMessageId} initialMailFolderId={initialMailFolderId} initialTaskId={initialTaskId} initialScheduleTaskId={initialScheduleTaskId} initialEventId={initialEventId} initialCalendarDate={initialCalendarDate} initialNoteId={initialNoteId} />
          </main>
          {section !== "notes" && section !== "today" && <AssistantPanel title={copy.assistant} section={section} />}
        </div>
      </section>
      <MobileBottomNav section={section} unreadCount={sidebarUnreadCount} />
    </div>
  );
}

function SidebarResizeHandle({
  width,
  onChange,
}: {
  readonly width: number;
  readonly onChange: (width: number) => void;
}) {
  const dragState = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    previewWidth: number;
  } | undefined>(undefined);

  const finishResize = useCallback((element?: HTMLDivElement, pointerId?: number) => {
    if (element && pointerId !== undefined && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    dragState.current = undefined;
    document.body.classList.remove("sidebar-is-resizing");
  }, []);

  useEffect(() => () => document.body.classList.remove("sidebar-is-resizing"), []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragState.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, previewWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("sidebar-is-resizing");
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.previewWidth = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX);
    event.currentTarget.closest<HTMLElement>(".app-shell")?.style.setProperty("--workspace-sidebar-width", `${drag.previewWidth}px`);
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (drag?.pointerId !== event.pointerId) return;
    finishResize(event.currentTarget, event.pointerId);
    onChange(drag.previewWidth);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | undefined;
    const step = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft") nextWidth = width - step;
    if (event.key === "ArrowRight") nextWidth = width + step;
    if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH;
    if (nextWidth === undefined) return;
    event.preventDefault();
    onChange(clampSidebarWidth(nextWidth));
  };

  return (
    <div
      className="sidebar-resize-handle"
      role="separator"
      aria-label="调整左侧导航宽度"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整宽度；双击恢复默认"
      onDoubleClick={() => onChange(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
    />
  );
}

function MailFolderTree({
  accountId,
  folders,
  selectedFolderId,
  onNavigate,
  onRefresh,
}: {
  readonly accountId: string;
  readonly folders: readonly SidebarMailFolder[];
  readonly selectedFolderId?: string;
  readonly onNavigate: () => void;
  readonly onRefresh: () => Promise<void>;
}) {
  const storageKey = `kalender:mail-folder-expanded:${accountId}`;
  const [expandedFolderIds, setExpandedFolderIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expansionLoaded, setExpansionLoaded] = useState(false);
  const [folderMenu, setFolderMenu] = useState<{ readonly folderId: string; readonly x: number; readonly y: number }>();
  const [folderBusyId, setFolderBusyId] = useState<string>();
  const [folderNotice, setFolderNotice] = useState<string>();
  const [draggedFolderId, setDraggedFolderId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ readonly folderId: string; readonly zone: "before" | "inside" | "after" }>();
  const [messageDropTargetId, setMessageDropTargetId] = useState<string>();
  const [folderConfirmation, setFolderConfirmation] = useState<MailFolderConfirmation>();
  const accountFolders = useMemo(() => folders.filter((folder) => folder.accountId === accountId), [accountId, folders]);
  const ids = useMemo(() => new Set(accountFolders.map((folder) => folder.id)), [accountFolders]);
  const children = useMemo(() => {
    const value = new Map<string | undefined, SidebarMailFolder[]>();
    for (const folder of accountFolders) {
      const parentId = folder.parentId && ids.has(folder.parentId) ? folder.parentId : undefined;
      value.set(parentId, [...(value.get(parentId) ?? []), folder]);
    }
    for (const entries of value.values()) entries.sort(compareMailFolders);
    return value;
  }, [accountFolders, ids]);

  useEffect(() => {
    let restored: readonly string[] = [];
    try {
      const value = window.localStorage.getItem(storageKey);
      restored = value ? JSON.parse(value) as readonly string[] : [];
    } catch {
      restored = [];
    }
    setExpandedFolderIds(new Set(restored.filter((id) => ids.has(id))));
    setExpansionLoaded(true);
  }, [accountId, storageKey]);

  useEffect(() => {
    if (!selectedFolderId || !ids.has(selectedFolderId)) return;
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      let parentId = accountFolders.find((folder) => folder.id === selectedFolderId)?.parentId;
      while (parentId && ids.has(parentId)) {
        next.add(parentId);
        parentId = accountFolders.find((folder) => folder.id === parentId)?.parentId;
      }
      return next;
    });
  }, [accountFolders, ids, selectedFolderId]);

  useEffect(() => {
    if (!expansionLoaded) return;
    window.localStorage.setItem(storageKey, JSON.stringify([...expandedFolderIds]));
  }, [expandedFolderIds, expansionLoaded, storageKey]);

  useEffect(() => {
    if (!folderNotice) return;
    const timer = window.setTimeout(() => setFolderNotice(undefined), 3600);
    return () => window.clearTimeout(timer);
  }, [folderNotice]);

  useEffect(() => {
    if (!folderConfirmation) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || folderBusyId) return;
      event.preventDefault();
      setFolderConfirmation(undefined);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [folderBusyId, folderConfirmation]);

  const runFolderRequest = async (
    folderId: string,
    url: string,
    init: RequestInit,
    successMessage: string,
  ) => {
    if (folderBusyId) return;
    setFolderBusyId(folderId);
    setFolderNotice("正在同步文件夹操作到邮箱服务器…");
    try {
      const response = await fetch(url, init);
      const payload = await response.json() as { readonly message?: string; readonly result?: { readonly refreshed?: boolean } };
      if (!response.ok) throw new Error(payload.message || "文件夹操作失败");
      await onRefresh();
      setFolderNotice(payload.result?.refreshed === false ? `${successMessage}；服务器已修改，后台同步稍后完成` : successMessage);
    } catch (error) {
      setFolderNotice(error instanceof Error ? error.message : "文件夹操作失败");
    } finally {
      setFolderBusyId(undefined);
    }
  };

  const handleFolderCommand = (commandId: MailFolderCommandId) => {
    const folder = accountFolders.find((item) => item.id === folderMenu?.folderId);
    setFolderMenu(undefined);
    if (!folder) return;
    if (commandId === "mail-folder.create-child" || commandId === "mail-folder.create-sibling") {
      const name = window.prompt(commandId === "mail-folder.create-child" ? `在“${mailFolderLabel(folder)}”中新建子文件夹` : "新建同级文件夹");
      if (!name?.trim()) return;
      const parentFolderId = commandId === "mail-folder.create-child" ? folder.id : folder.parentId;
      void runFolderRequest(folder.id, "/api/mail-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, parentFolderId, name }),
      }, `已创建文件夹“${name.trim()}”`);
      return;
    }
    if (commandId === "mail-folder.rename") {
      const name = window.prompt("重命名文件夹", folder.name);
      if (!name?.trim() || name.trim() === folder.name) return;
      void runFolderRequest(folder.id, `/api/mail-folders/${encodeURIComponent(folder.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", name }),
      }, `已重命名为“${name.trim()}”`);
      return;
    }
    if (commandId === "mail-folder.move-root") {
      setFolderConfirmation({
        kind: "move-root",
        sourceId: folder.id,
        title: "移动到邮箱顶层？",
        description: `“${folder.name}”将不再属于当前上级文件夹。`,
        detail: "文件夹中的邮件和子文件夹会保持不变。",
        confirmLabel: "确认移动",
      });
      return;
    }
    if (commandId === "mail-folder.delete") {
      const descendants = countFolderDescendants(folder.id, children);
      const detail = `${folder.totalCount ?? 0} 封邮件${descendants ? `、${descendants} 个子文件夹` : ""}`;
      setFolderConfirmation({
        kind: "delete",
        sourceId: folder.id,
        title: "删除这个文件夹？",
        description: `“${folder.name}”将移至已删除邮件。`,
        detail: `其中包含 ${detail}，之后仍可在 Outlook 中恢复。`,
        confirmLabel: "移至已删除邮件",
        danger: true,
      });
    }
  };

  const confirmFolderAction = async () => {
    const confirmation = folderConfirmation;
    if (!confirmation || folderBusyId) return;
    const source = accountFolders.find((folder) => folder.id === confirmation.sourceId);
    const target = confirmation.targetId ? accountFolders.find((folder) => folder.id === confirmation.targetId) : undefined;
    setFolderConfirmation(undefined);
    if (!source) return;
    if (confirmation.kind === "move-child" && !target) {
      setFolderNotice("目标文件夹已发生变化，请重新操作");
      return;
    }
    if (confirmation.kind === "delete") {
      await runFolderRequest(source.id, `/api/mail-folders/${encodeURIComponent(source.id)}`, { method: "DELETE" }, `已将“${source.name}”移至已删除邮件`);
      return;
    }
    await runFolderRequest(source.id, `/api/mail-folders/${encodeURIComponent(source.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(confirmation.kind === "move-root" ? { action: "move" } : { action: "move", parentFolderId: target?.id }),
    }, confirmation.kind === "move-root" ? `已将“${source.name}”移动到顶层` : `已将“${source.name}”移动到“${target?.name ?? "目标文件夹"}”`);
    if (confirmation.kind === "move-child" && target) {
      setExpandedFolderIds((current) => new Set([...current, target.id]));
    }
  };

  const handleFolderDrop = async (event: DragEvent<HTMLDivElement>, target: SidebarMailFolder) => {
    event.preventDefault();
    const source = accountFolders.find((folder) => folder.id === draggedFolderId);
    const zone = dropTarget?.folderId === target.id ? dropTarget.zone : "inside";
    setDropTarget(undefined);
    setDraggedFolderId(undefined);
    if (!source || source.id === target.id || folderBusyId) return;
    if (zone === "before" || zone === "after") {
      if (source.parentId !== target.parentId || !isMutableMailFolder(target)) {
        setFolderNotice("上下排序仅适用于同一层级的自定义文件夹；拖到名称中央可移动为子文件夹");
        return;
      }
      const siblings = [...(children.get(source.parentId) ?? [])].filter(isMutableMailFolder).sort(compareMailFolders);
      const sourceIndex = siblings.findIndex((folder) => folder.id === source.id);
      const targetIndex = siblings.findIndex((folder) => folder.id === target.id);
      if (sourceIndex < 0 || targetIndex < 0) return;
      siblings.splice(sourceIndex, 1);
      const adjustedTarget = siblings.findIndex((folder) => folder.id === target.id);
      siblings.splice(adjustedTarget + (zone === "after" ? 1 : 0), 0, source);
      await runFolderRequest(source.id, "/api/mail-folders/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, parentFolderId: source.parentId, orderedFolderIds: siblings.map((folder) => folder.id) }),
      }, "文件夹顺序已保存");
      return;
    }
    setFolderConfirmation({
      kind: "move-child",
      sourceId: source.id,
      targetId: target.id,
      title: "移动文件夹？",
      description: `把“${source.name}”移动到“${target.name}”中。`,
      detail: "此操作会同步修改 RWTH/Outlook 中的文件夹层级。",
      confirmLabel: "确认移动",
    });
  };

  const handleMailMessageDrop = async (event: DragEvent<HTMLDivElement>, target: SidebarMailFolder) => {
    event.preventDefault();
    event.stopPropagation();
    setMessageDropTargetId(undefined);
    if (folderBusyId || target.role === "all") return;
    let dragged: MailMessageDragPayload | undefined;
    try {
      dragged = JSON.parse(event.dataTransfer.getData(MAIL_MESSAGE_DRAG_TYPE)) as MailMessageDragPayload;
    } catch {
      setFolderNotice("无法识别拖动的邮件");
      return;
    }
    if (!dragged?.messageId || !dragged.accountId || !dragged.subject) return;
    if (dragged.accountId !== accountId) {
      setFolderNotice("邮件只能移动到同一个邮箱账户的文件夹");
      return;
    }
    setFolderBusyId(target.id);
    setFolderNotice(`正在将“${dragged.subject}”移动到“${mailFolderLabel(target)}”…`);
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(dragged.messageId)}/actions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", folderId: target.id }),
      });
      const payload = await response.json() as {
        readonly message?: string;
        readonly result?: { readonly movedCount?: number; readonly destinationFolderId?: string };
      };
      if (!response.ok || !payload.result) throw new Error(payload.message || "邮件移动失败");
      await onRefresh();
      const movedCount = Math.max(1, payload.result.movedCount ?? 1);
      const destinationName = mailFolderLabel(target);
      setFolderNotice(movedCount > 1
        ? `已将会话中的 ${movedCount} 封邮件移动到“${destinationName}”`
        : `已将邮件移动到“${destinationName}”`);
      window.dispatchEvent(new CustomEvent<MailMessageMovedDetail>(MAIL_MESSAGE_MOVED_EVENT, {
        detail: {
          ...dragged,
          destinationFolderId: target.id,
          destinationName,
          movedCount,
        },
      }));
    } catch (error) {
      setFolderNotice(error instanceof Error ? error.message : "邮件移动失败");
    } finally {
      setFolderBusyId(undefined);
    }
  };

  const renderLevel = (parentId: string | undefined, depth: number, visited: ReadonlySet<string>): ReactNode =>
    (children.get(parentId) ?? []).map((folder) => {
      if (visited.has(folder.id)) return null;
      const FolderIcon = mailFolderIcon(folder.role);
      const hasChildren = (children.get(folder.id)?.length ?? 0) > 0;
      const expanded = expandedFolderIds.has(folder.id);
      const mutable = isMutableMailFolder(folder);
      const targetZone = dropTarget?.folderId === folder.id ? dropTarget.zone : undefined;
      const isMessageDropTarget = messageDropTargetId === folder.id;
      return <div key={folder.id}>
        <div
          className={`mail-folder-row ${mutable ? "draggable" : ""} ${draggedFolderId === folder.id ? "dragging" : ""} ${targetZone ? `drop-${targetZone}` : ""} ${isMessageDropTarget ? "message-drop-target" : ""} ${folderBusyId === folder.id ? "busy" : ""}`}
          style={{ "--mail-folder-depth": depth } as CSSProperties}
          draggable={mutable}
          onDragStart={(event) => {
            if (!mutable) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", folder.id);
            event.dataTransfer.setData("application/x-kalender-mail-folder", folder.id);
            setDraggedFolderId(folder.id);
            setMessageDropTargetId(undefined);
          }}
          onDragEnd={() => { setDraggedFolderId(undefined); setDropTarget(undefined); setMessageDropTargetId(undefined); }}
          onContextMenu={(event) => {
            event.preventDefault();
            setFolderMenu({ folderId: folder.id, x: event.clientX, y: event.clientY });
          }}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes(MAIL_MESSAGE_DRAG_TYPE)) {
              if (folder.role === "all") return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTarget(undefined);
              setMessageDropTargetId(folder.id);
              return;
            }
            if (!draggedFolderId || draggedFolderId === folder.id) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
            const source = accountFolders.find((item) => item.id === draggedFolderId);
            const sameParent = source?.parentId === folder.parentId;
            setDropTarget({
              folderId: folder.id,
              zone: sameParent
                ? ratio < 0.42 ? "before" : ratio > 0.58 ? "after" : "inside"
                : ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside",
            });
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setMessageDropTargetId((current) => current === folder.id ? undefined : current);
          }}
          onDrop={(event) => {
            if (Array.from(event.dataTransfer.types).includes(MAIL_MESSAGE_DRAG_TYPE)) void handleMailMessageDrop(event, folder);
            else void handleFolderDrop(event, folder);
          }}
        >
          {hasChildren ? <button
            className={`mail-folder-toggle ${expanded ? "expanded" : ""}`}
            aria-label={`${expanded ? "折叠" : "展开"}${mailFolderLabel(folder)}`}
            aria-expanded={expanded}
            onClick={() => setExpandedFolderIds((current) => {
              const next = new Set(current);
              if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id);
              return next;
            })}
          ><ChevronRight size={12} /></button> : <span className="mail-folder-toggle-spacer" />}
          <Link
            className={`mail-folder-link ${selectedFolderId === folder.id ? "active" : ""}`}
            href={`/inbox?folder=${encodeURIComponent(folder.id)}`}
            draggable={false}
            aria-current={selectedFolderId === folder.id ? "page" : undefined}
            onClick={onNavigate}
          >
            <FolderIcon size={14} />
            <span>{mailFolderLabel(folder)}</span>
            {(folder.unreadCount ?? 0) > 0 && <em>{folder.unreadCount}</em>}
          </Link>
          {mutable && <span
            className="mail-folder-drag-handle"
            title="拖动排序或移动文件夹"
          ><GripVertical size={13} /></span>}
        </div>
        {hasChildren && expanded && renderLevel(folder.id, depth + 1, new Set([...visited, folder.id]))}
      </div>;
    });
  const contextFolder = accountFolders.find((folder) => folder.id === folderMenu?.folderId);
  const contextMutable = contextFolder ? isMutableMailFolder(contextFolder) : false;
  const contextCommands: readonly ResolvedContextCommand[] = contextFolder ? [
    { id: "mail-folder.create-child", label: "新建子文件夹", group: "primary", risk: "external-write", icon: "note" },
    { id: "mail-folder.create-sibling", label: "新建同级文件夹", group: "primary", risk: "external-write", icon: "copy" },
    ...(contextMutable ? [
      { id: "mail-folder.rename", label: "重命名", group: "organize", risk: "external-write", icon: "edit" },
      ...(contextFolder.parentId ? [{ id: "mail-folder.move-root", label: "移动到邮箱顶层", group: "organize", risk: "external-write", icon: "archive" } as const] : []),
      { id: "mail-folder.delete", label: "删除文件夹", group: "danger", risk: "destructive", icon: "trash" },
    ] as const : []),
  ] : [];
  return <div className="mail-folder-tree">
    {folderNotice && <div className="mail-folder-notice">{folderNotice}</div>}
    {renderLevel(undefined, 0, new Set())}
    {folderMenu && contextFolder && <ContextMenu
      anchor={{ x: folderMenu.x, y: folderMenu.y }}
      ariaLabel={`文件夹操作：${contextFolder.name}`}
      heading={contextFolder.name}
      commands={contextCommands}
      onClose={() => setFolderMenu(undefined)}
      onSelect={(commandId) => handleFolderCommand(commandId as MailFolderCommandId)}
    />}
    {folderConfirmation && <div className="app-confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !folderBusyId) setFolderConfirmation(undefined); }}>
      <section className={`app-confirmation ${folderConfirmation.danger ? "danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="mail-folder-confirmation-title" aria-describedby="mail-folder-confirmation-description">
        <header>
          <span className="app-confirmation-icon">{folderConfirmation.danger ? <Trash2 size={18} /> : <Folder size={18} />}</span>
          <div><small>同步到邮箱服务器</small><h2 id="mail-folder-confirmation-title">{folderConfirmation.title}</h2></div>
          <button aria-label="关闭" disabled={Boolean(folderBusyId)} onClick={() => setFolderConfirmation(undefined)}><X size={17} /></button>
        </header>
        <p id="mail-folder-confirmation-description">{folderConfirmation.description}</p>
        <div className="app-confirmation-detail">{folderConfirmation.detail}</div>
        <footer>
          <button className="secondary-button" disabled={Boolean(folderBusyId)} onClick={() => setFolderConfirmation(undefined)}>取消</button>
          <button className={`app-confirmation-submit ${folderConfirmation.danger ? "danger" : ""}`} disabled={Boolean(folderBusyId)} autoFocus onClick={() => void confirmFolderAction()}>{folderBusyId ? <LoaderCircle className="spin" size={15} /> : null}{folderConfirmation.confirmLabel}</button>
        </footer>
      </section>
    </div>}
  </div>;
}

function isMutableMailFolder(folder: SidebarMailFolder): boolean {
  return folder.role === "other" || folder.role === "custom";
}

function countFolderDescendants(folderId: string, children: ReadonlyMap<string | undefined, readonly SidebarMailFolder[]>): number {
  return (children.get(folderId) ?? []).reduce((total, child) => total + 1 + countFolderDescendants(child.id, children), 0);
}

function compareMailFolders(left: SidebarMailFolder, right: SidebarMailFolder): number {
  const specialOrder: Record<string, number> = {
    inbox: 0,
    drafts: 1,
    sent: 2,
    archive: 3,
    all: 4,
    junk: 5,
    spam: 5,
    trash: 6,
  };
  const leftSpecial = specialOrder[left.role];
  const rightSpecial = specialOrder[right.role];
  if (leftSpecial !== undefined || rightSpecial !== undefined) {
    if (leftSpecial === undefined) return 1;
    if (rightSpecial === undefined) return -1;
    if (leftSpecial !== rightSpecial) return leftSpecial - rightSpecial;
  }
  if (left.manualSortOrder !== undefined || right.manualSortOrder !== undefined) {
    if (left.manualSortOrder === undefined) return 1;
    if (right.manualSortOrder === undefined) return -1;
    if (left.manualSortOrder !== right.manualSortOrder) return left.manualSortOrder - right.manualSortOrder;
  }
  return (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER)
    || left.name.localeCompare(right.name, "de-DE");
}

function mailFolderLabel(folder: SidebarMailFolder): string {
  return ({ inbox: "收件箱", drafts: "草稿", sent: "已发送", archive: "归档", all: "所有邮件", junk: "垃圾邮件", spam: "垃圾邮件", trash: "已删除" } as Record<string, string>)[folder.role] ?? folder.name;
}

function mailFolderIcon(role: string): typeof Folder {
  return ({ inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, all: Mail, junk: AlertCircle, spam: AlertCircle, trash: Trash2 } as Record<string, typeof Folder>)[role] ?? Folder;
}

function useVisualViewportLayout() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let focusedControl: HTMLElement | null = null;

    const syncViewport = () => {
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      root.style.setProperty("--visual-viewport-height", `${Math.round(height)}px`);
      root.style.setProperty("--visual-viewport-offset-top", `${Math.round(offsetTop)}px`);
      const keyboardOpen = window.innerWidth <= 760 && height < window.innerHeight * 0.82;
      document.body.classList.toggle("software-keyboard-open", keyboardOpen);
      if (keyboardOpen && focusedControl?.isConnected) {
        focusedControl.scrollIntoView({ block: "center", inline: "nearest" });
      }
    };
    const handleFocus = (event: FocusEvent) => {
      const target = event.target;
      focusedControl = target instanceof HTMLElement && target.matches("input, select, textarea, [contenteditable='true']") ? target : null;
      syncViewport();
    };
    const handleBlur = () => {
      focusedControl = null;
      syncViewport();
    };

    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    document.addEventListener("focusin", handleFocus);
    document.addEventListener("focusout", handleBlur);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      document.removeEventListener("focusin", handleFocus);
      document.removeEventListener("focusout", handleBlur);
      document.body.classList.remove("software-keyboard-open");
      root.style.removeProperty("--visual-viewport-height");
      root.style.removeProperty("--visual-viewport-offset-top");
    };
  }, []);
}

function MobileBottomNav({ section, unreadCount }: { readonly section: WorkspaceSection; readonly unreadCount: number }) {
  const items = navigation.filter((item) => item.section !== "ai");
  return (
    <nav className="mobile-bottom-nav" aria-label="移动端主导航">
      {items.map(({ section: item, label, icon: Icon }) => (
        <Link className={item === section ? "active" : ""} href={`/${item}`} key={item} aria-current={item === section ? "page" : undefined}>
          <span><Icon size={20} strokeWidth={1.8} />{item === "inbox" && unreadCount > 0 && <em>{unreadCount > 99 ? "99+" : unreadCount}</em>}</span>
          <small>{label}</small>
        </Link>
      ))}
    </nav>
  );
}

function formatSidebarSyncTime(accounts: readonly SidebarMailAccount[]): string {
  const latest = accounts.reduce<number | undefined>((current, account) => {
    if (!account.lastSyncAt) return current;
    const value = new Date(account.lastSyncAt).getTime();
    if (Number.isNaN(value)) return current;
    return current === undefined ? value : Math.max(current, value);
  }, undefined);
  if (latest === undefined) return "尚未完成同步";
  const minutes = Math.max(0, Math.round((Date.now() - latest) / 60_000));
  if (minutes < 1) return "刚刚同步";
  if (minutes < 60) return `${minutes} 分钟前同步`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时前同步` : `${Math.round(hours / 24)} 天前同步`;
}

function PageAction({ section }: { readonly section: WorkspaceSection }) {
  if (section === "today") return <span className="count-badge">实时数据</span>;
  if (section === "settings") return <span className="model-badge">凭据不写入日志</span>;
  return null;
}

function PageContent({
  section,
  initialMessageId,
  initialMailFolderId,
  initialTaskId,
  initialScheduleTaskId,
  initialEventId,
  initialCalendarDate,
  initialNoteId,
}: {
  readonly section: WorkspaceSection;
  readonly initialMessageId?: string;
  readonly initialMailFolderId?: string;
  readonly initialTaskId?: string;
  readonly initialScheduleTaskId?: string;
  readonly initialEventId?: string;
  readonly initialCalendarDate?: string;
  readonly initialNoteId?: string;
}) {
  switch (section) {
    case "today": return <TodayPage />;
    case "inbox": return <InboxPage initialMessageId={initialMessageId} initialFolderId={initialMailFolderId} />;
    case "calendar": return <CalendarPage initialEventId={initialEventId} initialCalendarDate={initialCalendarDate} />;
    case "tasks": return <TasksPage initialTaskId={initialTaskId} initialScheduleTaskId={initialScheduleTaskId} />;
    case "notes": return <NotesPage initialNoteId={initialNoteId} />;
    case "ai": return <AiPage />;
    case "settings": return <SettingsPage />;
  }
}

type SettingsTab = "mail" | "calendar" | "ai" | "backup" | "todo";

function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("mail");
  return (
    <div className="settings-page">
      <nav className="settings-tabs" aria-label="设置分类">
        <button className={activeTab === "mail" ? "active" : ""} onClick={() => setActiveTab("mail")}><Mail size={16} />邮件</button>
        <button className={activeTab === "calendar" ? "active" : ""} onClick={() => setActiveTab("calendar")}><CalendarDays size={16} />日历</button>
        <button className={activeTab === "ai" ? "active" : ""} onClick={() => setActiveTab("ai")}><WandSparkles size={16} />AI</button>
        <button className={activeTab === "backup" ? "active" : ""} onClick={() => setActiveTab("backup")}><DatabaseBackup size={16} />备份</button>
        <button className={activeTab === "todo" ? "active" : ""} onClick={() => setActiveTab("todo")}><ListChecks size={16} />ToDo<span>预留</span></button>
      </nav>
      {activeTab === "mail" && <MailAccountSettings onManageExchange={() => setActiveTab("calendar")} />}
      {activeTab === "calendar" && <CalendarAccountSettings />}
      {activeTab === "ai" && <AiProviderSettings />}
      {activeTab === "backup" && <BackupSettings />}
      {activeTab === "todo" && (
        <section className="settings-placeholder panel">
          <div className="assistant-icon"><ListChecks size={17} /></div>
          <div><h2>ToDo 服务连接</h2><p>这里将用于连接 Microsoft To Do、Todoist 等服务。当前任务仍保存在 Kalender 本地。</p></div>
          <span className="step-badge">后续阶段</span>
        </section>
      )}
    </div>
  );
}

interface BackupStatusPayload {
  readonly databaseBytes: number;
  readonly attachmentBytes: number;
  readonly attachmentFiles: number;
  readonly keySource: "file" | "environment" | "none";
  readonly counts: Readonly<Record<string, number>>;
  readonly latestAutomaticBackupAt?: string;
}

function BackupSettings() {
  const [status, setStatus] = useState<BackupStatusPayload>();
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<"export" | "inspect" | "restore">();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error" | "info"; readonly message: string }>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/backups", { cache: "no-store" });
      const payload = await response.json() as { readonly ok?: boolean; readonly status?: BackupStatusPayload; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.status) throw new Error(payload.message || "无法读取备份状态");
      setStatus(payload.status);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法读取备份状态" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const downloadBackup = async () => {
    if (operation) return;
    setOperation("export");
    setFeedback({ kind: "info", message: "正在创建一致性数据库快照…" });
    try {
      const response = await fetch("/api/backups/export", { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
        throw new Error(payload?.message || "无法创建完整备份");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `Kalender-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setFeedback({ kind: "success", message: `完整备份“${filename}”已开始下载` });
      await loadStatus();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法创建完整备份" });
    } finally {
      setOperation(undefined);
    }
  };

  const restoreBackup = async () => {
    if (!selectedFile || operation) return;
    const confirmed = window.confirm(
      `从“${selectedFile.name}”恢复？\n\n当前数据库会先自动备份，然后由上传的备份完整替换。恢复期间请不要关闭页面。`,
    );
    if (!confirmed) return;
    setOperation("restore");
    setFeedback({ kind: "info", message: "正在校验备份并准备安全恢复…" });
    try {
      const response = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: selectedFile,
      });
      const payload = await response.json().catch(() => null) as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly restored?: { readonly safetyBackupFilename?: string };
      } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "无法恢复备份");
      setFeedback({
        kind: "success",
        message: `${payload.message || "备份恢复完成"}${payload.restored?.safetyBackupFilename ? `；恢复前副本：${payload.restored.safetyBackupFilename}` : ""}`,
      });
      setSelectedFile(undefined);
      if (fileInputRef.current) fileInputRef.current.value = "";
      window.setTimeout(() => window.location.reload(), 1_800);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法恢复备份" });
      setOperation(undefined);
    }
  };

  const inspectBackupFile = async (file: File) => {
    if (operation) return;
    setOperation("inspect");
    setSelectedFile(undefined);
    setFeedback({ kind: "info", message: `正在验证 ${file.name} 的校验和和数据库结构…` });
    try {
      const response = await fetch("/api/backups/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      const payload = await response.json().catch(() => null) as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly inspection?: {
          readonly manifest?: { readonly createdAt?: string };
          readonly counts?: Readonly<Record<string, number>>;
        };
      } | null;
      if (!response.ok || !payload?.ok || !payload.inspection) throw new Error(payload?.message || "备份验证失败");
      setSelectedFile(file);
      setFeedback({
        kind: "success",
        message: `备份验证通过 · ${payload.inspection.counts?.calendar_events ?? 0} 项日程 · 创建于 ${payload.inspection.manifest?.createdAt ? formatAccountTime(payload.inspection.manifest.createdAt) : "未知时间"}`,
      });
    } catch (error) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "备份验证失败" });
    } finally {
      setOperation(undefined);
    }
  };

  const totalBytes = (status?.databaseBytes ?? 0) + (status?.attachmentBytes ?? 0);
  return (
    <section className="backup-settings panel" aria-labelledby="backup-settings-title">
      <div className="settings-section-heading">
        <div><h2 id="backup-settings-title">数据备份与恢复</h2><p>下载完整的 PGlite 数据库、主密钥和本地草稿附件；数据库损坏后可从此恢复。</p></div>
        <span className="step-badge">本机完整快照</span>
      </div>

      <div className="backup-summary" aria-label="当前数据概况">
        <article><span><HardDrive size={17} /></span><div><small>预计备份数据</small><strong>{loading ? "正在计算…" : formatFileSize(totalBytes)}</strong></div></article>
        <article><span><NotebookPen size={17} /></span><div><small>笔记与任务</small><strong>{loading ? "—" : `${status?.counts.notes ?? 0} 篇 · ${status?.counts.tasks ?? 0} 项`}</strong></div></article>
        <article><span><CalendarDays size={17} /></span><div><small>日历事件</small><strong>{loading ? "—" : `${status?.counts.calendar_events ?? 0} 项`}</strong></div></article>
        <article><span><Paperclip size={17} /></span><div><small>草稿附件</small><strong>{loading ? "—" : `${status?.attachmentFiles ?? 0} 个 · ${formatFileSize(status?.attachmentBytes ?? 0)}`}</strong></div></article>
      </div>

      <div className="backup-operation-grid">
        <article className="backup-operation-card">
          <div className="backup-operation-icon"><Download size={20} /></div>
          <div><h3>创建完整备份</h3><p>生成普通 ZIP 文件，保留数据库内部 ID、账户连接、关联关系、同步状态和本地附件。</p></div>
          <button className="primary-button" disabled={Boolean(operation) || loading} onClick={() => void downloadBackup()}>
            {operation === "export" ? <LoaderCircle className="spin" size={15} /> : <FileArchive size={15} />}{operation === "export" ? "正在生成…" : "下载完整 ZIP"}
          </button>
        </article>

        <article className="backup-operation-card backup-restore-card">
          <div className="backup-operation-icon"><Upload size={20} /></div>
          <div><h3>从备份恢复</h3><p>上传此前下载的 ZIP。系统会先验证数据库和校验和，并自动保存当前数据库的保护副本。</p></div>
          <input
            ref={fileInputRef}
            className="backup-file-input"
            type="file"
            accept=".zip,application/zip"
            aria-label="选择 Kalender 备份 ZIP"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file && file.size > 512 * 1024 * 1024) {
                setSelectedFile(undefined);
                setFeedback({ kind: "error", message: "备份文件不能超过 512 MB" });
                event.target.value = "";
                return;
              }
              if (file) void inspectBackupFile(file);
              else {
                setSelectedFile(undefined);
                setFeedback(undefined);
              }
            }}
          />
          <div className="backup-restore-actions">
            <button className="secondary-button" disabled={Boolean(operation)} onClick={() => fileInputRef.current?.click()}>{operation === "inspect" ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}{operation === "inspect" ? "正在验证…" : "选择 ZIP"}</button>
            <button className="danger-confirm-button" disabled={!selectedFile || Boolean(operation)} onClick={() => void restoreBackup()}>
              {operation === "restore" && <LoaderCircle className="spin" size={15} />}{operation === "restore" ? "正在恢复…" : "恢复此备份"}
            </button>
          </div>
          {selectedFile && <small className="backup-selected-file"><FileArchive size={13} />{selectedFile.name}<span>{formatFileSize(selectedFile.size)}</span></small>}
        </article>
      </div>

      {feedback && <div className={`backup-feedback ${feedback.kind}`} role="status"><span>{feedback.message}</span><button aria-label="关闭提示" onClick={() => setFeedback(undefined)}><X size={13} /></button></div>}

      <div className="backup-notes">
        <ShieldCheck size={16} />
        <div><strong>备份 ZIP 不加密</strong><p>文件包含主密钥和账户连接信息，请只保存在你控制的设备或私人存储中。不要编辑 ZIP 内部文件。</p></div>
        <small>{status?.latestAutomaticBackupAt ? `最近的恢复前副本：${formatAccountTime(status.latestAutomaticBackupAt)}` : "尚未创建恢复前副本"}</small>
      </div>
    </section>
  );
}

type ConnectionState =
  | { readonly kind: "idle" }
  | { readonly kind: "testing" }
  | { readonly kind: "success"; readonly message: string; readonly latencyMs: number }
  | { readonly kind: "error"; readonly message: string };

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
  readonly latestSyncRun?: {
    readonly id: string;
    readonly status: "running" | "succeeded" | "failed";
    readonly foldersProcessed: number;
    readonly messagesProcessed: number;
    readonly errorMessage?: string;
    readonly startedAt: string;
    readonly finishedAt?: string;
  };
}

type AccountAction = "sync" | "pause" | "resume" | "edit" | "delete";

function MailAccountSettings({ onManageExchange }: { readonly onManageExchange: () => void }) {
  const [accounts, setAccounts] = useState<readonly SavedMailAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [syncIntervalMs, setSyncIntervalMs] = useState(3 * 60 * 1000);
  const [accountAction, setAccountAction] = useState<{ readonly id: string; readonly kind: AccountAction }>();
  const [accountFeedback, setAccountFeedback] = useState("");
  const [providerId, setProviderId] = useState("imap");
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("个人邮箱");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [editingAccountId, setEditingAccountId] = useState<string>();
  const [state, setState] = useState<ConnectionState>({ kind: "idle" });
  const [syncMode, setSyncMode] = useState<"quick" | "recommended" | "full">("recommended");
  const [saving, setSaving] = useState(false);

  async function loadAccounts() {
    if (!window.navigator.onLine) {
      setAccountsLoading(false);
      return;
    }
    try {
      const response = await fetch("/api/mail-accounts", { cache: "no-store" });
      const result = await response.json() as {
        readonly accounts?: readonly SavedMailAccount[];
        readonly scheduler?: { readonly intervalMs?: number };
      };
      if (!response.ok) throw new Error("无法读取邮箱账户");
      setAccounts(result.accounts ?? []);
      if (result.scheduler?.intervalMs) setSyncIntervalMs(result.scheduler.intervalMs);
    } catch (error) {
      setAccountFeedback(error instanceof Error ? error.message : "无法读取邮箱账户");
    } finally {
      setAccountsLoading(false);
    }
  }

  useEffect(() => {
    const updateOnlineState = () => {
      setOnline(window.navigator.onLine);
      if (window.navigator.onLine) void loadAccounts();
    };
    setOnline(window.navigator.onLine);
    void loadAccounts();
    const pollingTimer = window.setInterval(() => {
      if (window.navigator.onLine) void loadAccounts();
    }, 10_000);
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.clearInterval(pollingTimer);
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  async function performAccountAction(account: SavedMailAccount, kind: Exclude<AccountAction, "edit">) {
    if (kind === "delete" && !window.confirm(account.providerId === "exchange-ews"
      ? `移除“${account.displayName}”的邮件连接？\n\n本地邮件索引会被删除，日历连接和共享加密凭据将保留。`
      : `删除“${account.displayName}”？\n\n该账户的加密凭据、邮件索引和同步记录都会从本机删除。`)) return;
    setAccountAction({ id: account.id, kind });
    setAccountFeedback("");
    if (kind === "sync") {
      setAccounts((current) => current.map((item) => item.id === account.id ? { ...item, syncStatus: "syncing" } : item));
    }
    try {
      const response = await fetch(
        kind === "sync" ? `/api/mail-accounts/${account.id}/sync` : `/api/mail-accounts/${account.id}`,
        {
          method: kind === "delete" ? "DELETE" : kind === "sync" ? "POST" : "PATCH",
          headers: kind === "pause" || kind === "resume" ? { "content-type": "application/json" } : undefined,
          body: kind === "pause" || kind === "resume" ? JSON.stringify({ action: kind }) : undefined,
        },
      );
      const result = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly sync?: {
          readonly messagesProcessed?: number;
          readonly messagesReconciled?: number;
          readonly messagesRemoved?: number;
          readonly deepAuditRanges?: number;
        };
      };
      if (!response.ok || !result.ok) throw new Error(result.message ?? "账户操作失败");
      await loadAccounts();
      setAccountFeedback(
        kind === "delete" ? `已删除 ${account.displayName}`
          : kind === "pause" ? `已暂停 ${account.displayName}`
            : kind === "resume" ? `已启用 ${account.displayName}`
              : `${account.displayName} 同步完成：新增/回填 ${result.sync?.messagesProcessed ?? 0} 封，校正状态 ${result.sync?.messagesReconciled ?? 0} 封，移除失效索引 ${result.sync?.messagesRemoved ?? 0} 封${(result.sync?.deepAuditRanges ?? 0) > 0 ? `，深度核对 ${result.sync?.deepAuditRanges} 个旧邮件区间` : ""}`,
      );
    } catch (error) {
      await loadAccounts();
      setAccountFeedback(error instanceof Error ? error.message : "账户操作失败");
    } finally {
      setAccountAction(undefined);
    }
  }

  async function editAccount(account: SavedMailAccount) {
    if (account.providerId === "exchange-ews") {
      onManageExchange();
      return;
    }
    setAccountAction({ id: account.id, kind: "edit" });
    setAccountFeedback("");
    try {
      const response = await fetch(`/api/mail-accounts/${account.id}`, { cache: "no-store" });
      const result = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly settings?: {
          readonly imap: { readonly host: string; readonly port: number; readonly secure: boolean; readonly username: string };
          readonly smtp: { readonly host: string; readonly port: number; readonly secure: boolean; readonly username: string };
        };
      };
      if (!response.ok || !result.ok || !result.settings) throw new Error(result.message ?? "无法读取账户配置");
      setProviderId("imap");
      setDisplayName(account.displayName);
      setEmailAddress(account.emailAddress);
      setSyncMode(account.syncMode);
      setImapHost(result.settings.imap.host);
      setImapPort(String(result.settings.imap.port));
      setImapSecure(result.settings.imap.secure);
      setSmtpHost(result.settings.smtp.host);
      setSmtpPort(String(result.settings.smtp.port));
      setSmtpSecure(result.settings.smtp.secure);
      setUsername(result.settings.imap.username);
      setPassword("");
      setEditingAccountId(account.id);
      setState({ kind: "idle" });
      setAccountFeedback("配置已载入。密码留空将继续使用已加密保存的原密码；输入新密码才会替换。");
      document.getElementById("add-mail-account")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setAccountFeedback(error instanceof Error ? error.message : "无法读取账户配置");
    } finally {
      setAccountAction(undefined);
    }
  }

  async function testConnection() {
    setState({ kind: "testing" });
    try {
      const response = await fetch("/api/mail-accounts/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: editingAccountId,
          providerId,
          emailAddress,
          displayName,
          imap: providerId === "imap"
            ? { host: imapHost, port: Number(imapPort), secure: imapSecure, username, password }
            : undefined,
          smtp: providerId === "imap"
            ? { host: smtpHost, port: Number(smtpPort), secure: smtpSecure, username, password }
            : undefined,
        }),
      });
      const result = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly latencyMs?: number;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.message ?? "连接测试失败");
      }
      setState({
        kind: "success",
        message: result.message ?? "连接成功",
        latencyMs: result.latencyMs ?? 0,
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "连接测试失败",
      });
    }
  }

  const canTest = emailAddress.includes("@") &&
    (providerId !== "imap" || Boolean(imapHost && smtpHost && username && (password || editingAccountId)));

  async function saveAccount() {
    if (state.kind !== "success" || providerId !== "imap") return;
    setSaving(true);
    try {
      const response = await fetch("/api/mail-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: editingAccountId,
          providerId,
          displayName,
          emailAddress,
          syncMode,
          imap: { host: imapHost, port: Number(imapPort), secure: imapSecure, username, password },
          smtp: { host: smtpHost, port: Number(smtpPort), secure: smtpSecure, username, password },
        }),
      });
      const result = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly sync?: { readonly messagesProcessed?: number };
      };
      if (!response.ok || !result.ok) throw new Error(result.message ?? "账户保存失败");
      setPassword("");
      setState({
        kind: "success",
        message: `账户已保存，已同步 ${result.sync?.messagesProcessed ?? 0} 封邮件`,
        latencyMs: 0,
      });
      window.location.assign("/inbox");
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "账户保存失败" });
      setSaving(false);
    }
  }

  return (<div className="account-settings-stack">
    <section className="saved-accounts panel" aria-labelledby="saved-accounts-title">
      <div className="settings-section-heading">
        <div><h2 id="saved-accounts-title">已添加的邮箱</h2><p>查看连接健康状态、同步范围和最近一次成功同步。</p></div>
        <span className="step-badge">{accounts.length} 个账户</span>
      </div>
      {!online && (
        <div className="account-network-status" role="status">
          <WifiOff size={16} />
          <div><strong>当前处于离线状态</strong><span>已缓存的邮件仍可阅读；连接恢复后会自动刷新状态并继续后台同步。</span></div>
        </div>
      )}
      {accountsLoading ? (
        <div className="accounts-empty"><LoaderCircle className="spin" size={18} />正在读取账户…</div>
      ) : accounts.length === 0 ? (
        <div className="accounts-empty"><Mail size={20} /><div><strong>尚未添加真实邮箱</strong><span>完成上方连接测试并保存后，账户会显示在这里。</span></div></div>
      ) : (
        <div className="account-card-list">
          {accounts.map((account) => {
            const busy = accountAction?.id === account.id;
            const syncing = account.syncStatus === "syncing";
            return (
              <article className="saved-account-card" key={account.id}>
                <div className="saved-account-color" style={{ background: account.color }} />
                <div className="saved-account-main">
                  <div className="saved-account-title">
                    <div><strong>{account.displayName}</strong><span>{account.emailAddress}</span></div>
                    <span className={`sync-status sync-status-${account.syncStatus}`}>
                      {account.syncStatus === "syncing" && <LoaderCircle className="spin" size={12} />}
                      {accountStatusLabel(account.syncStatus)}
                    </span>
                  </div>
                  <div className="saved-account-meta">
                    <span>{account.providerId === "exchange-ews" ? "Exchange / EWS" : "IMAP / SMTP"}</span>
                    <span>{syncModeLabel(account.syncMode)}</span>
                    <span title={account.lastSyncAt ? formatAccountTime(account.lastSyncAt) : undefined}>
                      上次同步：{account.lastSyncAt ? formatAccountTime(account.lastSyncAt) : "尚未成功同步"}
                    </span>
                    <span>自动同步：每 {formatSyncInterval(syncIntervalMs)}</span>
                  </div>
                  {account.syncStatus === "syncing" && account.latestSyncRun?.status === "running" && (
                    <p className="account-sync-progress" aria-live="polite">
                      后台同步中 · 已完成 {account.latestSyncRun.foldersProcessed} 个文件夹 · 已索引 {account.latestSyncRun.messagesProcessed} 封邮件
                    </p>
                  )}
                  {account.syncError && <p className="account-sync-error">{account.syncError}</p>}
                  <div className="saved-account-actions">
                    <button className="secondary-button" disabled={!online || busy || account.syncStatus === "paused" || syncing} onClick={() => void performAccountAction(account, "sync")}>
                      {busy && accountAction?.kind === "sync" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}立即同步
                    </button>
                    <button className="ghost-button" disabled={busy || syncing} onClick={() => void editAccount(account)}><Pencil size={14} />{account.providerId === "exchange-ews" ? "管理 Exchange" : "重新配置"}</button>
                    <button className="ghost-button" disabled={busy || syncing} onClick={() => void performAccountAction(account, account.syncStatus === "paused" ? "resume" : "pause")}>
                      {account.syncStatus === "paused" ? <Play size={14} /> : <Pause size={14} />}{account.syncStatus === "paused" ? "启用" : "暂停"}
                    </button>
                    <button className="ghost-button danger-button" disabled={busy || syncing} onClick={() => void performAccountAction(account, "delete")}><Trash2 size={14} />删除</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {accountFeedback && <div className="account-feedback" aria-live="polite">{accountFeedback}</div>}
    </section>

    <section className="account-settings panel" id="add-mail-account">
      <div className="settings-section-heading">
        <div><h2>{editingAccountId ? "重新配置邮箱账户" : "添加邮箱账户"}</h2><p>{editingAccountId ? "密码留空时保留原密码，不会把已保存密码返回浏览器。" : "测试过程不保存密码、令牌或账户记录。"}</p></div>
        <span className="step-badge">1 · 测试连接</span>
      </div>
      <div className="provider-options" role="radiogroup" aria-label="邮箱类型">
        {[
          ["microsoft", "Microsoft 365", "Outlook / Exchange Online"],
          ["gmail", "Gmail", "Google Workspace"],
          ["imap", "IMAP / SMTP", "其他邮箱服务器"],
        ].map(([id, label, detail]) => (
          <button
            className={providerId === id ? "active" : ""}
            key={id}
            onClick={() => { setProviderId(id); setState({ kind: "idle" }); }}
            role="radio"
            aria-checked={providerId === id}
          >
            <strong>{label}</strong><span>{detail}</span>
          </button>
        ))}
      </div>
      <div className="account-form">
        <label><span>账户名称</span><input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setState({ kind: "idle" }); }} placeholder="例如：工作邮箱" /></label>
        <label><span>邮箱地址</span><input type="email" value={emailAddress} onChange={(event) => { setEmailAddress(event.target.value); setState({ kind: "idle" }); }} placeholder="name@example.com" /></label>
        {providerId === "imap" && <>
          <label><span>IMAP 服务器</span><input value={imapHost} onChange={(event) => { setImapHost(event.target.value); setState({ kind: "idle" }); }} placeholder="imap.example.com" /></label>
          <label><span>端口</span><input inputMode="numeric" value={imapPort} onChange={(event) => { setImapPort(event.target.value); setState({ kind: "idle" }); }} /></label>
          <label><span>SMTP 服务器</span><input value={smtpHost} onChange={(event) => { setSmtpHost(event.target.value); setState({ kind: "idle" }); }} placeholder="smtp.example.com" /></label>
          <label><span>端口</span><input inputMode="numeric" value={smtpPort} onChange={(event) => { setSmtpPort(event.target.value); setState({ kind: "idle" }); }} /></label>
          <label><span>用户名</span><input value={username} onChange={(event) => { setUsername(event.target.value); setState({ kind: "idle" }); }} autoComplete="username" /></label>
          <label><span>密码或应用专用密码</span><input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setState({ kind: "idle" }); }} autoComplete="new-password" placeholder={editingAccountId ? "留空则保留原密码" : undefined} /></label>
          <label className="secure-toggle"><input type="checkbox" checked={imapSecure} onChange={(event) => { setImapSecure(event.target.checked); setState({ kind: "idle" }); }} /><span>IMAP 使用直接 TLS（通常为 993）</span></label>
          <label className="secure-toggle"><input type="checkbox" checked={smtpSecure} onChange={(event) => { setSmtpSecure(event.target.checked); setState({ kind: "idle" }); }} /><span>SMTP 使用直接 TLS（通常为 465；587 请取消）</span></label>
        </>}
      </div>
      {providerId !== "imap" && (
        <div className="oauth-notice"><ShieldCheck size={18} /><div><strong>使用 OAuth 授权</strong><p>不会要求输入邮箱密码。真实连接器接入后，将先授权再执行测试。</p></div></div>
      )}
      {providerId === "imap" && (
        <div className="sync-mode-picker">
          <span>{editingAccountId ? "同步范围" : "首次同步范围"}</span>
          <div>
            {([
              ["quick", "快速", "最近 30 天"],
              ["recommended", "推荐", "最近 90 天"],
              ["full", "完整", "后台补齐全部"],
            ] as const).map(([id, label, detail]) => (
              <button className={syncMode === id ? "active" : ""} key={id} onClick={() => { setSyncMode(id); setState({ kind: "idle" }); }}>
                <strong>{label}</strong><small>{detail}</small>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={`connection-result result-${state.kind}`} aria-live="polite">
        {state.kind === "idle" && <><Circle size={17} /><span>尚未测试。测试成功后才可保存账户。</span></>}
        {state.kind === "testing" && <><LoaderCircle className="spin" size={17} /><span>正在验证身份和读取权限…</span></>}
        {state.kind === "success" && <><CheckCircle2 size={17} /><span>{state.message} · {state.latencyMs} ms</span></>}
        {state.kind === "error" && <><X size={17} /><span>{state.message}</span></>}
      </div>
      <footer className="settings-actions">
        <button className="secondary-button test-button" disabled={!online || !canTest || state.kind === "testing"} onClick={testConnection}>
          {state.kind === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}测试连接
        </button>
        <button className="primary-button" disabled={!online || state.kind !== "success" || providerId !== "imap" || saving} onClick={saveAccount}>
          {saving && <LoaderCircle className="spin" size={16} />}{saving ? "正在保存和同步…" : "保存并开始同步"}
        </button>
      </footer>
      <p className="settings-footnote">IMAP/SMTP 会执行真实登录与只读邮箱列表、SMTP 握手验证；Exchange / RWTH 邮箱与日历使用同一个 EWS 连接，并在“日历”标签统一管理。Microsoft 365 和 Gmail API 将在后续连接器中接入。</p>
    </section>
  </div>);
}

interface SavedCalendarAccount {
  readonly id: string;
  readonly providerId: "caldav" | "ics" | "exchange";
  readonly displayName: string;
  readonly serverUrl: string;
  readonly username: string;
  readonly emailAddress?: string;
  readonly color: string;
  readonly syncStatus: AccountSyncStatus;
  readonly syncError?: string;
  readonly lastSyncAt?: string;
  readonly calendarsCount: number;
  readonly mailEnabled: boolean;
  readonly calendarEnabled: boolean;
  readonly mailSyncStatus?: AccountSyncStatus;
  readonly mailSyncError?: string;
  readonly mailLastSyncAt?: string;
  readonly mailHistoryFoldersComplete: number;
  readonly mailHistoryFoldersTotal: number;
}

const calendarAccountColors = ["#86bdf5", "#f0a05e", "#9dd5ae", "#c7a6f2", "#f28f9a", "#f2c55c", "#70c9c3"] as const;

function CalendarAccountSettings() {
  const [accounts, setAccounts] = useState<readonly SavedCalendarAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [providerId, setProviderId] = useState<"caldav" | "ics" | "exchange">("caldav");
  const [displayName, setDisplayName] = useState("个人日历");
  const [serverUrl, setServerUrl] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [username, setUsername] = useState("");
  const [exchangeEmailAddress, setExchangeEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<ConnectionState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [accountAction, setAccountAction] = useState<{ readonly id: string; readonly kind: "sync" | "delete" | "update" }>();
  const [editingAccount, setEditingAccount] = useState<{ readonly id: string; readonly displayName: string; readonly color: string; readonly emailAddress: string; readonly mailEnabled: boolean; readonly calendarEnabled: boolean }>();
  const [feedback, setFeedback] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const response = await fetch("/api/calendar-accounts", { cache: "no-store" });
      const payload = await response.json() as { readonly accounts?: readonly SavedCalendarAccount[]; readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "无法读取日历账户");
      setAccounts(payload.accounts ?? []);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取日历账户");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  const resetTest = () => setState({ kind: "idle" });
  const canTest = Boolean(displayName.trim() && (providerId === "ics"
    ? /^(?:https|webcal):\/\//i.test(feedUrl.trim())
    : /^https:\/\//i.test(serverUrl.trim()) && username.trim() && password && (providerId !== "exchange" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(exchangeEmailAddress.trim()))));

  const testConnection = async () => {
    setState({ kind: "testing" });
    try {
      const response = await fetch("/api/calendar-accounts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, displayName, serverUrl, feedUrl, username, password, emailAddress: exchangeEmailAddress }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string; readonly latencyMs?: number };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "日历连接测试失败");
      setState({ kind: "success", message: payload.message || "日历连接成功", latencyMs: payload.latencyMs ?? 0 });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "日历连接测试失败" });
    }
  };

  const saveAccount = async () => {
    if (state.kind !== "success" || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/calendar-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, displayName, serverUrl, feedUrl, username, password, emailAddress: exchangeEmailAddress }),
      });
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly sync?: { readonly calendarsProcessed?: number; readonly eventsProcessed?: number };
        readonly mailSync?: { readonly foldersProcessed?: number; readonly messagesProcessed?: number };
      };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "无法保存日历账户");
      setPassword("");
      if (providerId === "ics") setFeedUrl("");
      setState({
        kind: "success",
        message: providerId === "exchange"
          ? `Exchange 账户已保存：${payload.sync?.eventsProcessed ?? 0} 项日程、${payload.mailSync?.messagesProcessed ?? 0} 封邮件`
          : `账户已保存，读取 ${payload.sync?.calendarsProcessed ?? 0} 个日历、${payload.sync?.eventsProcessed ?? 0} 项日程`,
        latencyMs: 0,
      });
      await loadAccounts();
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "无法保存日历账户" });
    } finally {
      setSaving(false);
    }
  };

  const performAction = async (account: SavedCalendarAccount, kind: "sync" | "delete") => {
    if (kind === "delete" && !window.confirm(`删除“${account.displayName}”？\n\n加密凭据和已同步的本地日历索引将从本机删除，远端日历不会受到影响。`)) return;
    setAccountAction({ id: account.id, kind });
    setFeedback("");
    try {
      const response = await fetch(
        kind === "sync" ? `/api/calendar-accounts/${encodeURIComponent(account.id)}/sync` : `/api/calendar-accounts/${encodeURIComponent(account.id)}`,
        { method: kind === "sync" ? "POST" : "DELETE" },
      );
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly sync?: { readonly calendarsProcessed?: number; readonly eventsProcessed?: number };
      };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "日历账户操作失败");
      await loadAccounts();
      setFeedback(kind === "delete"
        ? `已删除 ${account.displayName} 的本地连接，远端数据未修改`
        : `${account.displayName} 同步完成：${payload.sync?.calendarsProcessed ?? 0} 个日历、${payload.sync?.eventsProcessed ?? 0} 项日程`);
    } catch (error) {
      await loadAccounts();
      setFeedback(error instanceof Error ? error.message : "日历账户操作失败");
    } finally {
      setAccountAction(undefined);
    }
  };

  const saveAccountSettings = async () => {
    if (!editingAccount?.displayName.trim()) return;
    setAccountAction({ id: editingAccount.id, kind: "update" });
    setFeedback("");
    try {
      const response = await fetch(`/api/calendar-accounts/${encodeURIComponent(editingAccount.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: editingAccount.displayName.trim(),
          color: editingAccount.color,
          emailAddress: editingAccount.emailAddress,
          mailEnabled: editingAccount.mailEnabled,
          calendarEnabled: editingAccount.calendarEnabled,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "无法保存日历账户设置");
      const savedName = editingAccount.displayName.trim();
      setEditingAccount(undefined);
      await loadAccounts();
      setFeedback(`已更新 ${savedName} 的名称和日历颜色`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存日历账户设置");
    } finally {
      setAccountAction(undefined);
    }
  };

  return (
    <section className="calendar-account-settings panel" aria-labelledby="calendar-accounts-title">
      <div className="settings-section-heading">
        <div><h2 id="calendar-accounts-title">添加日历连接</h2><p>支持 CalDAV、Exchange / RWTH 和只读 ICS；Exchange 会将邮件与日历绑定为同一个账户。</p></div>
        <span className="step-badge">安全同步</span>
      </div>
      <div className="calendar-account-layout">
        <div className="calendar-provider-options" role="radiogroup" aria-label="日历连接类型">
          <button className={providerId === "caldav" ? "active" : ""} role="radio" aria-checked={providerId === "caldav"} onClick={() => { setProviderId("caldav"); resetTest(); }}>
            <strong>CalDAV 账户</strong><span>服务器、用户名与密码</span>
          </button>
          <button className={providerId === "exchange" ? "active" : ""} role="radio" aria-checked={providerId === "exchange"} onClick={() => { setProviderId("exchange"); setServerUrl("https://mail.rwth-aachen.de/EWS/Exchange.asmx"); resetTest(); }}>
            <strong>Exchange / RWTH</strong><span>一个账户连接邮件与日历</span>
          </button>
          <button className={providerId === "ics" ? "active" : ""} role="radio" aria-checked={providerId === "ics"} onClick={() => { setProviderId("ics"); resetTest(); }}>
            <strong>ICS 链接订阅</strong><span>Outlook、学校或公开日历</span>
          </button>
        </div>
        <div className="calendar-account-form">
          <label><span>账户名称</span><input value={displayName} onChange={(event) => { setDisplayName(event.target.value); resetTest(); }} placeholder="例如：工作日历" /></label>
          {providerId === "ics" ? (
            <label><span>ICS 订阅链接</span><input type="url" value={feedUrl} onChange={(event) => { setFeedUrl(event.target.value); resetTest(); }} placeholder="https://example.com/calendar.ics" autoComplete="off" /></label>
          ) : <>
            <label><span>{providerId === "exchange" ? "Exchange EWS 服务地址" : "CalDAV 服务器地址"}</span><input type="url" value={serverUrl} onChange={(event) => { setServerUrl(event.target.value); resetTest(); }} placeholder={providerId === "exchange" ? "https://mail.rwth-aachen.de/EWS/Exchange.asmx" : "https://calendar.example.com/dav/"} /></label>
            <label><span>{providerId === "exchange" ? "RWTH-E-Mail 用户名" : "用户名"}</span><input value={username} onChange={(event) => { setUsername(event.target.value); resetTest(); }} placeholder={providerId === "exchange" ? "ab123456@rwth-aachen.de" : undefined} autoComplete="username" /></label>
            {providerId === "exchange" && <label><span>正式邮箱地址（发件/收件）</span><input type="email" value={exchangeEmailAddress} onChange={(event) => { setExchangeEmailAddress(event.target.value); resetTest(); }} placeholder="name@institute.rwth-aachen.de" autoComplete="email" /></label>}
            <label><span>{providerId === "exchange" ? "RWTH-E-Mail 密码" : "密码或应用专用密码"}</span><input type="password" value={password} onChange={(event) => { setPassword(event.target.value); resetTest(); }} autoComplete="current-password" /></label>
          </>}
        </div>
        <div className={`connection-result result-${state.kind}`} aria-live="polite">
          {state.kind === "idle" && <><Circle size={17} /><span>尚未测试。测试只读取账户能力，不会创建、发送或修改远端内容。</span></>}
          {state.kind === "testing" && <><LoaderCircle className="spin" size={17} /><span>{providerId === "ics" ? "正在下载并验证 ICS 日历…" : providerId === "exchange" ? "正在验证 Exchange 邮箱和默认日历权限…" : "正在验证 CalDAV 身份和日历读取权限…"}</span></>}
          {state.kind === "success" && <><CheckCircle2 size={17} /><span>{state.message}{state.latencyMs ? ` · ${state.latencyMs} ms` : ""}</span></>}
          {state.kind === "error" && <><X size={17} /><span>{state.message}</span></>}
        </div>
        <div className="settings-actions">
          <button className="secondary-button test-button" disabled={!canTest || state.kind === "testing"} onClick={() => void testConnection()}>
            {state.kind === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}测试连接
          </button>
          <button className="primary-button" disabled={state.kind !== "success" || saving} onClick={() => void saveAccount()}>
            {saving && <LoaderCircle className="spin" size={16} />}{saving ? "正在保存和同步…" : "保存并同步"}
          </button>
        </div>
      </div>

      <div className="calendar-account-list">
        <div className="calendar-account-list-heading"><strong>已连接的日历账户</strong><span>{accounts.length} 个</span></div>
        {loading ? (
          <div className="accounts-empty"><LoaderCircle className="spin" size={18} />正在读取日历账户…</div>
        ) : accounts.length === 0 ? (
          <div className="accounts-empty"><CalendarDays size={20} /><div><strong>尚未连接远端日历</strong><span>测试成功并保存后，远端日历会出现在周/月视图。</span></div></div>
        ) : accounts.map((account) => {
          const busy = accountAction?.id === account.id;
          const isEditing = editingAccount?.id === account.id;
          return (
            <article className="saved-account-card" key={account.id}>
              <div className="saved-account-color" style={{ background: isEditing ? editingAccount.color : account.color }} />
              <div className="saved-account-main">
                <div className="saved-account-title">
                  <div><strong>{account.displayName}</strong><span>{account.providerId === "ics" ? "链接订阅" : account.providerId === "exchange" ? `${account.emailAddress || account.username} · 登录：${account.username}` : account.username}</span></div>
                  <span className={`sync-status sync-status-${account.syncStatus}`}>{account.syncStatus === "syncing" && <LoaderCircle className="spin" size={12} />}{accountStatusLabel(account.syncStatus)}</span>
                </div>
                <div className="saved-account-meta"><span>{account.providerId === "ics" ? "ICS 订阅 · 只读" : account.providerId === "exchange" ? `Exchange / RWTH · ${[account.mailEnabled && "邮件", account.calendarEnabled && "日历"].filter(Boolean).join(" + ") || "已暂停"}` : "CalDAV · 只读"}</span><span>{account.calendarsCount} 个日历</span><span>上次同步：{account.lastSyncAt ? formatAccountTime(account.lastSyncAt) : "尚未同步"}</span></div>
                {account.providerId === "exchange" && account.mailEnabled && (
                  <div className="saved-account-meta">
                    <span>邮件：{accountStatusLabel(account.mailSyncStatus ?? "idle")}</span>
                    <span>历史补齐：{account.mailHistoryFoldersComplete}/{account.mailHistoryFoldersTotal || 5} 个文件夹</span>
                    <span>邮件同步：{account.mailLastSyncAt ? formatAccountTime(account.mailLastSyncAt) : "尚未同步"}</span>
                  </div>
                )}
                <small className="calendar-server-url" title={account.serverUrl}>{account.serverUrl}</small>
                {account.syncError && <p className="account-sync-error">{account.syncError}</p>}
                {isEditing && (
                  <div className="calendar-account-editor">
                    <label><span>账户名称</span><input value={editingAccount.displayName} maxLength={80} onChange={(event) => setEditingAccount({ ...editingAccount, displayName: event.target.value })} /></label>
                    {account.providerId === "exchange" && <label><span>正式邮箱地址</span><input type="email" value={editingAccount.emailAddress} onChange={(event) => setEditingAccount({ ...editingAccount, emailAddress: event.target.value })} /></label>}
                    <fieldset>
                      <legend>日历颜色</legend>
                      <div className="calendar-color-options">
                        {calendarAccountColors.map((color) => (
                          <button
                            type="button"
                            key={color}
                            className={editingAccount.color === color ? "active" : ""}
                            style={{ background: color }}
                            aria-label={`选择颜色 ${color}`}
                            aria-pressed={editingAccount.color === color}
                            onClick={() => setEditingAccount({ ...editingAccount, color })}
                          >{editingAccount.color === color && <Check size={13} />}</button>
                        ))}
                        <label className="calendar-custom-color" title="自定义颜色">
                          <input type="color" value={editingAccount.color} aria-label="选择自定义颜色" onChange={(event) => setEditingAccount({ ...editingAccount, color: event.target.value })} />
                          <span>自定义</span>
                        </label>
                      </div>
                    </fieldset>
                    {account.providerId === "exchange" && <fieldset>
                      <legend>Exchange 功能</legend>
                      <div className="calendar-exchange-feature-toggles">
                        <label><input type="checkbox" checked={editingAccount.mailEnabled} onChange={(event) => setEditingAccount({ ...editingAccount, mailEnabled: event.target.checked })} /><span>邮件同步</span></label>
                        <label><input type="checkbox" checked={editingAccount.calendarEnabled} onChange={(event) => setEditingAccount({ ...editingAccount, calendarEnabled: event.target.checked })} /><span>日历同步</span></label>
                      </div>
                    </fieldset>}
                  </div>
                )}
                <div className="saved-account-actions">
                  {isEditing ? <>
                    <button className="primary-button" disabled={busy || !editingAccount.displayName.trim() || (account.providerId === "exchange" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editingAccount.emailAddress))} onClick={() => void saveAccountSettings()}>{busy && accountAction?.kind === "update" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存</button>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditingAccount(undefined)}>取消</button>
                  </> : <>
                    <button className="secondary-button" disabled={busy} onClick={() => void performAction(account, "sync")}>{busy && accountAction?.kind === "sync" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}立即同步</button>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditingAccount({ id: account.id, displayName: account.displayName, color: account.color, emailAddress: account.emailAddress || account.username, mailEnabled: account.mailEnabled, calendarEnabled: account.calendarEnabled })}><Pencil size={14} />编辑</button>
                    <button className="ghost-button danger-button" disabled={busy} onClick={() => void performAction(account, "delete")}><Trash2 size={14} />删除本地连接</button>
                  </>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {feedback && <div className="account-feedback" aria-live="polite">{feedback}</div>}
      <p className="settings-footnote">CalDAV 和 ICS 当前保持只读；Exchange / RWTH 使用一份加密凭据连接邮件与日历，两类数据分别同步。普通个人日程支持安全写回，会议邀请与重复日程仍受保护。地址必须使用 HTTPS；密码和包含访问令牌的 ICS 完整链接会使用 AES-256-GCM 加密，不会返回浏览器或写入日志。</p>
    </section>
  );
}

function accountStatusLabel(status: AccountSyncStatus): string {
  return { idle: "待同步", syncing: "同步中", ready: "正常", error: "需要处理", paused: "已暂停" }[status];
}

function syncModeLabel(mode: AccountSyncMode): string {
  return { quick: "最近 30 天", recommended: "最近 90 天", full: "完整历史" }[mode];
}

function formatAccountTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSyncInterval(intervalMs: number): string {
  const minutes = Math.max(1, Math.round(intervalMs / 60_000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.round(minutes / 60)} 小时`;
}

interface TodayEventItem {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly calendarName: string;
  readonly calendarColor: string;
  readonly href: string;
}

interface TodayTaskItem {
  readonly id: string;
  readonly title: string;
  readonly notes?: string;
  readonly status: "inbox" | "next" | "waiting" | "someday";
  readonly important: boolean;
  readonly urgencyMode: "auto" | "urgent" | "not_urgent";
  readonly isUrgent: boolean;
  readonly dueAt?: string;
  readonly estimatedMinutes?: number;
  readonly projectName?: string;
  readonly areaName?: string;
  readonly sourceReferences: readonly { readonly id: string; readonly kind: "mail" | "calendar" | "note"; readonly sourceId: string; readonly label: string; readonly href?: string }[];
  readonly attention: "overdue" | "today" | "urgent";
  readonly href: string;
}

interface TodayMailItem {
  readonly id: string;
  readonly subject: string;
  readonly senderName: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly receivedAt: string;
  readonly isStarred: boolean;
  readonly href: string;
}

interface TodaySnapshot {
  readonly from: string;
  readonly to: string;
  readonly events: readonly TodayEventItem[];
  readonly tasks: readonly TodayTaskItem[];
  readonly unreadMail: readonly TodayMailItem[];
  readonly totals: { readonly events: number; readonly tasks: number; readonly unreadMail: number };
}

function TodayPage() {
  const [snapshot, setSnapshot] = useState<TodaySnapshot>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [busyTaskId, setBusyTaskId] = useState<string>();
  const [feedback, setFeedback] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    setFeedback(undefined);
    setState("loading");
    void fetchWithTimeout(`/api/today?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { readonly ok?: boolean; readonly snapshot?: TodaySnapshot; readonly message?: string };
        if (!response.ok || !payload.ok || !payload.snapshot) throw new Error(payload.message ?? "无法读取 Today 数据");
        setSnapshot(payload.snapshot);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFeedback(error instanceof Error ? error.message : "无法读取 Today 数据");
        setState("error");
      });
    return () => controller.abort();
  }, [retry]);

  const completeTask = async (task: TodayTaskItem) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: task.title,
          notes: task.notes,
          status: "done",
          important: task.important,
          urgencyMode: task.urgencyMode,
          dueAt: task.dueAt,
          estimatedMinutes: task.estimatedMinutes,
          projectName: task.projectName,
          areaName: task.areaName,
          sourceReferences: task.sourceReferences.map(({ kind, sourceId, label, href }) => ({ kind, sourceId, label, href })),
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法完成任务");
      setSnapshot((current) => current ? {
        ...current,
        tasks: current.tasks.filter((entry) => entry.id !== task.id),
        totals: { ...current.totals, tasks: Math.max(0, current.totals.tasks - 1) },
      } : current);
      setFeedback("任务已完成");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法完成任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  if (state === "loading") return <div className="today-loading panel"><LoaderCircle className="spin" size={19} />正在汇总今天的数据…</div>;
  if (state === "error" || !snapshot) return <div className="today-loading panel"><AlertCircle size={19} /><span>{feedback ?? "无法读取 Today 数据"}</span><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重试</button></div>;

  return (
    <>
      <div className="today-summary-strip">
        <time>{formatTodayDate(snapshot.from)}</time>
        <span><CalendarDays size={14} />{snapshot.totals.events} 项日程</span>
        <span><ListChecks size={14} />{snapshot.totals.tasks} 项需推进</span>
        <span><Mail size={14} />{snapshot.totals.unreadMail} 封未读</span>
      </div>
      {feedback && <div className="today-feedback" role="status">{feedback}<button aria-label="关闭提示" onClick={() => setFeedback(undefined)}><X size={12} /></button></div>}
      <div className="today-layout">
        <section className="panel schedule-panel">
          <h2><Clock3 size={19} />今日安排 <small>{snapshot.events.length}</small></h2>
          {snapshot.events.length ? <div className="timeline">{snapshot.events.map((event) => <TimelineEvent event={event} key={event.id} />)}</div>
            : <TodayEmpty icon={<CalendarDays size={20} />} text="今天没有日程安排" />}
        </section>
        <div className="today-side">
          <section className="panel compact-panel">
            <h2><ListChecks size={19} />需要推进 <small>{snapshot.totals.tasks}</small></h2>
            {snapshot.tasks.length ? snapshot.tasks.map((task) => <TaskRow task={task} busy={busyTaskId === task.id} onComplete={() => void completeTask(task)} key={task.id} />)
              : <TodayEmpty icon={<CheckCircle2 size={20} />} text="今天没有到期或紧急任务" />}
          </section>
          <section className="panel reply-panel">
            <h2><Mail size={18} />未读邮件 <small>{snapshot.totals.unreadMail}</small></h2>
            {snapshot.unreadMail.length ? <div className="today-mail-list">{snapshot.unreadMail.map((message) => <Link href={message.href} key={message.id}>
              <i style={{ background: message.accountColor }} />
              <span><strong>{message.subject}</strong><small>{message.senderName} · {message.accountName}</small></span>
              {message.isStarred ? <Star size={13} fill="currentColor" /> : <time>{formatTodayMailTime(message.receivedAt)}</time>}
            </Link>)}</div> : <TodayEmpty icon={<Mail size={20} />} text="收件箱没有未读邮件" />}
          </section>
        </div>
      </div>
    </>
  );
}

function TimelineEvent({ event }: { readonly event: TodayEventItem }) {
  return (
    <div className="timeline-row">
      <time>{event.allDay ? "全天" : formatTodayClock(event.start)}</time>
      <Link className="event-card event-blue" href={event.href}>
        <div><strong>{event.title}</strong><span>{event.calendarName} · {formatTodayEventDuration(event)}</span></div>
        <i className="event-dot" style={{ background: event.calendarColor }} />
      </Link>
    </div>
  );
}

function TaskRow({ task, busy, onComplete }: { readonly task: TodayTaskItem; readonly busy: boolean; readonly onComplete: () => void }) {
  return (
    <div className="task-row">
      <button className="checkbox" aria-label={`完成 ${task.title}`} disabled={busy} onClick={onComplete}>{busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}</button>
      <Link href={task.href}><strong>{task.title}</strong><span>{todayTaskAttentionLabel(task)}{task.projectName ? ` · ${task.projectName}` : ""}</span></Link>
      <b>{task.dueAt ? formatTodayTaskDue(task.dueAt) : "紧急"}</b>
    </div>
  );
}

function TodayEmpty({ icon, text }: { readonly icon: ReactNode; readonly text: string }) {
  return <div className="today-empty">{icon}<span>{text}</span></div>;
}

function formatTodayDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date(value));
}

function formatTodayClock(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatTodayEventDuration(event: TodayEventItem): string {
  if (event.allDay) return "全天";
  const minutes = Math.max(0, Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000));
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function todayTaskAttentionLabel(task: TodayTaskItem): string {
  return task.attention === "overdue" ? "已逾期" : task.attention === "today" ? "今天到期" : "需要立即推进";
}

function formatTodayTaskDue(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date < now) return "逾期";
  return formatTodayClock(value);
}

function formatTodayMailTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? formatTodayClock(value)
    : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

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

function InboxPage({ initialMessageId, initialFolderId }: { readonly initialMessageId?: string; readonly initialFolderId?: string }) {
  const [remoteItems, setRemoteItems] = useState<readonly InboxDisplayItem[] | null>(null);
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
      fetch("/api/mail-accounts", { cache: "no-store" }).then(async (response) => {
        const payload = await response.json() as { readonly accounts?: readonly SavedMailAccount[] };
        if (!response.ok) throw new Error("无法读取邮箱账户");
        return payload.accounts ?? [];
      }),
      fetch("/api/mail-drafts", { cache: "no-store" }).then(async (response) => {
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
    setSelectedId(initialMessageId ?? "");
    setMobileMailDetail(Boolean(initialMessageId));
    const inboxUrl = initialFolderId ? `/api/inbox?folder=${encodeURIComponent(initialFolderId)}` : "/api/inbox";
    void fetch(inboxUrl, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as {
          readonly hasAccounts?: boolean;
          readonly message?: string;
          readonly folder?: { readonly name: string; readonly role: string; readonly accountName: string };
          readonly items?: readonly {
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
          }[];
        };
        if (!response.ok) throw new Error(payload.message || "Inbox request failed");
        return payload;
      })
      .then(async (result) => {
        if (cancelled) return;
        const mapped = (result.items ?? []).map((item) => ({
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
        setHasAccounts(Boolean(result.hasAccounts));
        setMailboxLabel(result.folder ? `${result.folder.accountName} / ${mailFolderLabel({ ...result.folder, id: "", accountId: "" })}` : "统一收件箱");
        setMailLoadError(undefined);
        setRemoteItems(mapped);
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
      setMailNotice("已重新从服务器读取并更新本地缓存");
    } catch (error) {
      setMailNotice(`${error instanceof Error ? error.message : "无法重新读取邮件正文"}；继续显示原本地缓存`);
    } finally {
      setBodyRefreshBusyId(undefined);
    }
  };

  useEffect(() => {
    if (!mailNotice) return;
    const timer = window.setTimeout(() => setMailNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [mailNotice]);

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
        </div>
      </section>
      {selected ? <article className="message-detail" ref={messageDetailRef}>
        <header>
          <button className="mobile-detail-back" aria-label="返回邮件列表" onClick={() => setMobileMailDetail(false)}><ChevronLeft size={20} /></button>
          <div className="sender-avatar">{selected.sender.slice(0, 1).toLocaleUpperCase()}</div>
          <div><span className="sender-line"><i className="account-dot" style={{ background: selected.accountColor }} />{selected.accountName}</span><h2>{selected.subject}</h2><p>{selected.sender} &lt;{selected.senderAddress}&gt; · {selected.time}</p></div>
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
        <div className="message-related-content"><RelatedContentPanel kind="mail" entityId={selected.id} refreshKey={mailRelatedVersion} hideWhenEmpty /></div>
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
                <button className="thread-message-toggle" aria-expanded={expanded} onClick={() => setExpandedThreadMessages((current) => {
                  const next = new Set(current);
                  if (next.has(threadMessage.id)) next.delete(threadMessage.id); else next.add(threadMessage.id);
                  return next;
                })}>
                  <span className="thread-avatar" style={{ background: mailSenderAvatarColor(threadMessage.senderAddress, threadMessage.senderName) }}>{threadMessage.senderName.slice(0, 1).toLocaleUpperCase()}</span>
                  <span className="thread-message-summary"><strong>{threadMessage.senderName}</strong><small>{threadMessage.folderRole === "sent" ? "已发送" : `发送给 ${threadMessage.to.map((item) => item.name || item.address).join(", ") || "我"}`}</small>{!expanded && <em>{threadMessage.snippet || "正文将在展开时读取"}</em>}</span>
                  <span className="thread-message-meta">{digitallySigned && <span className="smime-signature-badge" role="img" aria-label="数字签名邮件" title="数字签名邮件"><Award size={13} aria-hidden="true" /></span>}{threadMessage.isStarred && <Star size={12} fill="currentColor" />}{body?.status === "ready" && <span className="thread-cache-state"><ShieldCheck size={12} />{body.cached ? "本地缓存" : "已安全读取并缓存"}</span>}<time>{formatMailTime(threadMessage.receivedAt)}</time><ChevronDown size={15} /></span>
                </button>
                {expanded && <div className="thread-message-content">
                  {body?.status === "ready" && <div className="thread-message-content-actions"><button className="ghost-button" disabled={Boolean(bodyRefreshBusyId)} onClick={() => void refreshMessageBody(threadMessage.id)}>{bodyRefreshBusyId === threadMessage.id ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}重新从服务器读取</button></div>}
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
    {mailNotice && <div className="mail-toast" role="status" data-testid="mail-action-notice">{mailNotice}</div>}
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

interface CalendarListItem {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: { readonly providerId?: string };
}

type RelatedEntityKind = "mail" | "calendar" | "task" | "note" | "project";

interface RelatedEntityItem {
  readonly linkId: string;
  readonly kind: RelatedEntityKind;
  readonly entityId: string;
  readonly title: string;
  readonly meta: string;
  readonly href: string;
  readonly relation: string;
  readonly direction: "source" | "target";
}

function RelatedContentPanel({
  kind,
  entityId,
  refreshKey = 0,
  hideHeading = false,
  hideWhenEmpty = false,
  emptyText = "还没有相关内容。",
}: {
  readonly kind: RelatedEntityKind;
  readonly entityId: string;
  readonly refreshKey?: number;
  readonly hideHeading?: boolean;
  readonly hideWhenEmpty?: boolean;
  readonly emptyText?: string;
}) {
  const [items, setItems] = useState<readonly RelatedEntityItem[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    void fetch(`/api/entity-links?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(entityId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { readonly ok?: boolean; readonly related?: readonly RelatedEntityItem[]; readonly message?: string };
        if (!response.ok || !payload.ok || !payload.related) throw new Error(payload.message ?? "无法读取相关内容");
        setItems(payload.related);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState("error");
        console.error("Related content loading failed", error);
      });
    return () => controller.abort();
  }, [entityId, kind, refreshKey]);

  if (hideWhenEmpty && (state === "loading" || (state === "ready" && items.length === 0))) return null;

  return (
    <section className={`related-content ${hideHeading ? "related-content-embedded" : ""}`} aria-label="相关内容">
      {!hideHeading && <header><span><Link2 size={14} />相关内容</span>{state === "ready" && items.length > 0 && <small>{items.length}</small>}</header>}
      {state === "loading" ? <p><LoaderCircle className="spin" size={13} />正在读取关联…</p>
        : state === "error" ? <p className="related-content-error"><AlertCircle size={13} />暂时无法读取相关内容</p>
          : items.length ? <div className="related-content-list">{items.map((item) => <Link href={item.href} key={item.linkId}>
            <RelatedEntityIcon kind={item.kind} />
            <span><strong>{item.title}</strong><small>{relationLabel(item)} · {item.meta}</small></span>
            <span>打开</span>
          </Link>)}</div>
            : <p>{emptyText}</p>}
    </section>
  );
}

function RelatedEntityIcon({ kind }: { readonly kind: RelatedEntityKind }) {
  const Icon = kind === "mail" ? Mail
    : kind === "calendar" ? CalendarDays
      : kind === "task" ? ListChecks
        : kind === "note" ? NotebookPen
          : FolderPlus;
  return <Icon size={15} />;
}

function relationLabel(item: RelatedEntityItem): string {
  if (item.relation === "meeting-note") return item.kind === "note" ? "会议笔记" : "对应日程";
  if (item.relation === "preparation") return item.kind === "task" ? "准备任务" : "准备事项来源";
  if (item.relation === "follow-up") return item.kind === "task" ? "跟进任务" : "跟进事项来源";
  if (item.relation === "scheduled") return item.kind === "calendar" ? "安排时间" : "对应任务";
  if (item.relation === "derived-task") return item.kind === "task" ? "生成的任务" : "任务来源";
  return "相关";
}

async function createClientEntityLink(input: {
  readonly sourceKind: RelatedEntityKind;
  readonly sourceId: string;
  readonly targetKind: RelatedEntityKind;
  readonly targetId: string;
  readonly relation: string;
}) {
  const response = await fetch("/api/entity-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法建立对象关联");
}

interface CalendarViewEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone?: string;
  readonly allDay: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly providerData?: {
    readonly providerId?: string;
    readonly itemId?: string;
    readonly changeKey?: string;
    readonly isMeeting?: boolean;
    readonly isRecurring?: boolean;
    readonly isOrganizer?: boolean;
  };
  readonly attendees?: readonly { readonly address: string; readonly name?: string }[];
  readonly meetingUrl?: string;
  readonly linkedTask?: { readonly id: string; readonly title: string; readonly href: string };
}

interface CalendarEventDraft {
  readonly id?: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly timeZone: string;
  readonly allDay: boolean;
  readonly conflicts: readonly TaskScheduleConflict[];
}

type CalendarMenuState =
  | { readonly kind: "event"; readonly eventId: string; readonly x: number; readonly y: number }
  | { readonly kind: "slot"; readonly startsAt: string; readonly x: number; readonly y: number };

interface CalendarEventPreviewState {
  readonly eventId: string;
  readonly x: number;
  readonly y: number;
}

const calendarDayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
type CalendarViewMode = "week" | "month";
type CalendarDialogMode = "view" | "edit";

function calendarEventWriteDisabledReason(event?: CalendarViewEvent, calendar?: CalendarListItem): string | undefined {
  if (calendar?.readOnly) return "这个日历当前为只读";
  if (event?.providerData?.providerId !== "exchange") return undefined;
  if (!event.providerData.itemId) return "请先立即同步 RWTH 日历，再尝试修改";
  if (event.providerData.isRecurring) return "重复日程暂不支持写回，请在 RWTH 网页端处理";
  if (event.providerData.isMeeting) return "含参会人的会议暂不支持写回，避免误发会议通知";
  return undefined;
}

function CalendarPage({ initialEventId, initialCalendarDate }: { readonly initialEventId?: string; readonly initialCalendarDate?: string }) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [anchorDate, setAnchorDate] = useState(() => {
    const requested = initialCalendarDate ? new Date(initialCalendarDate) : undefined;
    return requested && !Number.isNaN(requested.getTime()) ? requested : new Date();
  });
  const [calendars, setCalendars] = useState<readonly CalendarListItem[]>([]);
  const [events, setEvents] = useState<readonly CalendarViewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<CalendarEventDraft>();
  const [draftMode, setDraftMode] = useState<CalendarDialogMode>("view");
  const [menu, setMenu] = useState<CalendarMenuState>();
  const [eventPreview, setEventPreview] = useState<CalendarEventPreviewState>();
  const [relatedVersion, setRelatedVersion] = useState(0);
  const [calendarTasks, setCalendarTasks] = useState<readonly ClientTask[]>([]);
  const [taskDropBusy, setTaskDropBusy] = useState(false);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const openedInitialEvent = useRef(false);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin", []);
  const writableLocalCalendar = useMemo(() => (
    calendars.find((calendar) => !calendar.readOnly && calendar.primary && calendar.providerData?.providerId === "local-calendar")
      ?? calendars.find((calendar) => !calendar.readOnly && calendar.providerData?.providerId === "local-calendar")
      ?? calendars.find((calendar) => !calendar.readOnly)
  ), [calendars]);
  const visibleRange = useMemo(() => {
    if (viewMode === "week") {
      const start = startOfCalendarWeek(anchorDate);
      return { start, end: addCalendarDays(start, 7) };
    }
    const monthStart = startOfCalendarMonth(anchorDate);
    const start = startOfCalendarWeek(monthStart);
    return { start, end: addCalendarDays(start, 42) };
  }, [anchorDate, viewMode]);

  useEffect(() => {
    const storedView = window.localStorage.getItem("kalender.calendar.view");
    if (storedView === "week" || storedView === "month") setViewMode(storedView);
  }, []);

  useEffect(() => {
    void fetch("/api/tasks", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { readonly tasks?: readonly ClientTask[] };
        if (response.ok) setCalendarTasks(payload.tasks ?? []);
      })
      .catch(() => setCalendarTasks([]));
  }, []);

  const changeViewMode = (nextView: CalendarViewMode) => {
    setViewMode(nextView);
    window.localStorage.setItem("kalender.calendar.view", nextView);
  };

  const loadCalendars = useCallback(async () => {
    const response = await fetch("/api/calendars", { cache: "no-store" });
    const payload = await response.json() as { readonly calendars?: readonly CalendarListItem[]; readonly message?: string };
    if (!response.ok || !payload.calendars) throw new Error(payload.message || "无法读取日历");
    setCalendars(payload.calendars);
    return payload.calendars;
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: visibleRange.start.toISOString(), to: visibleRange.end.toISOString() });
      const response = await fetch(`/api/calendar-events?${params}`, { cache: "no-store" });
      const payload = await response.json() as { readonly events?: readonly CalendarViewEvent[]; readonly message?: string };
      if (!response.ok || !payload.events) throw new Error(payload.message || "无法读取日程");
      setEvents(payload.events);
      setFeedback("");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取日程");
    } finally {
      setLoading(false);
    }
  }, [visibleRange]);

  useEffect(() => {
    void loadCalendars().catch((error: unknown) => {
      setLoading(false);
      setFeedback(error instanceof Error ? error.message : "无法读取日历");
    });
  }, [loadCalendars]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  const openCreateDraft = useCallback((start = nextCalendarHour(new Date()), title = "") => {
    const calendarId = writableLocalCalendar?.id;
    if (!calendarId) {
      setFeedback("本地日历尚未准备好，请稍后再试");
      return;
    }
    setMenu(undefined);
    setEventPreview(undefined);
    setDraftMode("edit");
    setDraft({
      calendarId,
      title,
      description: "",
      location: "",
      startLocal: toLocalDateTimeInput(start),
      endLocal: toLocalDateTimeInput(new Date(start.getTime() + 60 * 60 * 1000)),
      timeZone,
      allDay: false,
      conflicts: [],
    });
  }, [timeZone, writableLocalCalendar]);

  const openEditDraft = useCallback((event: CalendarViewEvent, mode: CalendarDialogMode = "view") => {
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    const inclusiveAllDayEnd = event.allDay ? addCalendarDays(eventEnd, -1) : eventEnd;
    setMenu(undefined);
    setEventPreview(undefined);
    setDraftMode(mode);
    setDraft({
      id: event.id,
      calendarId: event.calendarId,
      title: event.title,
      description: event.description ?? "",
      location: event.location ?? "",
      startLocal: event.allDay ? toCalendarDateKey(eventStart) : toLocalDateTimeInput(eventStart),
      endLocal: event.allDay ? toCalendarDateKey(inclusiveAllDayEnd) : toLocalDateTimeInput(eventEnd),
      timeZone: event.timeZone ?? timeZone,
      allDay: event.allDay,
      conflicts: [],
    });
  }, [timeZone]);

  const updateCalendarDraft = (changes: Partial<CalendarEventDraft>) => {
    setDraft((current) => current ? { ...current, ...changes, conflicts: [] } : current);
  };

  const changeCalendarAllDay = (allDay: boolean) => {
    if (!draft) return;
    const start = new Date(draft.allDay ? `${draft.startLocal}T09:00` : draft.startLocal);
    const end = new Date(draft.allDay ? `${draft.endLocal}T10:00` : draft.endLocal);
    if (allDay) {
      updateCalendarDraft({
        allDay: true,
        startLocal: Number.isNaN(start.getTime()) ? toCalendarDateKey(new Date()) : toCalendarDateKey(start),
        endLocal: Number.isNaN(end.getTime()) ? toCalendarDateKey(new Date()) : toCalendarDateKey(end),
      });
    } else {
      const timedStart = Number.isNaN(start.getTime()) ? nextCalendarHour(new Date()) : start;
      timedStart.setHours(timedStart.getHours() || 9, 0, 0, 0);
      updateCalendarDraft({
        allDay: false,
        startLocal: toLocalDateTimeInput(timedStart),
        endLocal: toLocalDateTimeInput(new Date(timedStart.getTime() + 60 * 60_000)),
      });
    }
  };

  const setCalendarDuration = (minutes: number) => {
    if (!draft || draft.allDay) return;
    const start = new Date(draft.startLocal);
    if (!Number.isNaN(start.getTime())) updateCalendarDraft({ endLocal: toLocalDateTimeInput(new Date(start.getTime() + minutes * 60_000)) });
  };

  useEffect(() => {
    if (!initialEventId || openedInitialEvent.current || loading) return;
    const event = events.find((entry) => entry.id === initialEventId);
    openedInitialEvent.current = true;
    if (event) {
      openEditDraft(event);
      setFeedback("已打开任务安排的日程");
    } else {
      setFeedback("关联日程已删除或不在当前时间范围内");
    }
  }, [events, initialEventId, loading, openEditDraft]);

  const saveDraft = async (allowConflicts = false) => {
    if (!draft || busy) return;
    if (calendars.find((calendar) => calendar.id === draft.calendarId)?.readOnly) {
      setFeedback("这是只读日历，不能修改远端日程");
      return;
    }
    if (!draft.title.trim()) {
      setFeedback("请输入日程标题");
      return;
    }
    let start = new Date(draft.allDay ? `${draft.startLocal}T00:00` : draft.startLocal);
    let end = new Date(draft.allDay ? `${draft.endLocal}T00:00` : draft.endLocal);
    if (draft.allDay && !Number.isNaN(end.getTime())) end = addCalendarDays(end, 1);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setFeedback("结束时间必须晚于开始时间");
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch(draft.id ? `/api/calendar-events/${encodeURIComponent(draft.id)}` : "/api/calendar-events", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarId: draft.calendarId,
          title: draft.title.trim(),
          description: draft.description.trim() || undefined,
          location: draft.location.trim() || undefined,
          start: start.toISOString(),
          end: end.toISOString(),
          timeZone: draft.timeZone,
          allDay: draft.allDay,
          allowConflicts,
          idempotencyKey: draft.id ? undefined : `calendar-ui-${globalThis.crypto.randomUUID()}`,
        }),
      });
      const payload = await response.json() as { readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
      if (response.status === 409 && payload.conflicts?.length) {
        setDraft({ ...draft, conflicts: payload.conflicts });
        setFeedback("所选时间与现有日程冲突");
        return;
      }
      if (!response.ok || !payload.event) throw new Error(payload.message || "无法保存日程");
      setDraft(undefined);
      setFeedback(draft.id ? "日程已更新" : "日程已创建");
      await loadEvents();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存日程");
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async (event: CalendarViewEvent) => {
    if (calendars.find((calendar) => calendar.id === event.calendarId)?.readOnly) {
      setMenu(undefined);
      setFeedback("这是只读日历，不能删除远端日程");
      return;
    }
    if (busy || !window.confirm(`删除“${event.title}”？`)) return;
    setMenu(undefined);
    setBusy(true);
    try {
      const response = await fetch(`/api/calendar-events/${encodeURIComponent(event.id)}?calendarId=${encodeURIComponent(event.calendarId)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "无法删除日程");
      setDraft(undefined);
      setFeedback("日程已删除");
      await loadEvents();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除日程");
    } finally {
      setBusy(false);
    }
  };

  const duplicateEvent = (event: CalendarViewEvent) => {
    const targetCalendar = writableLocalCalendar;
    if (!targetCalendar) {
      setMenu(undefined);
      setFeedback("没有可写的个人日历，暂时无法复制日程");
      return;
    }
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    setMenu(undefined);
    setEventPreview(undefined);
    setDraftMode("edit");
    setDraft({
      calendarId: targetCalendar.id,
      title: `${event.title}（副本）`,
      description: event.description ?? "",
      location: event.location ?? "",
      startLocal: event.allDay ? toCalendarDateKey(eventStart) : toLocalDateTimeInput(eventStart),
      endLocal: event.allDay ? toCalendarDateKey(addCalendarDays(eventEnd, -1)) : toLocalDateTimeInput(eventEnd),
      timeZone: event.timeZone ?? timeZone,
      allDay: event.allDay,
      conflicts: [],
    });
  };

  const createMeetingNote = async (event: CalendarViewEvent) => {
    if (busy) return;
    setMenu(undefined);
    setBusy(true);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `会议笔记：${event.title}`.slice(0, 240),
          content: EMPTY_PLATE_NOTE_CONTENT,
          noteType: "meeting",
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly note?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建会议笔记");
      try {
        await createClientEntityLink({ sourceKind: "calendar", sourceId: event.id, targetKind: "note", targetId: payload.note.id, relation: "meeting-note" });
      } catch (error) {
        await fetch(`/api/notes/${encodeURIComponent(payload.note.id)}`, { method: "DELETE" });
        throw error;
      }
      setRelatedVersion((current) => current + 1);
      openEditDraft(event);
      setFeedback("会议笔记已创建，可从相关内容打开");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建会议笔记");
    } finally {
      setBusy(false);
    }
  };

  const createEventTask = async (event: CalendarViewEvent, kind: "preparation" | "follow-up") => {
    if (busy) return;
    setMenu(undefined);
    setBusy(true);
    const prefix = kind === "preparation" ? "准备" : "跟进";
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${prefix}：${event.title}`.slice(0, 240),
          notes: `关联日程：${event.title}`,
          status: kind === "preparation" ? "next" : "inbox",
          important: false,
          urgencyMode: "auto",
          dueAt: kind === "preparation" ? event.start : undefined,
          estimatedMinutes: kind === "preparation" ? 30 : undefined,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? `无法创建${prefix}任务`);
      try {
        await createClientEntityLink({ sourceKind: "calendar", sourceId: event.id, targetKind: "task", targetId: payload.task.id, relation: kind });
      } catch (error) {
        await fetch(`/api/tasks/${encodeURIComponent(payload.task.id)}`, { method: "DELETE" });
        throw error;
      }
      setRelatedVersion((current) => current + 1);
      openEditDraft(event);
      setFeedback(`${prefix}任务已创建，可从相关内容打开`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : `无法创建${prefix}任务`);
    } finally {
      setBusy(false);
    }
  };

  const contextEvent = menu?.kind === "event" ? events.find((event) => event.id === menu.eventId) : undefined;
  const contextCalendar = contextEvent ? calendars.find((calendar) => calendar.id === contextEvent.calendarId) : undefined;
  const contextWriteDisabledReason = calendarEventWriteDisabledReason(contextEvent, contextCalendar);
  const contextCommands = menu?.kind === "event" && contextEvent
    ? resolveContextCommands({
        kind: "calendar-event",
        id: contextEvent.id,
        title: contextEvent.title,
        busy,
        hasLinkedTask: Boolean(contextEvent.linkedTask),
        readOnly: Boolean(contextCalendar?.readOnly),
        writeDisabledReason: contextWriteDisabledReason,
        hasWritableCalendar: Boolean(writableLocalCalendar),
      })
    : menu?.kind === "slot"
      ? resolveContextCommands({ kind: "calendar-slot", startsAt: menu.startsAt, busy })
      : [];

  const handleContextCommand = (commandId: ContextCommandId) => {
    if (menu?.kind === "event" && contextEvent) {
      const eventCommand = commandId as CalendarEventCommandId;
      if (eventCommand === "calendar.open") openEditDraft(contextEvent, "view");
      if (eventCommand === "calendar.edit") openEditDraft(contextEvent, "edit");
      if (eventCommand === "calendar.open-task" && contextEvent.linkedTask) window.location.assign(contextEvent.linkedTask.href);
      if (eventCommand === "calendar.duplicate") duplicateEvent(contextEvent);
      if (eventCommand === "calendar.create-note") void createMeetingNote(contextEvent);
      if (eventCommand === "calendar.create-prep-task") void createEventTask(contextEvent, "preparation");
      if (eventCommand === "calendar.create-followup-task") void createEventTask(contextEvent, "follow-up");
      if (eventCommand === "calendar.delete") void deleteEvent(contextEvent);
      return;
    }
    if (menu?.kind === "slot") {
      const slotCommand = commandId as CalendarSlotCommandId;
      const start = new Date(menu.startsAt);
      if (slotCommand === "calendar.create-event") openCreateDraft(start);
      if (slotCommand === "calendar.create-focus") openCreateDraft(start, "专注时间");
    }
  };

  const scheduleDroppedTask = async (taskId: string, start: Date) => {
    if (taskDropBusy) return;
    const task = calendarTasks.find((item) => item.id === taskId);
    const calendar = calendars.find((item) => !item.readOnly && item.primary && item.providerData?.providerId === "local-calendar")
      ?? calendars.find((item) => !item.readOnly && item.providerData?.providerId === "local-calendar");
    if (!task || !calendar) {
      setFeedback("没有找到任务或可写的本地日历");
      return;
    }
    const end = new Date(start.getTime() + (task.estimatedMinutes ?? 60) * 60_000);
    setTaskDropBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarId: calendar.id, start: start.toISOString(), end: end.toISOString(), timeZone, allowConflicts: false }),
      });
      const payload = await response.json() as { readonly task?: ClientTask; readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
      if (response.status === 409 && payload.conflicts?.length) throw new Error("这个时间已有日程，请换一个空闲位置或从任务详情确认冲突");
      if (!response.ok || !payload.task || !payload.event) throw new Error(payload.message ?? "无法安排任务");
      setCalendarTasks((current) => current.map((item) => item.id === payload.task!.id ? payload.task! : item));
      setEvents((current) => [...current.filter((item) => item.id !== payload.event!.id), payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(`已安排“${task.title}”`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法安排任务");
    } finally {
      setTaskDropBusy(false);
    }
  };

  const moveTaskTimeBlock = async (event: CalendarViewEvent, start: Date) => {
    if (taskDropBusy || !event.linkedTask) return;
    const duration = Math.max(5 * 60_000, new Date(event.end).getTime() - new Date(event.start).getTime());
    const end = new Date(start.getTime() + duration);
    setTaskDropBusy(true);
    try {
      const requestMove = async (allowConflicts: boolean) => {
        const response = await fetch(`/api/tasks/${encodeURIComponent(event.linkedTask!.id)}/schedule/${encodeURIComponent(event.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calendarId: event.calendarId, start: start.toISOString(), end: end.toISOString(), timeZone, allowConflicts }),
        });
        const payload = await response.json() as { readonly task?: ClientTask; readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
        return { response, payload };
      };
      let result = await requestMove(false);
      if (result.response.status === 409 && result.payload.conflicts?.length) {
        const conflictNames = result.payload.conflicts.slice(0, 3).map((conflict) => `“${conflict.title}”`).join("、");
        if (!window.confirm(`新时间与 ${conflictNames} 冲突，仍然移动吗？`)) {
          setFeedback("已取消移动时间块");
          return;
        }
        result = await requestMove(true);
      }
      if (!result.response.ok || !result.payload.task || !result.payload.event) throw new Error(result.payload.message ?? "无法调整时间块");
      setCalendarTasks((current) => current.map((item) => item.id === result.payload.task!.id ? result.payload.task! : item));
      setEvents((current) => [...current.filter((item) => item.id !== result.payload.event!.id), result.payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(`已重新安排“${result.payload.task.title}”`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法调整时间块");
    } finally {
      setTaskDropBusy(false);
    }
  };

  const unscheduledTasks = calendarTasks.filter((task) => task.status !== "done" && task.scheduledBlocks.length === 0).slice(0, 8);
  const previewEvent = eventPreview ? events.find((event) => event.id === eventPreview.eventId) : undefined;
  const previewCalendar = previewEvent ? calendars.find((calendar) => calendar.id === previewEvent.calendarId) : undefined;
  const draftCalendar = draft ? calendars.find((calendar) => calendar.id === draft.calendarId) : undefined;
  const draftEvent = draft?.id ? events.find((event) => event.id === draft.id) : undefined;
  const draftWriteDisabledReason = draft?.id ? calendarEventWriteDisabledReason(draftEvent, draftCalendar) : undefined;
  const draftReadOnly = Boolean(draftWriteDisabledReason);
  const draftEditing = Boolean(draft && (!draft.id || draftMode === "edit"));

  const showEventPreview = useCallback((event: CalendarViewEvent, anchor: HTMLElement) => {
    const bounds = anchor.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    const x = bounds.right + 10 + width <= window.innerWidth - 8
      ? bounds.right + 10
      : Math.max(8, bounds.left - width - 10);
    const y = Math.max(8, Math.min(bounds.top, window.innerHeight - 250));
    setEventPreview({ eventId: event.id, x, y });
  }, []);

  return (
    <>
      <section className="calendar-shell">
        <div className="calendar-toolbar">
          <div className="calendar-navigation">
            <button className="secondary-button" aria-label={viewMode === "week" ? "上一周" : "上个月"} onClick={() => setAnchorDate(moveCalendarPeriod(anchorDate, viewMode, -1))}>‹</button>
            <button className="secondary-button" onClick={() => setAnchorDate(new Date())}>今天</button>
            <button className="secondary-button" aria-label={viewMode === "week" ? "下一周" : "下个月"} onClick={() => setAnchorDate(moveCalendarPeriod(anchorDate, viewMode, 1))}>›</button>
          </div>
          <strong>{viewMode === "week" ? formatCalendarWeekRange(visibleRange.start, visibleRange.end) : formatCalendarMonth(anchorDate)}</strong>
          <div className="calendar-toolbar-actions">
            <div className="calendar-view-switch" role="group" aria-label="日历视图">
              <button className={viewMode === "week" ? "active" : ""} aria-pressed={viewMode === "week"} onClick={() => changeViewMode("week")}>周</button>
              <button className={viewMode === "month" ? "active" : ""} aria-pressed={viewMode === "month"} onClick={() => changeViewMode("month")}>月</button>
            </div>
            <button className="primary-button" onClick={() => openCreateDraft()}><Plus size={15} />新建日程</button>
          </div>
        </div>
        <div className="calendar-source-row"><div>{calendars.map((calendar) => <span key={calendar.id}><i style={{ background: calendar.color ?? "#86bdf5" }} />{calendar.name}{calendar.readOnly ? " · 只读" : ""}</span>)}</div><small>{timeZone}</small></div>
        {viewMode === "week" && <section className="calendar-task-shelf" aria-label="待安排任务"><header><div><ListChecks size={15} /><strong>待安排任务</strong></div><small>{taskDropBusy ? "正在安排…" : <><span className="desktop-hint">拖入日历，或点击选择时间</span><span className="mobile-hint">点击任务选择时间</span></>}</small></header><div>{unscheduledTasks.length ? unscheduledTasks.map((task) => <Link href={`/tasks?schedule=${encodeURIComponent(task.id)}`} draggable={!taskDropBusy} key={task.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-kalender-task", task.id); }}><span>{task.title}</span>{task.estimatedMinutes && <em>{formatTaskEstimate(task.estimatedMinutes)}</em>}</Link>) : <span>所有当前任务都已安排</span>}</div></section>}
        {feedback && <div className="calendar-feedback" role="status">{feedback}</div>}
        {viewMode === "week" ? (
          <CalendarWeekView
            calendars={calendars}
            events={events}
            loading={loading}
            weekStart={visibleRange.start}
            onCreate={openCreateDraft}
            onEdit={openEditDraft}
            previewEventId={eventPreview?.eventId}
            onPreviewEvent={showEventPreview}
            onClearEventPreview={() => setEventPreview(undefined)}
            onOpenEventMenu={(event, x, y, returnFocus) => {
              setEventPreview(undefined);
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "event", eventId: event.id, x, y });
            }}
            onOpenSlotMenu={(startsAt, x, y, returnFocus) => {
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "slot", startsAt: startsAt.toISOString(), x, y });
            }}
            onDropTask={(taskId, startsAt) => void scheduleDroppedTask(taskId, startsAt)}
            onMoveTaskBlock={(event, startsAt) => void moveTaskTimeBlock(event, startsAt)}
          />
        ) : (
          <CalendarMonthView
            anchorDate={anchorDate}
            calendars={calendars}
            events={events}
            loading={loading}
            rangeStart={visibleRange.start}
            onCreate={openCreateDraft}
            onEdit={openEditDraft}
            previewEventId={eventPreview?.eventId}
            onPreviewEvent={showEventPreview}
            onClearEventPreview={() => setEventPreview(undefined)}
            onOpenEventMenu={(event, x, y, returnFocus) => {
              setEventPreview(undefined);
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "event", eventId: event.id, x, y });
            }}
            onOpenSlotMenu={(startsAt, x, y, returnFocus) => {
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "slot", startsAt: startsAt.toISOString(), x, y });
            }}
          />
        )}
      </section>

      {eventPreview && previewEvent && (
        <CalendarEventTooltip
          anchor={{ x: eventPreview.x, y: eventPreview.y }}
          calendar={previewCalendar}
          event={previewEvent}
        />
      )}

      {draft && (
        <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDraft(undefined); }}>
          <section className={`calendar-dialog panel calendar-event-dialog ${draftEditing ? "calendar-edit-dialog" : "calendar-detail-dialog"}`} role="dialog" aria-modal="true" aria-labelledby="calendar-dialog-title">
            <header className="calendar-event-dialog-header">
              <div className="calendar-event-dialog-heading">
                <span className={`calendar-event-badge ${draftReadOnly ? "protected" : ""}`}>
                  {draftEditing ? <Pencil size={13} /> : draftReadOnly ? <ShieldCheck size={14} /> : <CalendarDays size={14} />}
                  {draftEditing ? (draft.id ? `编辑 · ${draftCalendar?.name ?? "日历"}` : "新建日程") : draftReadOnly ? "受保护" : draftCalendar?.name ?? "日程详情"}
                </span>
                {!draftEditing && <h2 id="calendar-dialog-title">{draft.title}</h2>}
              </div>
              <button aria-label="关闭" onClick={() => setDraft(undefined)} disabled={busy && draftEditing}><X size={20} /></button>
            </header>
            {draftEditing ? <>
              <div className="calendar-form calendar-modern-form">
                <h2 id="calendar-dialog-title">{draft.id ? "编辑日程" : "新建日程"}</h2>
                <label className="calendar-title-field"><span><Pencil size={14} />标题</span><input autoFocus value={draft.title} maxLength={200} placeholder="日程名称" onChange={(event) => updateCalendarDraft({ title: event.target.value })} /></label>
                <div className="calendar-edit-time">
                  <label><span><CalendarDays size={14} />{draft.allDay ? "开始日期" : "开始"}</span><input type={draft.allDay ? "date" : "datetime-local"} value={draft.startLocal} onChange={(event) => updateCalendarDraft({ startLocal: event.target.value })} /></label>
                  <label><span><Clock3 size={14} />{draft.allDay ? "结束日期（含）" : "结束"}</span><input type={draft.allDay ? "date" : "datetime-local"} min={draft.allDay ? draft.startLocal : undefined} value={draft.endLocal} onChange={(event) => updateCalendarDraft({ endLocal: event.target.value })} /></label>
                </div>
                {!draft.allDay && <div className="calendar-duration-field"><span><Clock3 size={14} />快速时长</span><div>{[30, 60, 90, 120].map((minutes) => <button type="button" key={minutes} onClick={() => setCalendarDuration(minutes)}>{minutes < 60 ? `${minutes} 分` : `${minutes / 60} 小时`}</button>)}</div></div>}
                <div className="calendar-edit-meta">
                  <label><span><CalendarDays size={14} />日历</span><select disabled={Boolean(draft.id)} value={draft.calendarId} onChange={(event) => updateCalendarDraft({ calendarId: event.target.value })}>{calendars.map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}</select><small className="calendar-field-hint"><i style={{ background: draftCalendar?.color ?? "#86bdf5" }} />{draftCalendar?.name ?? "日历"} · {draft.timeZone}</small></label>
                  <label><span><MapPin size={14} />地点</span><input value={draft.location} maxLength={500} placeholder="可选" onChange={(event) => updateCalendarDraft({ location: event.target.value })} /></label>
                </div>
                <label className="calendar-all-day"><input type="checkbox" checked={draft.allDay} onChange={(event) => changeCalendarAllDay(event.target.checked)} /><span>全天日程</span></label>
                <label className="calendar-description"><span><NotebookPen size={14} />备注</span><textarea value={draft.description} maxLength={100000} placeholder="添加备注（可选）" onChange={(event) => updateCalendarDraft({ description: event.target.value })} /></label>
                {draft.id && <RelatedContentPanel kind="calendar" entityId={draft.id} refreshKey={relatedVersion} hideWhenEmpty />}
              </div>
              {draft.conflicts.length > 0 && <div className="task-schedule-conflicts calendar-dialog-conflicts" role="alert"><header><AlertCircle size={16} /><strong>发现时间冲突</strong></header>{draft.conflicts.map((conflict) => <div key={conflict.id}><span>{formatTaskBlockRange(conflict.start, conflict.end)}</span><strong>{conflict.title}</strong></div>)}<p>可以返回修改时间，或者确认仍然保存。</p></div>}
            </> : <div className="calendar-detail-content">
              <div className="calendar-detail-time">
                <div><span className="calendar-detail-icon calendar-detail-icon-date"><CalendarDays size={17} /></span><strong>{formatCalendarDetailDate(draft)}</strong></div>
                <div><span className="calendar-detail-icon calendar-detail-icon-time"><Clock3 size={17} /></span><strong>{formatCalendarDetailTime(draft)}</strong><small>{formatCalendarDetailDuration(draft)}</small></div>
              </div>
              <div className="calendar-detail-meta">
                <div><span className="calendar-detail-icon"><CalendarDays size={15} /></span><strong>{draftCalendar?.name ?? "日历"}</strong></div>
                {draft.location && <div><span className="calendar-detail-icon"><MapPin size={15} /></span><strong>{draft.location}</strong></div>}
              </div>
              {draftWriteDisabledReason && <div className="calendar-detail-notice" role="note"><ShieldCheck size={14} /><span>{draftWriteDisabledReason}</span></div>}
              {draft.description.trim() && <section className="calendar-detail-notes"><h3>备注</h3><p>{draft.description}</p></section>}
              {draft.id && <RelatedContentPanel kind="calendar" entityId={draft.id} refreshKey={relatedVersion} hideWhenEmpty />}
            </div>}
            <footer className={draftEditing ? "calendar-edit-footer" : "calendar-detail-footer"}>
              {draftEditing && draft.id ? <button className="ghost-button danger-button" disabled={busy} onClick={() => { const event = events.find((item) => item.id === draft.id); if (event) void deleteEvent(event); }}><Trash2 size={15} />删除</button> : <span />}
              <div>{draftEditing ? <>
                <button className="secondary-button" disabled={busy} onClick={() => { if (draftEvent) openEditDraft(draftEvent, "view"); else setDraft(undefined); }}>取消</button>
                <button className={draft.conflicts.length ? "danger-confirm-button" : "primary-button"} disabled={busy} onClick={() => void saveDraft(draft.conflicts.length > 0)}>{busy && <LoaderCircle className="spin" size={15} />}{draft.conflicts.length ? "仍然保存" : draft.id ? "保存修改" : "创建日程"}</button>
              </> : <>
                {!draftReadOnly && <button className="secondary-button" onClick={() => setDraftMode("edit")}><Pencil size={14} />编辑</button>}
                <button className="primary-button" onClick={() => setDraft(undefined)}>关闭</button>
              </>}</div>
            </footer>
          </section>
        </div>
      )}

      {menu && contextCommands.length > 0 && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          ariaLabel={contextEvent ? `日程操作：${contextEvent.title}` : "空闲时间操作"}
          commands={contextCommands}
          heading={contextEvent?.title ?? (menu.kind === "slot" ? formatCalendarSlotHeading(menu.startsAt) : "空闲时间")}
          returnFocus={menuReturnFocusRef.current}
          testId="calendar-context-menu"
          onClose={() => setMenu(undefined)}
          onSelect={handleContextCommand}
        />
      )}
    </>
  );
}

interface CalendarViewCommonProps {
  readonly calendars: readonly CalendarListItem[];
  readonly events: readonly CalendarViewEvent[];
  readonly loading: boolean;
  readonly onCreate: (start: Date, title?: string) => void;
  readonly onEdit: (event: CalendarViewEvent) => void;
  readonly previewEventId?: string;
  readonly onPreviewEvent: (event: CalendarViewEvent, anchor: HTMLElement) => void;
  readonly onClearEventPreview: () => void;
  readonly onOpenEventMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void;
  readonly onOpenSlotMenu: (startsAt: Date, x: number, y: number, returnFocus: HTMLElement) => void;
  readonly onDropTask?: (taskId: string, startsAt: Date) => void;
  readonly onMoveTaskBlock?: (event: CalendarViewEvent, startsAt: Date) => void;
}

const weekVisibleStartHour = 7;
const weekVisibleEndHour = 22;
const weekHourHeight = 60;

function CalendarWeekView({
  calendars,
  events,
  loading,
  weekStart,
  onCreate,
  onEdit,
  previewEventId,
  onPreviewEvent,
  onClearEventPreview,
  onOpenEventMenu,
  onOpenSlotMenu,
  onDropTask,
  onMoveTaskBlock,
}: CalendarViewCommonProps & { readonly weekStart: Date }) {
  const [currentTime, setCurrentTime] = useState<Date>();
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(weekStart, index));
  const hours = Array.from({ length: weekVisibleEndHour - weekVisibleStartHour + 1 }, (_, index) => weekVisibleStartHour + index);
  const timelineHeight = (weekVisibleEndHour - weekVisibleStartHour) * weekHourHeight;
  const currentMinutes = currentTime ? currentTime.getHours() * 60 + currentTime.getMinutes() + currentTime.getSeconds() / 60 : undefined;
  const currentTimeTop = currentMinutes === undefined
    ? undefined
    : ((currentMinutes - weekVisibleStartHour * 60) / 60) * weekHourHeight;
  const currentTimeVisible = currentTimeTop !== undefined && currentTimeTop >= 0 && currentTimeTop <= timelineHeight;

  useEffect(() => {
    const updateCurrentTime = () => setCurrentTime(new Date());
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") updateCurrentTime(); };
    updateCurrentTime();
    const interval = window.setInterval(updateCurrentTime, 30_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const slotFromPointer = (day: Date, target: HTMLElement, clientY: number) => {
    const bounds = target.getBoundingClientRect();
    const rawMinutes = ((clientY - bounds.top) / weekHourHeight) * 60;
    const roundedMinutes = Math.round(rawMinutes / 15) * 15;
    const start = new Date(day);
    start.setHours(weekVisibleStartHour, Math.max(0, Math.min(roundedMinutes, (weekVisibleEndHour - weekVisibleStartHour) * 60 - 15)), 0, 0);
    return start;
  };

  return (
    <section className="calendar-week panel" aria-label="周视图" data-testid="calendar-week-view">
      <div className="calendar-week-viewport">
        <div className="calendar-week-sticky">
          <div className="calendar-week-header">
            <div className="calendar-week-corner">GMT{formatTimezoneOffset(new Date())}</div>
            {days.map((day, index) => (
              <div className={`calendar-week-day-heading ${calendarDatesMatch(day, new Date()) ? "today" : ""}`} key={day.toISOString()}>
                <span>{calendarDayNames[index]}</span><b>{day.getDate()}</b>
              </div>
            ))}
          </div>
          <div className="calendar-all-day-row">
            <div className="calendar-all-day-label">全天</div>
            {days.map((day) => (
              <div className="calendar-all-day-cell" key={day.toISOString()}>
                {events.filter((event) => event.allDay && calendarEventOverlapsDay(event, day)).map((event) => (
                  <CalendarCompactEvent
                    calendar={calendars.find((item) => item.id === event.calendarId)}
                    event={event}
                    key={event.id}
                    onEdit={onEdit}
                    previewed={previewEventId === event.id}
                    onPreview={onPreviewEvent}
                    onClearPreview={onClearEventPreview}
                    onOpenMenu={onOpenEventMenu}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="calendar-week-timeline">
          <div className="calendar-time-axis" style={{ height: timelineHeight }}>
            {hours.map((hour) => <time key={hour} style={{ top: (hour - weekVisibleStartHour) * weekHourHeight }}>{String(hour).padStart(2, "0")}:00</time>)}
          </div>
          <div className="calendar-week-grid" style={{ height: timelineHeight }}>
            {days.map((day, index) => {
              const laidOutEvents = layoutCalendarDayEvents(events.filter((event) => !event.allDay), day);
              const isToday = Boolean(currentTime && calendarDatesMatch(day, currentTime));
              return (
                <div
                  className={`calendar-time-lane ${isToday ? "today" : ""}`}
                  data-testid={`calendar-week-day-${index}`}
                  key={day.toISOString()}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes("application/x-kalender-task") && !event.dataTransfer.types.includes("application/x-kalender-task-block")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  event.currentTarget.classList.add("task-drop-target");
                }}
                onDragLeave={(event) => event.currentTarget.classList.remove("task-drop-target")}
                onDrop={(event) => {
                  event.preventDefault();
                  event.currentTarget.classList.remove("task-drop-target");
                  const blockId = event.dataTransfer.getData("application/x-kalender-task-block");
                  const movedEvent = blockId ? events.find((item) => item.id === blockId) : undefined;
                  if (movedEvent) {
                    onMoveTaskBlock?.(movedEvent, slotFromPointer(day, event.currentTarget, event.clientY));
                    return;
                  }
                  const taskId = event.dataTransfer.getData("application/x-kalender-task");
                  if (taskId) onDropTask?.(taskId, slotFromPointer(day, event.currentTarget, event.clientY));
                }}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(".calendar-week-event")) return;
                  onCreate(slotFromPointer(day, event.currentTarget, event.clientY));
                }}
                onContextMenu={(event) => {
                  if (event.shiftKey || (event.target as HTMLElement).closest(".calendar-week-event")) return;
                  event.preventDefault();
                  onOpenSlotMenu(slotFromPointer(day, event.currentTarget, event.clientY), event.clientX, event.clientY, event.currentTarget);
                }}
              >
                {isToday && currentTimeVisible && currentTimeTop !== undefined && currentTime && (
                  <div
                    className="calendar-current-time"
                    style={{ top: currentTimeTop }}
                    role="timer"
                    aria-label={`当前时间 ${formatCalendarCurrentTime(currentTime)}`}
                  >
                    <time dateTime={currentTime.toISOString()}>{formatCalendarCurrentTime(currentTime)}</time>
                  </div>
                )}
                {laidOutEvents.map((placed) => {
                  const calendar = calendars.find((item) => item.id === placed.event.calendarId);
                  return (
                    <button
                      className={`calendar-week-event ${placed.event.linkedTask ? "task-block-draggable" : ""}`}
                      data-testid="calendar-event"
                      draggable={Boolean(placed.event.linkedTask)}
                      key={placed.event.id}
                      style={{
                        top: placed.top,
                        height: placed.height,
                        left: `${placed.leftPercent}%`,
                        width: `${placed.widthPercent}%`,
                        borderLeftColor: calendar?.color ?? "#86bdf5",
                      }}
                      onClick={(event) => { event.stopPropagation(); onEdit(placed.event); }}
                      onMouseEnter={(event) => onPreviewEvent(placed.event, event.currentTarget)}
                      onMouseLeave={onClearEventPreview}
                      onFocus={(event) => onPreviewEvent(placed.event, event.currentTarget)}
                      onBlur={onClearEventPreview}
                      onDragStart={(event) => {
                        if (!placed.event.linkedTask) return;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("application/x-kalender-task-block", placed.event.id);
                        event.currentTarget.classList.add("dragging");
                      }}
                      onDragEnd={(event) => event.currentTarget.classList.remove("dragging")}
                      onContextMenu={(event) => {
                        if (event.shiftKey) return;
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenEventMenu(placed.event, event.clientX, event.clientY, event.currentTarget);
                      }}
                      onKeyDown={(event) => openCalendarEventKeyboardMenu(event, placed.event, onOpenEventMenu)}
                      aria-describedby={previewEventId === placed.event.id ? "calendar-event-tooltip" : undefined}
                    >
                      <span className="calendar-week-event-heading">
                        <time>{formatCalendarEventTime(placed.event.start)}</time>
                        <strong>{placed.event.title}</strong>
                      </span>
                      {placed.height >= 42 && (placed.event.linkedTask ? <small className="calendar-event-task"><ListChecks size={10} />任务 · {placed.event.linkedTask.title}</small> : placed.event.location && <small>{placed.event.location}</small>)}
                    </button>
                  );
                })}
                </div>
              );
            })}
            {loading && <div className="calendar-view-loading"><LoaderCircle className="spin" size={17} />正在读取日程</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function CalendarMonthView({
  anchorDate,
  calendars,
  events,
  loading,
  rangeStart,
  onCreate,
  onEdit,
  previewEventId,
  onPreviewEvent,
  onClearEventPreview,
  onOpenEventMenu,
  onOpenSlotMenu,
}: CalendarViewCommonProps & { readonly anchorDate: Date; readonly rangeStart: Date }) {
  const [expandedDay, setExpandedDay] = useState("");
  const days = Array.from({ length: 42 }, (_, index) => addCalendarDays(rangeStart, index));

  return (
    <section className="calendar-month panel" aria-label="月视图" data-testid="calendar-month-view">
      <div className="calendar-month-weekdays">
        {calendarDayNames.map((name) => <div key={name}>{name}</div>)}
      </div>
      <div className="calendar-month-grid">
        {days.map((day, index) => {
          const dayKey = toCalendarDateKey(day);
          const dayEvents = events
            .filter((event) => calendarEventOverlapsDay(event, day))
            .sort((left, right) => Number(right.allDay) - Number(left.allDay) || new Date(left.start).getTime() - new Date(right.start).getTime());
          const expanded = expandedDay === dayKey;
          const visibleEvents = expanded ? dayEvents : dayEvents.slice(0, 3);
          const slotStart = calendarSlotStart(day);
          return (
            <div
              className={`calendar-month-day ${day.getMonth() !== anchorDate.getMonth() ? "outside" : ""} ${calendarDatesMatch(day, new Date()) ? "today" : ""}`}
              data-testid={`calendar-month-day-${index}`}
              key={dayKey}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest(".calendar-month-event, .calendar-more-events")) return;
                onCreate(slotStart);
              }}
              onContextMenu={(event) => {
                if (event.shiftKey || (event.target as HTMLElement).closest(".calendar-month-event")) return;
                event.preventDefault();
                onOpenSlotMenu(slotStart, event.clientX, event.clientY, event.currentTarget);
              }}
            >
              <header><span>{day.getDate()}</span>{day.getDate() === 1 && <small>{day.getMonth() + 1}月</small>}</header>
              <div className="calendar-month-events">
                {visibleEvents.map((event) => (
                  <CalendarCompactEvent
                    calendar={calendars.find((item) => item.id === event.calendarId)}
                    event={event}
                    key={event.id}
                    month
                    onEdit={onEdit}
                    previewed={previewEventId === event.id}
                    onPreview={onPreviewEvent}
                    onClearPreview={onClearEventPreview}
                    onOpenMenu={onOpenEventMenu}
                  />
                ))}
                {dayEvents.length > 3 && (
                  <button className="calendar-more-events" onClick={(event) => { event.stopPropagation(); setExpandedDay(expanded ? "" : dayKey); }}>
                    {expanded ? "收起" : `还有 ${dayEvents.length - 3} 项`}
                  </button>
                )}
              </div>
              {loading && index === 0 && <div className="calendar-loading"><LoaderCircle className="spin" size={14} /></div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CalendarCompactEvent({
  calendar,
  event,
  month = false,
  onEdit,
  previewed = false,
  onPreview,
  onClearPreview,
  onOpenMenu,
}: {
  readonly calendar?: CalendarListItem;
  readonly event: CalendarViewEvent;
  readonly month?: boolean;
  readonly onEdit: (event: CalendarViewEvent) => void;
  readonly previewed?: boolean;
  readonly onPreview: (event: CalendarViewEvent, anchor: HTMLElement) => void;
  readonly onClearPreview: () => void;
  readonly onOpenMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void;
}) {
  return (
    <button
      className={month ? "calendar-month-event" : "calendar-all-day-event"}
      style={{ borderLeftColor: calendar?.color ?? "#86bdf5" }}
      onClick={(clickEvent) => { clickEvent.stopPropagation(); onEdit(event); }}
      onMouseEnter={(hoverEvent) => onPreview(event, hoverEvent.currentTarget)}
      onMouseLeave={onClearPreview}
      onFocus={(focusEvent) => onPreview(event, focusEvent.currentTarget)}
      onBlur={onClearPreview}
      onContextMenu={(contextEvent) => {
        if (contextEvent.shiftKey) return;
        contextEvent.preventDefault();
        contextEvent.stopPropagation();
        onOpenMenu(event, contextEvent.clientX, contextEvent.clientY, contextEvent.currentTarget);
      }}
      onKeyDown={(keyEvent) => openCalendarEventKeyboardMenu(keyEvent, event, onOpenMenu)}
      aria-describedby={previewed ? "calendar-event-tooltip" : undefined}
    >
      {!event.allDay && <time>{formatCalendarEventTime(event.start)}</time>}
      <span>{event.title}</span>
      {event.linkedTask && <ListChecks className="calendar-compact-task-icon" size={10} aria-label="关联任务" />}
    </button>
  );
}

function CalendarEventTooltip({
  anchor,
  calendar,
  event,
}: {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly calendar?: CalendarListItem;
  readonly event: CalendarViewEvent;
}) {
  const statusLabel = event.status === "tentative" ? "暂定" : event.status === "cancelled" ? "已取消" : undefined;
  return (
    <aside
      id="calendar-event-tooltip"
      className="calendar-event-tooltip"
      role="tooltip"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <header>
        <span><i style={{ background: calendar?.color ?? "#86bdf5" }} />{calendar?.name ?? "日历"}{calendar?.readOnly ? " · 只读" : ""}</span>
        {statusLabel && <em className={`status-${event.status}`}>{statusLabel}</em>}
      </header>
      <strong>{event.title}</strong>
      <div className="calendar-event-tooltip-meta">
        <span><Clock3 size={13} />{formatCalendarEventRange(event)}</span>
        {event.location && <span><MapPin size={13} />{event.location}</span>}
        {event.meetingUrl && <span><Link2 size={13} />{formatCalendarMeetingHost(event.meetingUrl)}</span>}
      </div>
      {event.description && <p>{event.description}</p>}
      {event.attendees?.length ? <small>{event.attendees.length} 位参与者</small> : null}
      {event.linkedTask && <small><ListChecks size={12} />关联任务：{event.linkedTask.title}</small>}
    </aside>
  );
}

function openCalendarEventKeyboardMenu(
  keyEvent: KeyboardEvent<HTMLButtonElement>,
  event: CalendarViewEvent,
  onOpenMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void,
) {
  if (keyEvent.key !== "ContextMenu" && !(keyEvent.shiftKey && keyEvent.key === "F10")) return;
  keyEvent.preventDefault();
  const bounds = keyEvent.currentTarget.getBoundingClientRect();
  onOpenMenu(event, bounds.right - 10, bounds.bottom + 4, keyEvent.currentTarget);
}

interface LaidOutCalendarEvent {
  readonly event: CalendarViewEvent;
  readonly top: number;
  readonly height: number;
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly column: number;
  readonly clippedStart: number;
  readonly clippedEnd: number;
}

function layoutCalendarDayEvents(events: readonly CalendarViewEvent[], day: Date): readonly LaidOutCalendarEvent[] {
  const visibleStart = new Date(day);
  visibleStart.setHours(weekVisibleStartHour, 0, 0, 0);
  const visibleEnd = new Date(day);
  visibleEnd.setHours(weekVisibleEndHour, 0, 0, 0);
  const candidates = events
    .map((event) => ({
      event,
      clippedStart: Math.max(new Date(event.start).getTime(), visibleStart.getTime()),
      clippedEnd: Math.min(new Date(event.end).getTime(), visibleEnd.getTime()),
    }))
    .filter((item) => item.clippedStart < item.clippedEnd)
    .sort((left, right) => left.clippedStart - right.clippedStart || right.clippedEnd - left.clippedEnd);
  const placed: LaidOutCalendarEvent[] = [];
  for (const candidate of candidates) {
    const overlappingPrevious = placed.filter((item) => item.clippedEnd > candidate.clippedStart && item.clippedStart < candidate.clippedEnd);
    const usedColumns = new Set(overlappingPrevious.map((item) => item.column));
    let column = 0;
    while (usedColumns.has(column)) column += 1;
    const minutesFromStart = (candidate.clippedStart - visibleStart.getTime()) / 60000;
    const durationMinutes = (candidate.clippedEnd - candidate.clippedStart) / 60000;
    placed.push({
      ...candidate,
      column,
      top: (minutesFromStart / 60) * weekHourHeight,
      height: Math.max(24, (durationMinutes / 60) * weekHourHeight),
      leftPercent: 0,
      widthPercent: 100,
    });
  }
  return placed.map((item) => {
    const overlapGroup = placed.filter((other) => other.clippedEnd > item.clippedStart && other.clippedStart < item.clippedEnd);
    const columns = Math.max(...overlapGroup.map((other) => other.column), 0) + 1;
    return { ...item, leftPercent: (item.column / columns) * 100, widthPercent: 100 / columns };
  });
}

function startOfCalendarWeek(value: Date): Date {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  const mondayOffset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - mondayOffset);
  return result;
}

function startOfCalendarMonth(value: Date): Date {
  const result = new Date(value);
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
}

function moveCalendarPeriod(value: Date, view: CalendarViewMode, amount: number): Date {
  const result = new Date(value);
  if (view === "week") result.setDate(result.getDate() + amount * 7);
  else result.setMonth(result.getMonth() + amount, 1);
  return result;
}

function addCalendarDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function calendarSlotStart(day: Date): Date {
  const result = new Date(day);
  result.setHours(9, 0, 0, 0);
  return result;
}

function nextCalendarHour(value: Date): Date {
  const result = new Date(value);
  result.setMinutes(0, 0, 0);
  result.setHours(result.getHours() + 1);
  return result;
}

function calendarDatesMatch(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function calendarEventOverlapsDay(event: CalendarViewEvent, day: Date): boolean {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addCalendarDays(dayStart, 1);
  return new Date(event.start) < dayEnd && new Date(event.end) > dayStart;
}

function toCalendarDateKey(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toLocalDateTimeInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function formatCalendarEventTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatCalendarDetailDate(draft: CalendarEventDraft): string {
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00:00` : draft.startLocal);
  const end = new Date(draft.allDay ? `${draft.endLocal}T00:00:00` : draft.endLocal);
  const format = (value: Date) => new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
  if (Number.isNaN(start.getTime())) return draft.startLocal;
  if (Number.isNaN(end.getTime()) || calendarDatesMatch(start, end)) return format(start);
  return `${format(start)} — ${format(end)}`;
}

function formatCalendarDetailTime(draft: CalendarEventDraft): string {
  if (draft.allDay) return "全天";
  const start = new Date(draft.startLocal);
  const end = new Date(draft.endLocal);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${draft.startLocal} — ${draft.endLocal}`;
  const format = (value: Date) => new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
  return calendarDatesMatch(start, end) ? `${format(start)} — ${format(end)}` : `${format(start)} — ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}

function formatCalendarDetailDuration(draft: CalendarEventDraft): string {
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00:00` : draft.startLocal);
  const end = new Date(draft.allDay ? `${draft.endLocal}T00:00:00` : draft.endLocal);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  if (draft.allDay) {
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    return days === 1 ? "全天" : `${days} 天`;
  }
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}

function formatCalendarEventRange(event: CalendarViewEvent): string {
  const start = new Date(event.start);
  const end = event.allDay ? new Date(new Date(event.end).getTime() - 1) : new Date(event.end);
  const sameDay = calendarDatesMatch(start, end);
  const date = (value: Date, includeWeekday = false) => {
    const weekday = includeWeekday ? new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(value) : "";
    return `${value.getMonth() + 1}月${value.getDate()}日${weekday}`;
  };
  if (event.allDay) return sameDay ? `${date(start, true)} · 全天` : `${date(start)} – ${date(end)} · 全天`;
  const time = (value: Date) => new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
  return sameDay ? `${date(start, true)} · ${time(start)}–${time(end)}` : `${date(start)} ${time(start)} – ${date(end)} ${time(end)}`;
}

function formatCalendarMeetingHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "在线会议";
  }
}

function formatCalendarCurrentTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
}

function formatCalendarWeekRange(start: Date, end: Date): string {
  const inclusiveEnd = addCalendarDays(end, -1);
  const startLabel = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(start);
  const endLabel = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: start.getFullYear() === inclusiveEnd.getFullYear() ? undefined : "numeric" }).format(inclusiveEnd);
  return `${startLabel} – ${endLabel}`;
}

function formatCalendarMonth(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(value);
}

function formatTimezoneOffset(value: Date): string {
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

function formatCalendarSlotHeading(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

type TaskStatus = "inbox" | "next" | "waiting" | "someday" | "done";
type TaskUrgencyMode = "auto" | "urgent" | "not_urgent";
type TaskView = "today" | "inbox" | "upcoming" | "waiting" | "projects" | "completed" | "matrix";

interface ClientTaskSource {
  readonly id: string;
  readonly kind: "mail" | "calendar" | "note";
  readonly sourceId: string;
  readonly label: string;
  readonly href?: string;
}

interface ClientTask {
  readonly id: string;
  readonly title: string;
  readonly notes?: string;
  readonly status: TaskStatus;
  readonly important: boolean;
  readonly urgencyMode: TaskUrgencyMode;
  readonly isUrgent: boolean;
  readonly dueAt?: string;
  readonly estimatedMinutes?: number;
  readonly projectName?: string;
  readonly areaName?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceReferences: readonly ClientTaskSource[];
  readonly scheduledBlockCount: number;
  readonly scheduledBlocks: readonly ClientTaskTimeBlock[];
}

interface ClientTaskTimeBlock {
  readonly eventId: string;
  readonly calendarId: string;
  readonly calendarName: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly href: string;
}

interface TaskScheduleConflict {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

interface TaskScheduleDraft {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly eventId?: string;
  readonly returnTaskDraft?: TaskDraft;
  calendarId: string;
  startLocal: string;
  endLocal: string;
  conflicts: readonly TaskScheduleConflict[];
}

interface TaskDraft {
  readonly id?: string;
  readonly sourceReferences: readonly ClientTaskSource[];
  title: string;
  notes: string;
  status: TaskStatus;
  important: boolean;
  urgencyMode: TaskUrgencyMode;
  dueAt: string;
  estimatedMinutes: string;
  projectName: string;
  areaName: string;
}

interface TaskContextMenuState {
  readonly taskId: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

const taskViewCopy: Record<TaskView, { readonly label: string; readonly description: string }> = {
  today: { label: "Today", description: "今天到期或需要立即推进的任务" },
  inbox: { label: "Inbox", description: "先收集，再决定优先级和下一步" },
  upcoming: { label: "Upcoming", description: "查看今天之后有截止时间的任务" },
  waiting: { label: "Waiting", description: "集中跟进正在等待他人的事项" },
  projects: { label: "项目", description: "按项目查看当前尚未完成的行动" },
  completed: { label: "Completed", description: "最近完成的任务，可重新打开" },
  matrix: { label: "四象限", description: "按重要性和紧急性决定行动方式" },
};

function TasksPage({ initialTaskId, initialScheduleTaskId }: { readonly initialTaskId?: string; readonly initialScheduleTaskId?: string }) {
  const [tasks, setTasks] = useState<readonly ClientTask[]>([]);
  const [view, setView] = useState<TaskView>("today");
  const [loading, setLoading] = useState(true);
  const [busyTaskId, setBusyTaskId] = useState<string>();
  const [draft, setDraft] = useState<TaskDraft>();
  const [feedback, setFeedback] = useState<string>();
  const [menu, setMenu] = useState<TaskContextMenuState>();
  const [taskCalendars, setTaskCalendars] = useState<readonly CalendarListItem[]>([]);
  const [scheduleDraft, setScheduleDraft] = useState<TaskScheduleDraft>();
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const openedInitialTask = useRef(false);
  const openedInitialScheduleTask = useRef(false);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/tasks?includeCompleted=true", { cache: "no-store" });
      const payload = await response.json() as { ok: boolean; tasks?: readonly ClientTask[]; message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法读取任务");
      setTasks(payload.tasks ?? []);
      setFeedback(undefined);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取任务");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);
  useEffect(() => {
    void fetch("/api/calendars", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { readonly calendars?: readonly CalendarListItem[]; readonly message?: string };
        if (!response.ok || !payload.calendars) throw new Error(payload.message ?? "无法读取日历");
        setTaskCalendars(payload.calendars.filter((calendar) => !calendar.readOnly && calendar.providerData?.providerId === "local-calendar"));
      })
      .catch((error: unknown) => setFeedback(error instanceof Error ? error.message : "无法读取日历"));
  }, []);
  useEffect(() => {
    if (!initialTaskId || openedInitialTask.current || loading) return;
    openedInitialTask.current = true;
    const task = tasks.find((entry) => entry.id === initialTaskId);
    if (task) {
      setView(task.status === "inbox" ? "inbox" : task.status === "done" ? "completed" : task.status === "waiting" ? "waiting" : "today");
      setDraft(taskToDraft(task));
      setFeedback("已打开日程关联的任务");
    } else {
      setFeedback("关联任务已删除或已完成");
    }
  }, [initialTaskId, loading, tasks]);
  const saveDraft = async () => {
    if (!draft?.title.trim()) return;
    setBusyTaskId(draft.id ?? "new");
    try {
      const response = await fetch(draft.id ? `/api/tasks/${encodeURIComponent(draft.id)}` : "/api/tasks", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskDraftPayload(draft)),
      });
      const payload = await response.json() as { ok: boolean; task?: ClientTask; message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法保存任务");
      setTasks((current) => [payload.task!, ...current.filter((task) => task.id !== payload.task!.id)]);
      setDraft(undefined);
      setFeedback(draft.id ? "任务已更新" : "任务已创建");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const updateTask = async (task: ClientTask, changes: Partial<TaskDraft>) => {
    setBusyTaskId(task.id);
    try {
      const nextDraft = { ...taskToDraft(task), ...changes };
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskDraftPayload(nextDraft)),
      });
      const payload = await response.json() as { ok: boolean; task?: ClientTask; message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法更新任务");
      setTasks((current) => current.map((entry) => entry.id === task.id ? payload.task! : entry));
      setFeedback(changes.status === "done" ? "任务已完成" : "任务已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法更新任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const deleteTask = async (task: ClientTask) => {
    if (!window.confirm(`删除任务“${task.title}”？此操作无法撤销。`)) return;
    setBusyTaskId(task.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const payload = await response.json() as { ok: boolean; message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除任务");
      setTasks((current) => current.filter((entry) => entry.id !== task.id));
      setFeedback("任务已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const openTaskMenu = (task: ClientTask, x: number, y: number, returnFocus?: HTMLElement | null) => {
    setMenu({ taskId: task.id, x, y, returnFocus });
  };
  const menuTask = menu ? tasks.find((task) => task.id === menu.taskId) : undefined;
  const openSchedule = (task: ClientTask, block?: ClientTaskTimeBlock, returnToTaskDetails = false) => {
    setMenu(undefined);
    const calendar = block
      ? taskCalendars.find((entry) => entry.id === block.calendarId)
      : taskCalendars.find((entry) => entry.primary) ?? taskCalendars[0];
    if (!calendar) {
      setFeedback("没有可写的本地日历");
      return;
    }
    const start = block ? new Date(block.start) : nextCalendarHour(new Date());
    const end = block ? new Date(block.end) : new Date(start.getTime() + (task.estimatedMinutes ?? 60) * 60 * 1000);
    if (returnToTaskDetails) setDraft(undefined);
    setScheduleDraft({
      taskId: task.id,
      taskTitle: task.title,
      eventId: block?.eventId,
      returnTaskDraft: returnToTaskDetails ? draft : undefined,
      calendarId: calendar.id,
      startLocal: toLocalDateTimeInput(start),
      endLocal: toLocalDateTimeInput(end),
      conflicts: [],
    });
  };

  useEffect(() => {
    if (!initialScheduleTaskId || openedInitialScheduleTask.current || loading || taskCalendars.length === 0) return;
    openedInitialScheduleTask.current = true;
    const task = tasks.find((entry) => entry.id === initialScheduleTaskId);
    if (!task || task.status === "done") {
      setFeedback("待安排任务不存在或已经完成");
      return;
    }
    setView(task.status === "inbox" ? "inbox" : task.status === "waiting" ? "waiting" : "today");
    openSchedule(task);
  }, [initialScheduleTaskId, loading, taskCalendars, tasks]);

  const changeScheduleStart = (value: string) => {
    setScheduleDraft((current) => {
      if (!current) return current;
      const previousStart = new Date(current.startLocal);
      const previousEnd = new Date(current.endLocal);
      const nextStart = new Date(value);
      const duration = Math.max(5 * 60 * 1000, previousEnd.getTime() - previousStart.getTime());
      return {
        ...current,
        startLocal: value,
        endLocal: Number.isNaN(nextStart.getTime()) ? current.endLocal : toLocalDateTimeInput(new Date(nextStart.getTime() + duration)),
        conflicts: [],
      };
    });
  };

  const saveSchedule = async (allowConflicts = false) => {
    if (!scheduleDraft || scheduleBusy) return;
    const start = new Date(scheduleDraft.startLocal);
    const end = new Date(scheduleDraft.endLocal);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setFeedback("结束时间必须晚于开始时间");
      return;
    }
    setScheduleBusy(true);
    try {
      const endpoint = scheduleDraft.eventId
        ? `/api/tasks/${encodeURIComponent(scheduleDraft.taskId)}/schedule/${encodeURIComponent(scheduleDraft.eventId)}`
        : `/api/tasks/${encodeURIComponent(scheduleDraft.taskId)}/schedule`;
      const response = await fetch(endpoint, {
        method: scheduleDraft.eventId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarId: scheduleDraft.calendarId,
          start: start.toISOString(),
          end: end.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin",
          allowConflicts,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: ClientTask; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
      if (response.status === 409 && payload.conflicts?.length) {
        setScheduleDraft({ ...scheduleDraft, conflicts: payload.conflicts });
        setFeedback("所选时间与现有日程冲突");
        return;
      }
      if (!response.ok || !payload.task) throw new Error(payload.message ?? "无法安排任务");
      setTasks((current) => current.map((entry) => entry.id === payload.task!.id ? payload.task! : entry));
      setScheduleDraft(undefined);
      if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft);
      setFeedback(scheduleDraft.eventId ? "任务时间块已更新" : "任务已安排到日历");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法安排任务");
    } finally {
      setScheduleBusy(false);
    }
  };

  const deleteTaskTimeBlock = async (task: ClientTask, block: ClientTaskTimeBlock) => {
    if (scheduleBusy || !window.confirm(`删除时间块“${formatTaskBlockRange(block.start, block.end)}”？任务本身会保留。`)) return;
    setScheduleBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/schedule/${encodeURIComponent(block.eventId)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: ClientTask; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法删除时间块");
      setTasks((current) => current.map((entry) => entry.id === payload.task!.id ? payload.task! : entry));
      setFeedback("时间块已删除，任务仍然保留");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除时间块");
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleTaskCommand = (commandId: TaskCommandId) => {
    if (!menuTask) return;
    if (commandId === "task.complete") void updateTask(menuTask, { status: "done" });
    else if (commandId === "task.open-mail") {
      const source = menuTask.sourceReferences.find((entry) => entry.kind === "mail");
      const href = source ? taskSourceHref(source) : undefined;
      if (href) window.location.assign(href);
    }
    else if (commandId === "task.schedule") openSchedule(menuTask);
    else if (commandId === "task.edit") setDraft(taskToDraft(menuTask));
    else if (commandId === "task.toggle-important") void updateTask(menuTask, { important: !menuTask.important });
    else if (commandId === "task.toggle-urgent") void updateTask(menuTask, { urgencyMode: menuTask.isUrgent ? "not_urgent" : "urgent" });
    else if (commandId === "task.set-waiting") void updateTask(menuTask, { status: menuTask.status === "waiting" ? "next" : "waiting" });
    else if (commandId === "task.delete") void deleteTask(menuTask);
  };

  const inboxTasks = tasks.filter((task) => task.status === "inbox");
  const matrixTasks = tasks.filter((task) => task.status !== "inbox" && task.status !== "done");
  const completedTasks = tasks.filter((task) => task.status === "done");
  const waitingTasks = tasks.filter((task) => task.status === "waiting");
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const todayTasks = matrixTasks.filter((task) =>
    (task.dueAt && new Date(task.dueAt).getTime() <= todayEnd.getTime()) || (task.status === "next" && task.isUrgent),
  );
  const upcomingTasks = matrixTasks.filter((task) => task.dueAt && new Date(task.dueAt).getTime() > todayEnd.getTime());
  const projectTasks = matrixTasks.filter((task) => task.projectName);
  const visibleTasks = view === "inbox" ? inboxTasks
    : view === "upcoming" ? upcomingTasks
      : view === "waiting" ? waitingTasks
        : view === "completed" ? completedTasks
          : todayTasks;
  const taskViews: readonly TaskView[] = ["today", "inbox", "upcoming", "waiting", "projects", "completed", "matrix"];
  const viewCounts: Record<TaskView, number> = {
    today: todayTasks.length,
    inbox: inboxTasks.length,
    upcoming: upcomingTasks.length,
    waiting: waitingTasks.length,
    projects: new Set(projectTasks.map((task) => task.projectName)).size,
    completed: completedTasks.length,
    matrix: matrixTasks.length,
  };
  const editingTask = draft?.id ? tasks.find((task) => task.id === draft.id) : undefined;

  return (
    <div className="task-workspace">
      <nav className="task-view-tabs" aria-label="任务视图">
        {taskViews.map((item) => {
          const Icon = item === "today" ? CalendarClock : item === "inbox" ? Inbox : item === "upcoming" ? CalendarDays : item === "waiting" ? Pause : item === "projects" ? FolderPlus : item === "completed" ? CheckCircle2 : LayoutGrid;
          return <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}><Icon size={15} />{taskViewCopy[item].label}<span>{viewCounts[item]}</span></button>;
        })}
      </nav>

      <div className="task-view-heading">
        <div><h2>{taskViewCopy[view].label}</h2><p>{taskViewCopy[view].description}</p></div>
        <button className="secondary-button" onClick={() => setDraft(createEmptyTaskDraft(view === "matrix" ? "next" : "inbox"))}><Plus size={15} />添加任务</button>
      </div>

      {feedback && <div className="task-feedback" role="status"><AlertCircle size={14} />{feedback}<button aria-label="关闭提示" onClick={() => setFeedback(undefined)}><X size={13} /></button></div>}
      {loading ? (
        <div className="task-loading"><LoaderCircle className="spin" size={17} />正在读取任务…</div>
      ) : view === "matrix" ? (
        <TaskMatrix tasks={matrixTasks} busyTaskId={busyTaskId} onComplete={(task) => void updateTask(task, { status: "done" })} onEdit={(task) => setDraft(taskToDraft(task))} onMenu={openTaskMenu} />
      ) : view === "projects" ? (
        <TaskProjectGroups tasks={projectTasks} busyTaskId={busyTaskId} onComplete={(task) => void updateTask(task, { status: "done" })} onEdit={(task) => setDraft(taskToDraft(task))} onMenu={openTaskMenu} />
      ) : visibleTasks.length ? (
        <section className="panel task-list-panel">
          {visibleTasks.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => void updateTask(task, { status: task.status === "done" ? "next" : "done" })} onEdit={() => setDraft(taskToDraft(task))} onMenu={(x, y, returnFocus) => openTaskMenu(task, x, y, returnFocus)} />)}
        </section>
      ) : (
        <section className="panel task-empty-state">
          <div><CheckCircle2 size={22} /></div>
          <h3>{view === "inbox" ? "任务收集箱是空的" : view === "completed" ? "还没有已完成任务" : view === "waiting" ? "没有等待事项" : view === "upcoming" ? "没有后续截止任务" : "今天没有紧急任务"}</h3>
          <p>{view === "inbox" ? "先快速记下来，稍后再设置项目、截止时间和优先级。" : view === "completed" ? "完成任务后会在这里保留记录，也可以重新打开。" : view === "waiting" ? "将依赖他人的任务设为等待中，方便集中跟进。" : view === "upcoming" ? "给任务设置今天之后的截止时间，就会出现在这里。" : "可以从四象限里挑一项重要但不紧急的任务安排时间。"}</p>
          <button className="primary-button" onClick={() => setDraft(createEmptyTaskDraft(view === "inbox" ? "inbox" : "next"))}><Plus size={15} />新建任务</button>
        </section>
      )}

      {draft && (
        <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyTaskId) setDraft(undefined); }}>
          <section className="calendar-dialog task-dialog panel" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
            <header><div><span>{draft.id ? "整理下一步行动" : "快速收集，随后归类"}</span><h2 id="task-dialog-title">{draft.id ? "编辑任务" : "新建任务"}</h2></div><button aria-label="关闭" onClick={() => setDraft(undefined)} disabled={Boolean(busyTaskId)}><X size={18} /></button></header>
            <div className="task-form">
              <label className="task-title-field"><span>任务标题</span><input autoFocus value={draft.title} maxLength={240} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="要完成什么？" /></label>
              <label><span>状态</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as TaskStatus })}><option value="inbox">Inbox · 待整理</option><option value="next">下一步</option><option value="waiting">等待中</option><option value="someday">以后也许</option><option value="done">已完成</option></select></label>
              <label><span>紧急程度</span><select value={draft.urgencyMode} onChange={(event) => setDraft({ ...draft, urgencyMode: event.target.value as TaskUrgencyMode })}><option value="auto">自动（按截止时间）</option><option value="urgent">紧急</option><option value="not_urgent">不紧急</option></select></label>
              <label><span>截止时间</span><input type="datetime-local" value={draft.dueAt} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value })} /></label>
              <label><span>预计时长（分钟）</span><input type="number" min="5" max="1440" step="5" value={draft.estimatedMinutes} onChange={(event) => setDraft({ ...draft, estimatedMinutes: event.target.value })} placeholder="例如 45" /></label>
              <label><span>项目</span><input value={draft.projectName} maxLength={100} onChange={(event) => setDraft({ ...draft, projectName: event.target.value })} placeholder="例如 客户项目" /></label>
              <label><span>领域</span><input value={draft.areaName} maxLength={100} onChange={(event) => setDraft({ ...draft, areaName: event.target.value })} placeholder="例如 工作 / 个人" /></label>
              <label className="task-important-field"><input type="checkbox" checked={draft.important} onChange={(event) => setDraft({ ...draft, important: event.target.checked })} /><Star size={15} fill={draft.important ? "currentColor" : "none"} /><span>这是重要任务</span></label>
              <label className="task-notes-field"><span>备注</span><textarea value={draft.notes} maxLength={10_000} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="补充完成标准、等待事项或下一步…" /></label>
              {editingTask && <section className="task-time-blocks"><header><div><CalendarClock size={15} /><span>专注时间</span><em>{editingTask.scheduledBlocks.length}</em></div><button type="button" className="secondary-button" onClick={() => openSchedule(editingTask, undefined, true)}><Plus size={14} />添加时间</button></header>{editingTask.scheduledBlocks.length ? <div>{editingTask.scheduledBlocks.map((block) => <article key={block.eventId}><Link href={block.href}><CalendarClock size={14} /><span><strong>{formatTaskBlockRange(block.start, block.end)}</strong><small>{block.calendarName}</small></span></Link><button type="button" aria-label={`调整时间：${formatTaskBlockRange(block.start, block.end)}`} title="调整时间" onClick={() => openSchedule(editingTask, block, true)}><Pencil size={14} /></button><button type="button" className="danger-button" aria-label={`删除时间块：${formatTaskBlockRange(block.start, block.end)}`} title="删除时间块" disabled={scheduleBusy} onClick={() => void deleteTaskTimeBlock(editingTask, block)}><Trash2 size={14} /></button></article>)}</div> : <p>尚未安排专注时间。可以添加多个时间块，也可以稍后拖入日历。</p>}</section>}
              {draft.id && <RelatedContentPanel kind="task" entityId={draft.id} emptyText="这个任务还没有关联来源或时间块。" />}
            </div>
            <footer><small>截止时间不是日历安排；后续可以为同一任务添加一个或多个专注时间块。</small><div><button className="secondary-button" disabled={Boolean(busyTaskId)} onClick={() => setDraft(undefined)}>取消</button><button className="primary-button" disabled={Boolean(busyTaskId) || !draft.title.trim()} onClick={() => void saveDraft()}>{busyTaskId && <LoaderCircle className="spin" size={15} />}{draft.id ? "保存修改" : "创建任务"}</button></div></footer>
          </section>
        </div>
      )}

      {scheduleDraft && (
        <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !scheduleBusy) setScheduleDraft(undefined); }}>
          <section className="calendar-dialog task-schedule-dialog panel" role="dialog" aria-modal="true" aria-labelledby="task-schedule-title">
            <header><div><span>{scheduleDraft.eventId ? "调整已有专注时间块" : "创建可返回任务的专注时间块"}</span><h2 id="task-schedule-title">{scheduleDraft.eventId ? "调整安排" : "安排到日历"}</h2></div><button aria-label="关闭" onClick={() => { if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft); setScheduleDraft(undefined); }} disabled={scheduleBusy}><X size={18} /></button></header>
            <div className="task-schedule-summary"><ListChecks size={17} /><div><small>任务</small><strong>{scheduleDraft.taskTitle}</strong></div></div>
            <div className="calendar-form task-schedule-form">
              <label><span>开始</span><input type="datetime-local" value={scheduleDraft.startLocal} onChange={(event) => changeScheduleStart(event.target.value)} /></label>
              <label><span>结束</span><input type="datetime-local" value={scheduleDraft.endLocal} onChange={(event) => { const value = event.target.value; setScheduleDraft((current) => current ? { ...current, endLocal: value, conflicts: [] } : current); }} /></label>
              <label className="calendar-title-field"><span>日历</span><select value={scheduleDraft.calendarId} onChange={(event) => { const value = event.target.value; setScheduleDraft((current) => current ? { ...current, calendarId: value, conflicts: [] } : current); }}>{taskCalendars.map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}</select></label>
            </div>
            {scheduleDraft.conflicts.length > 0 && <div className="task-schedule-conflicts" role="alert"><header><AlertCircle size={16} /><strong>发现时间冲突</strong></header>{scheduleDraft.conflicts.map((conflict) => <div key={conflict.id}><span>{formatTaskBlockRange(conflict.start, conflict.end)}</span><strong>{conflict.title}</strong></div>)}<p>你可以修改时间，或者确认仍然安排。</p></div>}
            <footer><small>删除日历时间块不会删除原任务；任务完成后也会保留日历记录。</small><div><button className="secondary-button" disabled={scheduleBusy} onClick={() => { if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft); setScheduleDraft(undefined); }}>取消</button><button className={scheduleDraft.conflicts.length ? "danger-confirm-button" : "primary-button"} disabled={scheduleBusy} onClick={() => void saveSchedule(scheduleDraft.conflicts.length > 0)}>{scheduleBusy && <LoaderCircle className="spin" size={15} />}{scheduleDraft.conflicts.length ? "仍然安排" : scheduleDraft.eventId ? "保存时间" : "创建时间块"}</button></div></footer>
          </section>
        </div>
      )}

      {menu && menuTask && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          ariaLabel="任务操作"
          commands={resolveContextCommands({ kind: "task", id: menuTask.id, title: menuTask.title, busy: busyTaskId === menuTask.id, important: menuTask.important, urgent: menuTask.isUrgent, waiting: menuTask.status === "waiting", hasMailSource: menuTask.sourceReferences.some((source) => source.kind === "mail") })}
          heading={menuTask.title}
          returnFocus={menu.returnFocus}
          testId="task-context-menu"
          onClose={() => setMenu(undefined)}
          onSelect={(commandId) => handleTaskCommand(commandId as TaskCommandId)}
        />
      )}
    </div>
  );
}

function TaskProjectGroups({ tasks, busyTaskId, onComplete, onEdit, onMenu }: {
  readonly tasks: readonly ClientTask[];
  readonly busyTaskId?: string;
  readonly onComplete: (task: ClientTask) => void;
  readonly onEdit: (task: ClientTask) => void;
  readonly onMenu: (task: ClientTask, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const groups = Array.from(new Set(tasks.map((task) => task.projectName).filter((name): name is string => Boolean(name))));
  if (!groups.length) return <section className="panel task-empty-state"><div><FolderPlus size={22} /></div><h3>还没有项目任务</h3><p>在任务详情中填写项目名称，相关行动会自动汇总到这里。</p></section>;
  return <div className="task-project-groups">{groups.map((project) => {
    const entries = tasks.filter((task) => task.projectName === project);
    return <section className="panel" key={project}><header><div><FolderPlus size={15} /><strong>{project}</strong></div><span>{entries.length}</span></header>{entries.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}</section>;
  })}</div>;
}

function TaskMatrix({ tasks, busyTaskId, onComplete, onEdit, onMenu }: {
  readonly tasks: readonly ClientTask[];
  readonly busyTaskId?: string;
  readonly onComplete: (task: ClientTask) => void;
  readonly onEdit: (task: ClientTask) => void;
  readonly onMenu: (task: ClientTask, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const quadrants = [
    { key: "important-urgent", title: "重要且紧急", hint: "立即处理", important: true, urgent: true },
    { key: "important-calm", title: "重要不紧急", hint: "安排专注时间", important: true, urgent: false },
    { key: "urgent-light", title: "不重要但紧急", hint: "批量处理或委托", important: false, urgent: true },
    { key: "calm-light", title: "不重要不紧急", hint: "以后、归档或删除", important: false, urgent: false },
  ] as const;
  return (
    <div className="task-matrix">
      {quadrants.map((quadrant) => {
        const entries = tasks.filter((task) => task.important === quadrant.important && task.isUrgent === quadrant.urgent);
        return (
          <section className={`panel task-quadrant ${quadrant.key}`} key={quadrant.key}>
            <header><div><h3>{quadrant.title}</h3><p>{quadrant.hint}</p></div><span>{entries.length}</span></header>
            <div className="task-quadrant-list">
              {entries.map((task) => <TaskCard task={task} compact key={task.id} busy={busyTaskId === task.id} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}
              {!entries.length && <div className="task-quadrant-empty">暂无任务</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ task, busy, compact, onComplete, onEdit, onMenu }: {
  readonly task: ClientTask;
  readonly busy: boolean;
  readonly compact?: boolean;
  readonly onComplete: () => void;
  readonly onEdit: () => void;
  readonly onMenu: (x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const source = task.sourceReferences[0];
  const mailSource = task.sourceReferences.find((entry) => entry.kind === "mail");
  const scheduledBlock = task.scheduledBlocks[0];
  return (
    <article className={`task-card ${compact ? "compact" : ""}`} onContextMenu={(event) => { event.preventDefault(); onMenu(event.clientX, event.clientY, event.currentTarget); }}>
      <button className={`task-check ${task.status === "done" ? "completed" : ""}`} aria-label={`${task.status === "done" ? "重新打开" : "完成"} ${task.title}`} title={task.status === "done" ? "重新打开任务" : "标记为已完成"} disabled={busy} onClick={onComplete}>{busy ? <LoaderCircle className="spin" size={15} /> : task.status === "done" ? <RefreshCw size={15} /> : <Check size={15} />}</button>
      <button className="task-card-body" onClick={onEdit}>
        <strong>{task.title}</strong>
        <span className="task-card-meta">
          {task.dueAt && <em className={new Date(task.dueAt).getTime() < Date.now() ? "overdue" : undefined}><CalendarClock size={12} />{formatTaskDue(task.dueAt)}</em>}
          {task.estimatedMinutes && <em><Clock3 size={12} />{formatTaskEstimate(task.estimatedMinutes)}</em>}
          {task.projectName && <em>{task.projectName}</em>}
          {task.areaName && <em>{task.areaName}</em>}
          {source && <em><Link2 size={12} />{source.label}</em>}
          {scheduledBlock && <em className="scheduled"><CalendarClock size={12} />{task.scheduledBlockCount > 1 ? `已安排 ${task.scheduledBlockCount} 个时间块 · ` : "已安排 "}{formatTaskBlockRange(scheduledBlock.start, scheduledBlock.end)}</em>}
          {task.status === "waiting" && <em>等待中</em>}
        </span>
      </button>
      <div className="task-card-flags">{scheduledBlock && <Link className="task-calendar-link" href={scheduledBlock.href} aria-label={`打开安排的日程：${scheduledBlock.title}`} title={`打开安排的日程：${formatTaskBlockRange(scheduledBlock.start, scheduledBlock.end)}`}><CalendarClock size={13} /></Link>}{mailSource && <Link className="task-source-link" href={taskSourceHref(mailSource) ?? "/inbox"} aria-label={`打开关联邮件：${mailSource.label}`} title={`打开关联邮件：${mailSource.label}`}><Mail size={13} /></Link>}{task.important && <Star size={13} fill="currentColor" />}{task.isUrgent && <span>急</span>}</div>
      <button className="task-menu-trigger" aria-label={`更多操作：${task.title}`} aria-expanded={false} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); onMenu(bounds.right, bounds.bottom + 4, event.currentTarget); }}><MoreHorizontal size={15} /></button>
    </article>
  );
}

function createEmptyTaskDraft(status: TaskStatus): TaskDraft {
  return { title: "", notes: "", status, important: false, urgencyMode: "auto", dueAt: "", estimatedMinutes: "", projectName: "", areaName: "", sourceReferences: [] };
}

function taskToDraft(task: ClientTask): TaskDraft {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes ?? "",
    status: task.status,
    important: task.important,
    urgencyMode: task.urgencyMode,
    dueAt: task.dueAt ? toLocalDateTimeInput(new Date(task.dueAt)) : "",
    estimatedMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : "",
    projectName: task.projectName ?? "",
    areaName: task.areaName ?? "",
    sourceReferences: task.sourceReferences,
  };
}

function taskDraftPayload(draft: TaskDraft) {
  return {
    title: draft.title,
    notes: draft.notes || undefined,
    status: draft.status,
    important: draft.important,
    urgencyMode: draft.urgencyMode,
    dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : undefined,
    estimatedMinutes: draft.estimatedMinutes ? Number(draft.estimatedMinutes) : undefined,
    projectName: draft.projectName || undefined,
    areaName: draft.areaName || undefined,
    sourceReferences: draft.sourceReferences.map(({ kind, sourceId, label, href }) => ({ kind, sourceId, label, href })),
  };
}

function mailMessageHref(messageId: string): string {
  return `/inbox?message=${encodeURIComponent(messageId)}`;
}

function taskSourceHref(source: ClientTaskSource): string | undefined {
  if (source.kind === "mail") return mailMessageHref(source.sourceId);
  return source.href;
}

function formatTaskBlockRange(startValue: string, endValue: string): string {
  const start = new Date(startValue);
  const end = new Date(endValue);
  const sameDay = start.toDateString() === end.toDateString();
  const day = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time.format(start)}–${sameDay ? time.format(end) : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}

function formatTaskDue(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat("zh-CN", sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatTaskEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

function taskSourceLabel(kind: ClientTaskSource["kind"]): string {
  return kind === "mail" ? "邮件" : kind === "calendar" ? "日历" : "笔记";
}

type ClientNoteType = "general" | "meeting" | "email" | "project" | "daily";
type NoteFilter = "all" | "pinned" | "unfiled" | string;
type NoteSaveState = "saved" | "saving" | "error";

interface ClientProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly areaName?: string;
  readonly color: string;
  readonly status: "active" | "archived";
  readonly noteCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ClientLinkedNoteTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly href: string;
}

interface ClientNote {
  readonly id: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
  readonly title: string;
  readonly content: string;
  readonly noteType: ClientNoteType;
  readonly pinned: boolean;
  readonly linkedTasks: readonly ClientLinkedNoteTask[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectDraft {
  readonly name: string;
  readonly description: string;
  readonly areaName: string;
  readonly color: string;
}

interface NoteContextMenuState {
  readonly noteId: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

const noteTypeLabels: Record<ClientNoteType, string> = {
  general: "普通笔记",
  meeting: "会议记录",
  email: "邮件笔记",
  project: "项目文档",
  daily: "每日笔记",
};

function NotesPage({ initialNoteId }: { readonly initialNoteId?: string }) {
  const [projects, setProjects] = useState<readonly ClientProject[]>([]);
  const [notes, setNotes] = useState<readonly ClientNote[]>([]);
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ClientNote>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [saveState, setSaveState] = useState<NoteSaveState>("saved");
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>();
  const [noteMenu, setNoteMenu] = useState<NoteContextMenuState>();
  const [relatedVersion, setRelatedVersion] = useState(0);
  const [mobileNoteDetail, setMobileNoteDetail] = useState(Boolean(initialNoteId));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingNote = useRef<ClientNote | undefined>(undefined);
  const openedInitialNote = useRef(false);
  const noteTitleRef = useRef<HTMLInputElement>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const [projectsResponse, notesResponse] = await Promise.all([
        fetch("/api/projects", { cache: "no-store" }),
        fetch("/api/notes", { cache: "no-store" }),
      ]);
      const projectsPayload = await projectsResponse.json() as { readonly ok: boolean; readonly projects?: readonly ClientProject[]; readonly message?: string };
      const notesPayload = await notesResponse.json() as { readonly ok: boolean; readonly notes?: readonly ClientNote[]; readonly message?: string };
      if (!projectsResponse.ok || !projectsPayload.ok) throw new Error(projectsPayload.message ?? "无法读取项目");
      if (!notesResponse.ok || !notesPayload.ok) throw new Error(notesPayload.message ?? "无法读取笔记");
      const loadedNotes = notesPayload.notes ?? [];
      setProjects(projectsPayload.projects ?? []);
      setNotes(loadedNotes);
      const target = initialNoteId ? loadedNotes.find((note) => note.id === initialNoteId) : loadedNotes[0];
      setDraft(target);
      if (initialNoteId && !target) setFeedback("关联笔记已删除");
      else setFeedback(undefined);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取笔记工作区");
    } finally {
      setLoading(false);
    }
  }, [initialNoteId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const persistNote = useCallback(async (snapshot: ClientNote): Promise<ClientNote | undefined> => {
    setSaveState("saving");
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(snapshot.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.projectId,
          title: snapshot.title.trim() || "无标题笔记",
          content: snapshot.content,
          noteType: snapshot.noteType,
          pinned: snapshot.pinned,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法保存笔记");
      const saved = payload.note;
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note));
      if (pendingNote.current === snapshot) {
        pendingNote.current = undefined;
        setDraft((current) => current?.id === saved.id ? saved : current);
        setSaveState("saved");
      }
      return saved;
    } catch (error) {
      if (pendingNote.current === snapshot) setSaveState("error");
      setFeedback(error instanceof Error ? error.message : "无法保存笔记");
      return undefined;
    }
  }, []);

  const flushPendingNote = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const pending = pendingNote.current;
    return pending ? persistNote(pending) : draft;
  }, [draft, persistNote]);

  const updateDraft = (changes: Partial<Pick<ClientNote, "title" | "content" | "projectId" | "projectName" | "projectColor" | "noteType" | "pinned">>) => {
    if (!draft) return;
    const next = { ...draft, ...changes, updatedAt: new Date().toISOString() };
    setDraft(next);
    setNotes((current) => current.map((note) => note.id === next.id ? next : note));
    pendingNote.current = next;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persistNote(next); }, 700);
  };

  const createNote = useCallback(async () => {
    setBusy(true);
    try {
      await flushPendingNote();
      const projectId = projects.some((project) => project.id === filter) ? filter : undefined;
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "无标题笔记", content: EMPTY_PLATE_NOTE_CONTENT, noteType: "general", pinned: false }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建笔记");
      setNotes((current) => [payload.note!, ...current]);
      setDraft(payload.note);
      setMobileNoteDetail(true);
      setFeedback("笔记已创建，可以直接开始输入");
      setSaveState("saved");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建笔记");
    } finally {
      setBusy(false);
    }
  }, [filter, flushPendingNote, projects]);

  useEffect(() => {
    if (!initialNoteId || openedInitialNote.current || loading) return;
    openedInitialNote.current = true;
    const target = notes.find((note) => note.id === initialNoteId);
    if (target) {
      setFilter(target.projectId ?? "all");
      setDraft(target);
      setFeedback("已打开任务关联的笔记");
    }
  }, [initialNoteId, loading, notes]);

  const selectNote = (note: ClientNote) => {
    setMobileNoteDetail(true);
    if (note.id !== draft?.id) {
      void flushPendingNote();
      setDraft(note);
      setSaveState("saved");
    }
  };

  const deleteNote = async (target = draft) => {
    if (!target || !window.confirm(`删除笔记“${target.title}”？关联任务会保留，但不再显示此来源。`)) return;
    setBusy(true);
    try {
      if (target.id === draft?.id) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        pendingNote.current = undefined;
      }
      const response = await fetch(`/api/notes/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除笔记");
      const remaining = notes.filter((note) => note.id !== target.id);
      setNotes(remaining);
      setDraft((current) => current?.id === target.id ? remaining[0] : current);
      setFeedback("笔记已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除笔记");
    } finally {
      setBusy(false);
    }
  };

  const toggleNotePinned = async (note: ClientNote) => {
    setBusy(true);
    try {
      const source = note.id === draft?.id ? await flushPendingNote() ?? note : note;
      const snapshot = { ...source, pinned: !source.pinned, updatedAt: new Date().toISOString() };
      const response = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.projectId,
          title: snapshot.title.trim() || "无标题笔记",
          content: snapshot.content,
          noteType: snapshot.noteType,
          pinned: snapshot.pinned,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法更新笔记");
      setNotes((current) => current.map((entry) => entry.id === payload.note!.id ? payload.note! : entry));
      setDraft((current) => current?.id === payload.note!.id ? payload.note : current);
      setSaveState("saved");
      setFeedback(payload.note.pinned ? "笔记已置顶" : "已取消置顶");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法更新笔记");
    } finally {
      setBusy(false);
    }
  };

  const duplicateNote = async (note: ClientNote) => {
    setBusy(true);
    try {
      const source = note.id === draft?.id ? await flushPendingNote() ?? note : note;
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: source.projectId,
          title: `${source.title.slice(0, 237)} 副本`,
          content: source.content,
          noteType: source.noteType,
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建笔记副本");
      setNotes((current) => [payload.note!, ...current]);
      setDraft(payload.note);
      setSaveState("saved");
      setFeedback("笔记副本已创建");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建笔记副本");
    } finally {
      setBusy(false);
    }
  };

  const openNoteMenu = (note: ClientNote, x: number, y: number, returnFocus?: HTMLElement | null) => {
    selectNote(note);
    setNoteMenu({ noteId: note.id, x, y, returnFocus });
  };

  const handleNoteCommand = (commandId: ContextCommandId) => {
    const note = notes.find((entry) => entry.id === noteMenu?.noteId);
    if (!note) return;
    if (commandId === "note.open") selectNote(note);
    if (commandId === "note.rename") {
      selectNote(note);
      window.requestAnimationFrame(() => {
        noteTitleRef.current?.focus();
        noteTitleRef.current?.select();
      });
    }
    if (commandId === "note.toggle-pin") void toggleNotePinned(note);
    if (commandId === "note.duplicate") void duplicateNote(note);
    if (commandId === "note.delete") void deleteNote(note);
  };

  const createLinkedTask = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const note = await flushPendingNote() ?? draft;
      const plainText = noteContentToPlainText(note.content);
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `跟进：${note.title}`,
          notes: plainText.slice(0, 1_500) || undefined,
          status: "inbox",
          projectName: note.projectName,
          sourceReferences: [{ kind: "note", sourceId: note.id, label: note.title, href: `/notes?note=${encodeURIComponent(note.id)}` }],
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly task?: ClientTask; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法创建关联任务");
      const linkedTask: ClientLinkedNoteTask = { id: payload.task.id, title: payload.task.title, status: payload.task.status, href: `/tasks?task=${encodeURIComponent(payload.task.id)}` };
      const withTask = { ...note, linkedTasks: [linkedTask, ...note.linkedTasks.filter((task) => task.id !== linkedTask.id)] };
      setDraft(withTask);
      setNotes((current) => current.map((entry) => entry.id === note.id ? withTask : entry));
      setRelatedVersion((current) => current + 1);
      setFeedback("关联任务已创建，可从笔记或任务双向返回");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建关联任务");
    } finally {
      setBusy(false);
    }
  };

  const saveProject = async () => {
    if (!projectDraft?.name.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectDraft),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly project?: ClientProject; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.project) throw new Error(payload.message ?? "无法创建项目");
      setProjects((current) => [payload.project!, ...current]);
      setFilter(payload.project.id);
      setProjectDraft(undefined);
      setFeedback(`项目“${payload.project.name}”已创建`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建项目");
    } finally {
      setBusy(false);
    }
  };

  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return notes.filter((note) => {
      if (filter === "pinned" && !note.pinned) return false;
      if (filter === "unfiled" && note.projectId) return false;
      if (filter !== "all" && filter !== "pinned" && filter !== "unfiled" && note.projectId !== filter) return false;
      return !normalizedQuery || `${note.title}\n${noteContentToPlainText(note.content)}\n${note.projectName ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [filter, notes, query]);
  const activeFilterLabel = filter === "all"
    ? "全部笔记"
    : filter === "pinned"
      ? "已置顶"
      : filter === "unfiled"
        ? "未归档"
        : projects.find((project) => project.id === filter)?.name ?? "项目笔记";
  const menuNote = notes.find((note) => note.id === noteMenu?.noteId);

  return (
    <div className={`notes-page ${mobileNoteDetail ? "mobile-detail-open" : ""}`}>
      <section className="notes-filter-bar" aria-label="笔记空间">
        <nav className="notes-filter-scroll" aria-label="笔记筛选">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}><FileText size={15} /><span>全部</span><em>{notes.length}</em></button>
          <button className={filter === "pinned" ? "active" : ""} onClick={() => setFilter("pinned")}><Pin size={15} /><span>置顶</span><em>{notes.filter((note) => note.pinned).length}</em></button>
          <button className={filter === "unfiled" ? "active" : ""} onClick={() => setFilter("unfiled")}><Inbox size={15} /><span>未归档</span><em>{notes.filter((note) => !note.projectId).length}</em></button>
          {projects.length > 0 && <span className="notes-filter-divider" aria-hidden="true" />}
          {projects.map((project) => <button className={`project-filter ${filter === project.id ? "active" : ""}`} key={project.id} onClick={() => setFilter(project.id)}><i style={{ background: project.color }} /><span>{project.name}</span><em>{notes.filter((note) => note.projectId === project.id).length}</em></button>)}
        </nav>
        <button className="notes-new-project" aria-label="新建项目" title="新建项目" onClick={() => setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5" })}><FolderPlus size={16} /><span>新建项目</span></button>
      </section>

      <div className={`notes-workspace ${mobileNoteDetail ? "mobile-detail-open" : ""}`}>
        <section className="notes-list-column">
        <header>
          <div className="notes-list-heading"><span><strong>{activeFilterLabel}</strong><small>{filteredNotes.length} 篇</small></span><button aria-label="新建笔记" title="新建笔记" disabled={busy} onClick={() => void createNote()}><Plus size={17} /></button></div>
          <label><Search size={16} /><input aria-label="搜索笔记" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或正文…" /></label>
        </header>
        {feedback && <div className="notes-feedback" role="status"><span>{feedback}</span><button aria-label="关闭提示" onClick={() => setFeedback(undefined)}><X size={12} /></button></div>}
        <div className="notes-list">
          {loading ? <div className="notes-list-empty"><LoaderCircle className="spin" size={17} />正在读取笔记…</div> : filteredNotes.map((note) => (
            <div
              className={`note-list-item ${draft?.id === note.id ? "active" : ""}`}
              key={note.id}
              onContextMenu={(event) => {
                event.preventDefault();
                openNoteMenu(note, event.clientX, event.clientY, event.currentTarget.querySelector<HTMLButtonElement>(".note-list-main"));
              }}
            >
              <button
                className="note-list-main"
                onClick={() => selectNote(note)}
                onKeyDown={(event) => {
                  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openNoteMenu(note, bounds.right - 12, bounds.top + 28, event.currentTarget);
                }}
              >
                <span className="note-list-title-row"><strong>{note.title}</strong>{note.pinned && <Pin size={11} fill="currentColor" />}</span>
                <p>{noteContentToPlainText(note.content).trim().replace(/\s+/g, " ") || "空白笔记"}</p>
                <span className="note-list-meta">
                  <span>{note.projectColor && <i style={{ background: note.projectColor }} />}{note.projectName ?? noteTypeLabels[note.noteType]}</span>
                  <time dateTime={note.updatedAt}>{formatNoteUpdated(note.updatedAt)}</time>
                </span>
              </button>
              <button
                className="note-menu-trigger"
                aria-label={`更多操作：${note.title}`}
                aria-expanded={noteMenu?.noteId === note.id}
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openNoteMenu(note, bounds.right, bounds.bottom + 4, event.currentTarget);
                }}
              ><MoreHorizontal size={16} /></button>
            </div>
          ))}
          {!loading && !filteredNotes.length && <div className="notes-list-empty"><NotebookPen size={20} /><span>{query ? "没有匹配的笔记" : "这个位置还没有笔记"}</span><button onClick={() => void createNote()}>创建第一篇</button></div>}
        </div>
        </section>

        <article className="note-editor">
        {draft ? <>
          <header className="note-editor-toolbar">
            <div>
              <button className="mobile-detail-back" aria-label="返回笔记列表" onClick={() => setMobileNoteDetail(false)}><ChevronLeft size={20} /></button>
              <select aria-label="笔记所属项目" value={draft.projectId ?? ""} onChange={(event) => {
                const project = projects.find((entry) => entry.id === event.target.value);
                updateDraft({ projectId: project?.id, projectName: project?.name, projectColor: project?.color });
              }}><option value="">未归档</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
              <select aria-label="笔记类型" value={draft.noteType} onChange={(event) => updateDraft({ noteType: event.target.value as ClientNoteType })}>{Object.entries(noteTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
              <input ref={noteTitleRef} className="note-title-inline" aria-label="笔记标题" value={draft.title} maxLength={240} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="无标题笔记" />
            </div>
            <div>
              <span className={`note-save-state ${saveState}`}><i />{saveState === "saving" ? "正在保存" : saveState === "error" ? "保存失败" : "已保存"}</span>
              <button className={draft.pinned ? "active" : ""} aria-label={draft.pinned ? "取消置顶" : "置顶笔记"} title={draft.pinned ? "取消置顶" : "置顶笔记"} onClick={() => updateDraft({ pinned: !draft.pinned })}><Pin size={15} fill={draft.pinned ? "currentColor" : "none"} /></button>
              <button className="danger-button" aria-label="删除笔记" title="删除笔记" disabled={busy} onClick={() => void deleteNote()}><Trash2 size={15} /></button>
            </div>
          </header>
          <div className="note-editor-body">
            <PlateNoteEditor noteId={draft.id} content={draft.content} onChange={(content) => updateDraft({ content })} />
          </div>
          <footer className="note-relations">
            <div className="note-relations-heading"><span><Link2 size={14} />关联任务</span><button className="secondary-button" disabled={busy} onClick={() => void createLinkedTask()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}转为任务</button></div>
            <RelatedContentPanel kind="note" entityId={draft.id} refreshKey={relatedVersion} hideHeading emptyText="还没有相关内容。创建任务或从日程建立会议笔记后会显示在这里。" />
          </footer>
        </> : <div className="note-editor-empty"><NotebookPen size={28} /><h3>选择一篇笔记开始</h3><p>笔记会自动保存，并可以归入项目或转为任务。</p><button className="primary-button" onClick={() => void createNote()}><Plus size={14} />新建笔记</button></div>}
        </article>
      </div>

      {noteMenu && menuNote && <ContextMenu
        anchor={{ x: noteMenu.x, y: noteMenu.y }}
        ariaLabel="笔记操作"
        heading={menuNote.title}
        commands={resolveContextCommands({ kind: "note", id: menuNote.id, title: menuNote.title, busy, pinned: menuNote.pinned })}
        returnFocus={noteMenu.returnFocus}
        testId="note-context-menu"
        onClose={() => setNoteMenu(undefined)}
        onSelect={(commandId) => handleNoteCommand(commandId as NoteCommandId)}
      />}

      {projectDraft && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setProjectDraft(undefined); }}>
        <section className="calendar-dialog note-project-dialog panel" role="dialog" aria-modal="true" aria-labelledby="note-project-dialog-title">
          <header><div><span>让笔记、任务和日程共享一个上下文</span><h2 id="note-project-dialog-title">新建项目</h2></div><button aria-label="关闭" onClick={() => setProjectDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="note-project-form">
            <label><span>项目名称</span><input autoFocus value={projectDraft.name} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="例如 Kalender 开发" /></label>
            <label><span>领域</span><input value={projectDraft.areaName} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, areaName: event.target.value })} placeholder="例如 工作 / 个人" /></label>
            <label className="note-project-color"><span>颜色</span><input type="color" value={projectDraft.color} onChange={(event) => setProjectDraft({ ...projectDraft, color: event.target.value })} /></label>
            <label className="note-project-description"><span>项目说明</span><textarea value={projectDraft.description} maxLength={2_000} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} placeholder="这个项目要达成什么？" /></label>
          </div>
          <footer><small>后续邮件、日历和任务也会使用同一个项目对象。</small><div><button className="secondary-button" disabled={busy} onClick={() => setProjectDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !projectDraft.name.trim()} onClick={() => void saveProject()}>{busy && <LoaderCircle className="spin" size={14} />}创建项目</button></div></footer>
        </section>
      </div>}
    </div>
  );
}

function formatNoteUpdated(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }).format(date);
}

function AiPage() {
  return <AiCommand />;
}

function AssistantPanel({ title, section }: { readonly title: string; readonly section: WorkspaceSection }) {
  const suggestion: Record<WorkspaceSection, string> = {
    today: "客户在等待今天的回复；完成后，11:00–12:30 有一段适合准备方案的专注时间。",
    inbox: "这封邮件包含两个行动项：确认交付时间，以及发送新的演示链接。",
    calendar: "周二上午有 90 分钟空档，可用于准备周三的项目演示。",
    tasks: "当前三个任务中，客户交付确认会阻塞后续工作，建议优先处理。",
    notes: "检测到一个尚未进入任务系统的行动项：周二前发送演示链接。",
    ai: "读取和分析可以自动进行；创建日程、发送邮件和删除数据需要确认。",
    settings: "只有测试通过的账户才能保存。密码和令牌只在服务端内存中用于本次验证。",
  };
  if (section === "settings") {
    return (
      <aside className="assistant-panel connection-assistant">
        <header><div className="assistant-icon"><ShieldCheck size={18} /></div><div><h2>{title}</h2><p>账户凭据与测试策略</p></div></header>
        <section className="insight-block"><span>先测试，后保存</span><p>{suggestion.settings}</p></section>
        <section className="suggestion-card"><h2><CheckCircle2 size={18} />测试内容</h2><p>验证登录身份、最小邮件读取权限、日历权限与响应耗时。测试不会发送邮件，也不会创建日程。</p></section>
      </aside>
    );
  }
  if (section === "ai") {
    return (
      <aside className="assistant-panel ai-safety-assistant">
        <header><div className="assistant-icon"><ShieldCheck size={18} /></div><div><h2>{title}</h2><p>阶段 2 · 纯对话模式</p></div></header>
        <section className="insight-block"><span>目前不会访问工作区</span><p>模型只会收到当前对话内容，不会读取邮件、日历、任务或笔记，也不能创建、发送或删除任何内容。</p></section>
        <section className="suggestion-card"><h2><CheckCircle2 size={18} />已经启用</h2><p>真实流式输出、停止生成、本地会话记录、模型选择，以及主模型在输出前失败时的一次备用回退。</p></section>
      </aside>
    );
  }
  return (
    <aside className="assistant-panel">
      <header><div className="assistant-icon"><Sparkles size={18} /></div><div><h2>{title}</h2><p>基于已连接的邮件、日历、任务和笔记</p></div></header>
      <section className="insight-block"><span>建议先确认交付时间</span><p>{suggestion[section]}</p></section>
      <section className="source-block"><h3>数据来源</h3><Source icon={<Mail />} title="确认下周交付安排" meta="工作邮箱 · 今天" /><Source icon={<CalendarDays />} title="客户同步会议" meta="今天 15:30" /><Source icon={<NotebookPen />} title="项目评审笔记" meta="昨天更新" /></section>
      <section className="suggestion-card"><h2><WandSparkles size={18} />建议操作</h2><p>创建任务“确认最终交付时间”，截止今天 13:00，并关联原邮件。</p><div><button className="primary-button">确认创建</button><button className="ghost-button">修改</button></div></section>
    </aside>
  );
}

function Source({ icon, title, meta }: { readonly icon: ReactNode; readonly title: string; readonly meta: string }) {
  return <div className="source-row"><span>{icon}</span><div><strong>{title}</strong><small>{meta}</small></div></div>;
}
