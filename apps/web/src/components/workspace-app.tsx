"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Archive,
  AlertCircle,
  ArrowRight,
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
  Folder,
  GripVertical,
  FolderPlus,
  HardDrive,
  Inbox,
  ImageIcon,
  Keyboard,
  LayoutGrid,
  Link2,
  ListChecks,
  LogOut,
  LoaderCircle,
  Mail,
  MapPin,
  MoreHorizontal,
  Monitor,
  Moon,
  NotebookPen,
  Pause,
  Palette,
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
  Sun,
  Trash2,
  Upload,
  UserRound,
  Users,
  WandSparkles,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { ContextMenu } from "./context-menu";
import { AppSelect } from "./app-select";
import { BrandLogo } from "./brand-logo";
import { MailSignatureSettings } from "./mail-signature-settings";
import { readThemePreference, saveThemePreference } from "./theme-controller";
import { TransientToast } from "./workspace-shared";
import {
  createClientEntityLink,
  MailProjectChip,
  ProjectAssociationControl,
  RelatedContentPanel,
} from "./pages/related-content";
import type { TaskView } from "./pages/tasks-page";

export type { TaskView } from "./pages/tasks-page";
import { GlobalCommandBar } from "./global-command-bar";
import { WorkspaceAssistantProvider, useWorkspaceAssistant } from "./workspace-assistant-context";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { appConfirm, appPrompt } from "@/components/app-dialog-provider";
import {
  RealtimeProvider,
  useRealtimeConnection,
  useRealtimeEvent,
  useRealtimeRefresh,
  type RealtimeEvent,
  type RealtimeTopic,
} from "@/components/realtime-context";
import {
  SyncSettingsProvider,
  useSyncSettings,
  type ClientSyncSettings,
} from "@/components/sync-settings-context";
import { useVisiblePageRefresh } from "@/hooks/use-visible-page-refresh";
import {
  resolveContextCommands,
  type CalendarAccountCommandId,
  type CalendarEventCommandId,
  type CalendarSlotCommandId,
  type ContextCommandId,
  type MailAccountCommandId,
  type MailMessageCommandId,
  type MailFolderCommandId,
  type NoteCommandId,
  type ProjectAreaCommandId,
  type ProjectCommandId,
  type ProjectGanttCommandId,
  type ResolvedContextCommand,
  type TaskCommandId,
} from "./context-commands";

const TodayPage = dynamic(
  () => import("./pages/today-page").then((module) => module.TodayPage),
  {
    loading: () => <EditorLoading label="正在加载 Today…" />,
    ssr: false,
  },
);

const InboxPage = dynamic(
  () => import("./pages/inbox-page").then((module) => module.InboxPage),
  {
    loading: () => <EditorLoading label="正在加载邮件…" />,
    ssr: false,
  },
);

const CalendarPage = dynamic(
  () => import("./pages/calendar-page").then((module) => module.CalendarPage),
  {
    loading: () => <EditorLoading label="正在加载日历…" />,
    ssr: false,
  },
);

const TasksPage = dynamic(
  () => import("./pages/tasks-page").then((module) => module.TasksPage),
  {
    loading: () => <EditorLoading label="正在加载任务…" />,
    ssr: false,
  },
);

const ProjectsPage = dynamic(
  () => import("./pages/projects-page").then((module) => module.ProjectsPage),
  {
    loading: () => <EditorLoading label="正在加载项目…" />,
    ssr: false,
  },
);

const NotesPage = dynamic(
  () => import("./pages/notes-page").then((module) => module.NotesPage),
  {
    loading: () => <EditorLoading label="正在加载笔记…" />,
    ssr: false,
  },
);

const AiCommand = dynamic(
  () => import("./ai-command").then((module) => module.AiCommand),
  {
    loading: () => <EditorLoading label="正在加载 AI 工作台…" />,
    ssr: false,
  },
);

const AiProviderSettings = dynamic(
  () => import("./ai-provider-settings").then((module) => module.AiProviderSettings),
  {
    loading: () => <EditorLoading label="正在加载 AI 设置…" />,
    ssr: false,
  },
);

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

export const sections = ["today", "inbox", "calendar", "tasks", "projects", "notes", "ai", "settings"] as const;
export type WorkspaceSection = (typeof sections)[number];

interface SidebarMailAccount {
  readonly id: string;
  readonly displayName: string;
  readonly color: string;
  readonly unreadCount: number;
  readonly lastSyncAt?: string;
  readonly syncStatus: "idle" | "syncing" | "ready" | "error" | "paused";
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

interface SidebarCalendarSource {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: {
    readonly providerId?: string;
    readonly accountId?: string;
  };
}

interface SidebarTaskSummary {
  readonly id: string;
  readonly status: "inbox" | "next" | "waiting" | "someday" | "done";
  readonly dueAt?: string;
  readonly isUrgent: boolean;
  readonly projectId?: string;
  readonly projectName?: string;
}

interface SidebarProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly areaName?: string;
  readonly color: string;
  readonly status: "active" | "archived";
  readonly noteCount?: number;
}

interface SidebarProjectMenuState {
  readonly projectId: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

interface SidebarProjectAreaMenuState {
  readonly areaName: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

interface SidebarMailAccountMenuState {
  readonly accountId: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

interface SidebarCalendarMenuState {
  readonly calendarId: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
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
  { section: "projects", label: "Projects", icon: Folder },
  { section: "notes", label: "Notes", icon: NotebookPen },
  { section: "ai", label: "AI Command", icon: WandSparkles },
];

const sidebarTaskViews: ReadonlyArray<{
  view: TaskView;
  label: string;
  icon: typeof Inbox;
}> = [
  { view: "today", label: "Today", icon: CalendarClock },
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "upcoming", label: "Upcoming", icon: CalendarDays },
  { view: "waiting", label: "Waiting", icon: Pause },
  { view: "projects", label: "项目", icon: FolderPlus },
  { view: "completed", label: "Completed", icon: CheckCircle2 },
  { view: "matrix", label: "四象限", icon: LayoutGrid },
];

type SettingsTab = "appearance" | "profile" | "users" | "diagnostics" | "jobs" | "operations" | "sync" | "mail" | "calendar" | "shortcuts" | "ai" | "backup";

const settingsNavigation: ReadonlyArray<{
  tab: SettingsTab;
  label: string;
  icon: typeof Inbox;
  adminOnly?: boolean;
}> = [
  { tab: "appearance", label: "外观", icon: Palette },
  { tab: "profile", label: "账号", icon: UserRound },
  { tab: "users", label: "用户管理", icon: Users, adminOnly: true },
  { tab: "diagnostics", label: "数据诊断", icon: ShieldCheck, adminOnly: true },
  { tab: "jobs", label: "后台任务", icon: Clock3 },
  { tab: "operations", label: "系统状态", icon: HardDrive, adminOnly: true },
  { tab: "sync", label: "同步", icon: RefreshCw },
  { tab: "mail", label: "邮箱账户", icon: Mail },
  { tab: "calendar", label: "日历账户", icon: CalendarDays },
  { tab: "shortcuts", label: "快捷键", icon: Keyboard },
  { tab: "ai", label: "AI 设置", icon: WandSparkles },
  { tab: "backup", label: "备份", icon: DatabaseBackup },
];

function visibleSettingsNavigation(role: AppRole) {
  return settingsNavigation.filter((item) => !item.adminOnly || role === "admin");
}

function normalizeSettingsTab(value: string | null | undefined, role: AppRole): SettingsTab {
  const visibleTabs = new Set(visibleSettingsNavigation(role).map((item) => item.tab));
  return visibleTabs.has(value as SettingsTab) ? value as SettingsTab : "appearance";
}

const pageAssistantTitles: Record<WorkspaceSection, string> = {
  today: "每日简报",
  inbox: "邮件助手",
  calendar: "日程建议",
  tasks: "任务建议",
  projects: "项目建议",
  notes: "笔记助手",
  ai: "安全边界",
  settings: "连接安全",
};

const DEFAULT_SIDEBAR_WIDTH = 176;
const MIN_SIDEBAR_WIDTH = 156;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = "kalender:workspace-sidebar-width";
const CONTEXT_ASSISTANT_STORAGE_KEY = "kalender:context-assistant-open";
const DEFAULT_CONTEXT_ASSISTANT_WIDTH = 320;
const MIN_CONTEXT_ASSISTANT_WIDTH = 280;
const MAX_CONTEXT_ASSISTANT_WIDTH = 560;
const CONTEXT_ASSISTANT_WIDTH_STORAGE_KEY = "kalender:context-assistant-width";
const MAIL_MESSAGE_DRAG_TYPE = "application/x-kalender-mail-message";
const MAIL_MESSAGE_MOVED_EVENT = "kalender:mail-message-moved";
const MAIL_SYNCED_EVENT = "kalender:mail-synced";
const CALENDAR_SYNCED_EVENT = "kalender:calendar-synced";
const TASKS_CHANGED_EVENT = "kalender:tasks-changed";
const PROJECTS_CHANGED_EVENT = "kalender:projects-changed";
const OPEN_PROJECT_DIALOG_EVENT = "kalender:open-project-dialog";
const EDIT_PROJECT_DIALOG_EVENT = "kalender:edit-project-dialog";

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

type AppRole = "admin" | "user" | "viewer";

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function clampContextAssistantWidth(width: number) {
  return Math.min(MAX_CONTEXT_ASSISTANT_WIDTH, Math.max(MIN_CONTEXT_ASSISTANT_WIDTH, Math.round(width)));
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  window.location.assign("/login");
}

function userInitialFor(displayName: string, email: string): string {
  const source = displayName.trim() || email.trim();
  return source.slice(0, 1).toUpperCase() || "U";
}

interface WorkspaceAppProps {
  readonly section: WorkspaceSection;
  readonly currentUser: {
    readonly id: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: AppRole;
  };
  readonly initialMessageId?: string;
  readonly initialMailFolderId?: string;
  readonly initialMailCorrespondent?: string;
  readonly initialComposeTo?: string;
  readonly initialTaskId?: string;
  readonly initialTaskView?: TaskView;
  readonly initialCreateTask?: boolean;
  readonly initialScheduleTaskId?: string;
  readonly initialEventId?: string;
  readonly initialCalendarDate?: string;
  readonly initialNoteId?: string;
  readonly initialNoteFilter?: "pinned" | "unfiled";
  readonly initialProjectId?: string;
}

export function WorkspaceApp(props: WorkspaceAppProps) {
  return (
    <RealtimeProvider>
      <SyncSettingsProvider>
        <WorkspaceAppContent {...props} />
      </SyncSettingsProvider>
    </RealtimeProvider>
  );
}

function WorkspaceAppContent({
  section,
  currentUser,
  initialMessageId,
  initialMailFolderId,
  initialMailCorrespondent,
  initialComposeTo,
  initialTaskId,
  initialTaskView,
  initialCreateTask,
  initialScheduleTaskId,
  initialEventId,
  initialCalendarDate,
  initialNoteId,
  initialNoteFilter,
  initialProjectId,
}: WorkspaceAppProps) {
  useVisualViewportLayout();
  const searchParams = useSearchParams();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantPreferenceLoaded, setAssistantPreferenceLoaded] = useState(false);
  const [assistantWidth, setAssistantWidth] = useState(DEFAULT_CONTEXT_ASSISTANT_WIDTH);
  const [assistantWidthLoaded, setAssistantWidthLoaded] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarWidthLoaded, setSidebarWidthLoaded] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sidebarMailAccounts, setSidebarMailAccounts] = useState<readonly SidebarMailAccount[]>();
  const [sidebarMailFolders, setSidebarMailFolders] = useState<readonly SidebarMailFolder[]>([]);
  const [sidebarMailUnreadCount, setSidebarMailUnreadCount] = useState(0);
  const [expandedMailAccounts, setExpandedMailAccounts] = useState<ReadonlySet<string>>(() => new Set());
  const [sidebarMailAccountMenu, setSidebarMailAccountMenu] = useState<SidebarMailAccountMenuState>();
  const [sidebarMailSyncBusyId, setSidebarMailSyncBusyId] = useState<string>();
  const [sidebarMailNotice, setSidebarMailNotice] = useState<string>();
  const [sidebarCalendars, setSidebarCalendars] = useState<readonly SidebarCalendarSource[]>();
  const [sidebarCalendarMenu, setSidebarCalendarMenu] = useState<SidebarCalendarMenuState>();
  const [sidebarCalendarSyncBusyId, setSidebarCalendarSyncBusyId] = useState<string>();
  const [sidebarCalendarNotice, setSidebarCalendarNotice] = useState<string>();
  const [sidebarTasks, setSidebarTasks] = useState<readonly SidebarTaskSummary[]>();
  const [sidebarProjects, setSidebarProjects] = useState<readonly SidebarProjectSummary[]>();
  const [sidebarProjectMenu, setSidebarProjectMenu] = useState<SidebarProjectMenuState>();
  const [sidebarProjectAreaMenu, setSidebarProjectAreaMenu] = useState<SidebarProjectAreaMenuState>();
  const [sidebarProjectAreaTargetId, setSidebarProjectAreaTargetId] = useState<string>();
  const [sidebarProjectBusyId, setSidebarProjectBusyId] = useState<string>();
  const [sidebarProjectNotice, setSidebarProjectNotice] = useState<string>();
  const [collapsedProjectAreas, setCollapsedProjectAreas] = useState<ReadonlySet<string>>(() => new Set());
  const userMenuRef = useRef<HTMLDivElement>(null);
  const activeSettingsTab = normalizeSettingsTab(searchParams.get("tab"), currentUser.role);
  const visibleSettingItems = visibleSettingsNavigation(currentUser.role);
  const sidebarUnreadCount = sidebarMailAccounts?.reduce((total, account) => total + account.unreadCount, 0)
    ?? sidebarMailUnreadCount;
  const userInitial = userInitialFor(currentUser.displayName, currentUser.email);
  const assistantAvailable = section === "inbox" || section === "calendar" || section === "tasks";

  useEffect(() => {
    try {
      setAssistantOpen(window.localStorage.getItem(CONTEXT_ASSISTANT_STORAGE_KEY) === "true");
    } catch {
      // The assistant remains collapsed when browser storage is unavailable.
    } finally {
      setAssistantPreferenceLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!assistantPreferenceLoaded) return;
    try {
      window.localStorage.setItem(CONTEXT_ASSISTANT_STORAGE_KEY, String(assistantOpen));
    } catch {
      // The current session still keeps the chosen state.
    }
  }, [assistantOpen, assistantPreferenceLoaded]);

  useEffect(() => {
    try {
      const storedWidth = Number(window.localStorage.getItem(CONTEXT_ASSISTANT_WIDTH_STORAGE_KEY));
      if (Number.isFinite(storedWidth) && storedWidth > 0) setAssistantWidth(clampContextAssistantWidth(storedWidth));
    } catch {
      // Keep the default width when browser storage is unavailable.
    } finally {
      setAssistantWidthLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!assistantWidthLoaded) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(CONTEXT_ASSISTANT_WIDTH_STORAGE_KEY, String(assistantWidth));
      } catch {
        // Resizing still works when browser storage is unavailable.
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [assistantWidth, assistantWidthLoaded]);

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
      workspaceFetch("/api/mail-accounts", {}, 0).then((response) => response.json()) as Promise<{ readonly accounts?: readonly Omit<SidebarMailAccount, "unreadCount">[] }>,
      workspaceFetch("/api/mail-folders", {}, 0).then((response) => response.json()) as Promise<{ readonly folders?: readonly SidebarMailFolder[] }>,
    ]);
    const folders = folderPayload.folders ?? [];
    const accounts = (accountPayload.accounts ?? []).map((account) => ({
      ...account,
      unreadCount: folders.filter((folder) => folder.accountId === account.id && folder.role === "inbox")
        .reduce((total, folder) => total + (folder.unreadCount ?? 0), 0),
    }));
    setSidebarMailAccounts(accounts);
    setSidebarMailFolders(folders);
    setSidebarMailUnreadCount(accounts.reduce((total, account) => total + account.unreadCount, 0));
    setExpandedMailAccounts((current) => current.size ? current : new Set(accounts.map((account) => account.id)));
  }, []);

  const syncSidebarMailAccount = async (account: SidebarMailAccount) => {
    if (sidebarMailSyncBusyId || account.syncStatus === "syncing" || account.syncStatus === "paused") return;
    setSidebarMailSyncBusyId(account.id);
    setSidebarMailNotice(`正在同步“${account.displayName}”…`);
    try {
      const response = await fetch(`/api/mail-accounts/${encodeURIComponent(account.id)}/sync`, { method: "POST" });
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly sync?: { readonly messagesProcessed?: number; readonly messagesRemoved?: number };
      };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "邮箱同步失败");
      await refreshSidebarMail();
      window.dispatchEvent(new Event(MAIL_SYNCED_EVENT));
      const changedCount = (payload.sync?.messagesProcessed ?? 0) + (payload.sync?.messagesRemoved ?? 0);
      setSidebarMailNotice(
        changedCount > 0
          ? `已同步“${account.displayName}”，更新 ${changedCount} 封邮件`
          : `已同步“${account.displayName}”，没有新的变化`,
      );
    } catch (error) {
      setSidebarMailNotice(error instanceof Error ? error.message : "邮箱同步失败");
    } finally {
      setSidebarMailSyncBusyId(undefined);
    }
  };

  const refreshSidebarMailSummary = useCallback(async () => {
    const response = await workspaceFetch("/api/mail-summary", {}, 0);
    const payload = await response.json() as { readonly ok?: boolean; readonly unreadCount?: number };
    if (!response.ok || !payload.ok) throw new Error("无法读取未读邮件数量");
    setSidebarMailUnreadCount(payload.unreadCount ?? 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (section === "inbox") {
      void refreshSidebarMail().catch(() => {
        if (!cancelled) setSidebarMailAccounts([]);
      });
    } else {
      setSidebarMailAccounts(undefined);
      setSidebarMailFolders([]);
      void refreshSidebarMailSummary()
        .catch(() => {
          if (!cancelled) setSidebarMailUnreadCount(0);
        });
    }
    return () => { cancelled = true; };
  }, [refreshSidebarMail, refreshSidebarMailSummary, section]);

  const refreshVisibleSidebarMail = useCallback(async () => {
    if (section === "inbox") await refreshSidebarMail();
    else await refreshSidebarMailSummary();
  }, [refreshSidebarMail, refreshSidebarMailSummary, section]);
  useVisiblePageRefresh(refreshVisibleSidebarMail);
  useRealtimeRefresh(["mail"], refreshVisibleSidebarMail);

  const refreshSidebarCalendars = useCallback(async () => {
    const response = await workspaceFetch("/api/calendars", {}, 0);
    const payload = await response.json() as { readonly ok?: boolean; readonly calendars?: readonly SidebarCalendarSource[] };
    if (!response.ok || !payload.ok) throw new Error("无法读取日历来源");
    setSidebarCalendars(payload.calendars ?? []);
  }, []);

  const refreshSidebarCalendar = async (calendar: SidebarCalendarSource) => {
    if (sidebarCalendarSyncBusyId) return;
    setSidebarCalendarMenu(undefined);
    setSidebarCalendarSyncBusyId(calendar.id);
    setSidebarCalendarNotice(`正在刷新“${calendar.name}”…`);
    try {
      const accountId = calendar.providerData?.accountId;
      let eventsProcessed: number | undefined;
      let mailSynced = false;
      if (accountId) {
        const response = await fetch(`/api/calendar-accounts/${encodeURIComponent(accountId)}/sync`, { method: "POST" });
        const payload = await response.json() as {
          readonly ok?: boolean;
          readonly message?: string;
          readonly sync?: { readonly eventsProcessed?: number };
          readonly mailSync?: unknown;
        };
        if (!response.ok || !payload.ok) throw new Error(payload.message ?? "日历刷新失败");
        eventsProcessed = payload.sync?.eventsProcessed;
        mailSynced = Boolean(payload.mailSync);
      }
      await refreshSidebarCalendars();
      window.dispatchEvent(new Event(CALENDAR_SYNCED_EVENT));
      if (mailSynced) window.dispatchEvent(new Event(MAIL_SYNCED_EVENT));
      setSidebarCalendarNotice(
        eventsProcessed === undefined
          ? `已刷新“${calendar.name}”`
          : `已刷新“${calendar.name}”，读取 ${eventsProcessed} 项日程`,
      );
    } catch (error) {
      setSidebarCalendarNotice(error instanceof Error ? error.message : "日历刷新失败");
    } finally {
      setSidebarCalendarSyncBusyId(undefined);
    }
  };

  const refreshSidebarTasks = useCallback(async () => {
    const response = await workspaceFetch("/api/tasks?includeCompleted=true");
    const payload = await response.json() as { readonly ok?: boolean; readonly tasks?: readonly SidebarTaskSummary[] };
    if (!response.ok || !payload.ok) throw new Error("无法读取任务分组");
    setSidebarTasks(payload.tasks ?? []);
  }, []);

  const refreshSidebarProjects = useCallback(async () => {
    const [projectsResponse, tasksResponse] = await Promise.all([
      workspaceFetch("/api/projects?includeArchived=true"),
      workspaceFetch("/api/tasks?includeCompleted=true"),
    ]);
    const projectsPayload = await projectsResponse.json() as { readonly ok?: boolean; readonly projects?: readonly SidebarProjectSummary[] };
    const tasksPayload = await tasksResponse.json() as { readonly ok?: boolean; readonly tasks?: readonly SidebarTaskSummary[] };
    if (!projectsResponse.ok || !projectsPayload.ok || !tasksResponse.ok || !tasksPayload.ok) throw new Error("无法读取项目列表");
    setSidebarProjects(projectsPayload.projects ?? []);
    setSidebarTasks(tasksPayload.tasks ?? []);
  }, []);
  const refreshRealtimeSidebarCalendars = useCallback(async () => {
    if (section === "calendar") await refreshSidebarCalendars();
  }, [refreshSidebarCalendars, section]);
  const refreshRealtimeSidebarTasks = useCallback(async () => {
    if (section === "tasks") await refreshSidebarTasks();
  }, [refreshSidebarTasks, section]);
  const refreshRealtimeSidebarProjects = useCallback(async () => {
    if (section === "projects" || section === "notes") await refreshSidebarProjects();
  }, [refreshSidebarProjects, section]);
  useRealtimeRefresh(["calendar"], refreshRealtimeSidebarCalendars);
  useRealtimeRefresh([], refreshRealtimeSidebarTasks);
  useRealtimeRefresh(["project", "task", "note"], refreshRealtimeSidebarProjects);
  const applyRealtimeSidebarTask = useCallback(async (event: RealtimeEvent) => {
    if (section !== "tasks") return;
    if (event.entityType !== "tasks" || !event.entityId) {
      await refreshSidebarTasks();
      return;
    }
    if (event.action === "delete") {
      setSidebarTasks((current) => current?.filter((task) => task.id !== event.entityId));
      return;
    }
    const response = await workspaceFetch(`/api/tasks/${encodeURIComponent(event.entityId)}`, {}, 0);
    if (response.status === 404) {
      setSidebarTasks((current) => current?.filter((task) => task.id !== event.entityId));
      return;
    }
    const payload = await response.json() as {
      readonly ok?: boolean;
      readonly task?: SidebarTaskSummary;
    };
    if (!response.ok || !payload.ok || !payload.task) throw new Error("无法增量刷新任务");
    setSidebarTasks((current) => {
      if (!current) return [payload.task!];
      const found = current.some((task) => task.id === payload.task!.id);
      return found
        ? current.map((task) => task.id === payload.task!.id ? payload.task! : task)
        : [payload.task!, ...current];
    });
  }, [refreshSidebarTasks, section]);
  useRealtimeEvent(["task"], (event) => {
    void applyRealtimeSidebarTask(event).catch(() => refreshSidebarTasks().catch(() => undefined));
  });

  useEffect(() => {
    if (section !== "calendar") return;
    setSidebarCalendars(undefined);
    void refreshSidebarCalendars().catch(() => setSidebarCalendars([]));
  }, [refreshSidebarCalendars, section]);

  useEffect(() => {
    if (section !== "tasks") return;
    setSidebarTasks(undefined);
    void refreshSidebarTasks().catch(() => setSidebarTasks([]));
    const refresh = () => { void refreshSidebarTasks().catch(() => undefined); };
    window.addEventListener(TASKS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, refresh);
  }, [refreshSidebarTasks, section]);

  useEffect(() => {
    if (section !== "projects" && section !== "notes") return;
    setSidebarProjects(undefined);
    void refreshSidebarProjects().catch(() => setSidebarProjects([]));
    const refresh = () => { void refreshSidebarProjects().catch(() => undefined); };
    window.addEventListener(PROJECTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, refresh);
  }, [refreshSidebarProjects, section]);

  useEffect(() => {
    if (!sidebarProjectNotice) return;
    const timer = window.setTimeout(() => setSidebarProjectNotice(undefined), 3600);
    return () => window.clearTimeout(timer);
  }, [sidebarProjectNotice]);

  const sidebarTaskCounts = sidebarTasks ? createSidebarTaskCounts(sidebarTasks) : undefined;
  const sidebarProjectTaskCounts = sidebarTasks ? createSidebarProjectTaskCounts(sidebarTasks) : undefined;
  const sidebarProjectNoteCounts = sidebarProjects
    ? new Map(sidebarProjects.map((project) => [project.id, project.noteCount ?? 0]))
    : undefined;
  const activeSidebarProjects = sidebarProjects?.filter((project) => project.status === "active") ?? [];
  const archivedSidebarProjects = sidebarProjects?.filter((project) => project.status === "archived") ?? [];
  const activeSidebarProjectGroups = groupSidebarProjectsByArea(activeSidebarProjects);
  const archivedSidebarProjectGroups = groupSidebarProjectsByArea(archivedSidebarProjects);
  const defaultSidebarProjectId = activeSidebarProjects[0]?.id ?? archivedSidebarProjects[0]?.id;
  const sidebarProjectMenuTarget = sidebarProjects?.find((project) => project.id === sidebarProjectMenu?.projectId);
  const sidebarProjectAreaTarget = sidebarProjects?.find((project) => project.id === sidebarProjectAreaTargetId);
  const allSidebarProjectAreas = Array.from(new Set([
    ...activeSidebarProjectGroups.map((group) => group.areaName),
    ...archivedSidebarProjectGroups.map((group) => group.areaName),
  ]));

  const updateSidebarProject = async (
    project: SidebarProjectSummary,
    changes: { readonly areaName?: string; readonly status?: SidebarProjectSummary["status"] },
    successMessage: string,
  ) => {
    if (sidebarProjectBusyId) return;
    setSidebarProjectBusyId(project.id);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: project.name,
          description: project.description,
          areaName: changes.areaName ?? project.areaName,
          color: project.color,
          status: changes.status ?? project.status,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法更新项目");
      await refreshSidebarProjects();
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setSidebarProjectNotice(successMessage);
    } catch (error) {
      setSidebarProjectNotice(error instanceof Error ? error.message : "无法更新项目");
    } finally {
      setSidebarProjectBusyId(undefined);
    }
  };

  const createSidebarProjectNote = async (project: SidebarProjectSummary) => {
    if (sidebarProjectBusyId || project.status === "archived") return;
    setSidebarProjectBusyId(project.id);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          title: `${project.name} 笔记`,
          content: "",
          noteType: "project",
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly note?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建项目笔记");
      window.location.assign(`/notes?note=${encodeURIComponent(payload.note.id)}`);
    } catch (error) {
      setSidebarProjectNotice(error instanceof Error ? error.message : "无法创建项目笔记");
      setSidebarProjectBusyId(undefined);
    }
  };

  const handleSidebarProjectCommand = async (commandId: ProjectCommandId) => {
    const project = sidebarProjectMenuTarget;
    if (!project) return;
    if (commandId === "project.open") window.location.assign(`/projects?project=${encodeURIComponent(project.id)}`);
    else if (commandId === "project.create-task") window.location.assign(`/tasks?project=${encodeURIComponent(project.id)}&create=true`);
    else if (commandId === "project.create-note") void createSidebarProjectNote(project);
    else if (commandId === "project.move-area") setSidebarProjectAreaTargetId(project.id);
    else if (commandId === "project.edit") {
      window.dispatchEvent(new CustomEvent<{ readonly projectId: string }>(EDIT_PROJECT_DIALOG_EVENT, { detail: { projectId: project.id } }));
      setSidebarOpen(false);
    } else if (commandId === "project.copy-link") {
      const href = new URL(`/projects?project=${encodeURIComponent(project.id)}`, window.location.origin).toString();
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(href);
          setSidebarProjectNotice("项目链接已复制");
        } catch {
          await appPrompt({
            title: "复制项目链接",
            description: "浏览器未允许自动写入剪贴板，请手动复制下面的地址。",
            defaultValue: href,
            confirmLabel: "关闭",
            selectOnFocus: true,
          });
        }
      } else {
        await appPrompt({
          title: "复制项目链接",
          description: "请手动复制下面的地址。",
          defaultValue: href,
          confirmLabel: "关闭",
          selectOnFocus: true,
        });
      }
    } else if (commandId === "project.archive") {
      if (await appConfirm({
        title: `归档项目“${project.name}”？`,
        description: "关联内容会保留，之后可以恢复该项目。",
        confirmLabel: "归档项目",
      })) {
        void updateSidebarProject(project, { status: "archived" }, `已归档“${project.name}”`);
      }
    } else if (commandId === "project.restore") {
      void updateSidebarProject(project, { status: "active" }, `已恢复“${project.name}”`);
    }
  };

  const handleSidebarProjectAreaCommand = async (commandId: ProjectAreaCommandId) => {
    const areaName = sidebarProjectAreaMenu?.areaName;
    if (!areaName) return;
    if (commandId === "project-area.create-project") {
      window.dispatchEvent(new CustomEvent<{ readonly areaName?: string }>(OPEN_PROJECT_DIALOG_EVENT, {
        detail: { areaName: areaName === "未分类" ? undefined : areaName },
      }));
      setSidebarOpen(false);
      return;
    }
    if (commandId === "project-area.rename") {
      if (areaName === "未分类") return;
      const projectsInArea = sidebarProjects?.filter((project) => project.areaName === areaName).length ?? 0;
      const input = await appPrompt({
        title: "重命名领域",
        description: `“${areaName}”中的 ${projectsInArea} 个项目会使用新名称；关联任务、笔记和日程不会改变。`,
        defaultValue: areaName,
        placeholder: "输入新的领域名称",
        confirmLabel: "重命名",
        selectOnFocus: true,
      });
      if (input === null) return;
      const name = input.trim();
      if (!name || name.length > 100) {
        setSidebarProjectNotice("领域名称需要 1–100 个字符");
        return;
      }
      if (name === "未分类") {
        setSidebarProjectNotice("“未分类”是系统分组，不能作为领域名称");
        return;
      }
      if (name === areaName) return;
      setSidebarProjectBusyId(`area:${areaName}`);
      try {
        const response = await fetch("/api/projects/areas", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previousName: areaName, name }),
        });
        const payload = await response.json() as {
          readonly ok?: boolean;
          readonly result?: { readonly projectsUpdated?: number };
          readonly message?: string;
        };
        if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法重命名领域");
        setCollapsedProjectAreas((current) => {
          if (!current.has(areaName)) return current;
          const next = new Set(current);
          next.delete(areaName);
          next.add(name);
          return next;
        });
        await refreshSidebarProjects();
        window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
        setSidebarProjectNotice(`已将“${areaName}”重命名为“${name}”，更新 ${payload.result?.projectsUpdated ?? projectsInArea} 个项目`);
      } catch (error) {
        setSidebarProjectNotice(error instanceof Error ? error.message : "无法重命名领域");
      } finally {
        setSidebarProjectBusyId(undefined);
      }
      return;
    }
    if (commandId === "project-area.toggle") {
      setCollapsedProjectAreas((current) => {
        const next = new Set(current);
        if (next.has(areaName)) next.delete(areaName); else next.add(areaName);
        return next;
      });
      return;
    }
    setCollapsedProjectAreas(new Set(allSidebarProjectAreas.filter((entry) => entry !== areaName)));
  };

  return (
    <WorkspaceAssistantProvider>
    <div className="app-shell" style={{ "--workspace-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <BrandLogo className="brand-mark" />
          <div><strong>Dayline</strong><span>Quiet Intelligence</span></div>
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

        {section === "settings" && <div className="account-block sidebar-context-block settings-sidebar-block">
          <nav className="sidebar-settings-links" aria-label="设置分类">
            {visibleSettingItems.map(({ tab, label, icon: Icon }) => (
              <Link
                className={activeSettingsTab === tab ? "active" : ""}
                href={`/settings?tab=${tab}`}
                key={tab}
                onClick={() => setSidebarOpen(false)}
              >
                <Icon size={14} />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
        </div>}

        {section === "inbox" && <div className="account-block">
          <p className="eyebrow">邮箱账户</p>
          {sidebarMailAccounts === undefined ? <small>正在读取账户…</small> : sidebarMailAccounts.length ? <>
            {sidebarMailAccounts.map((account) => {
              const expanded = expandedMailAccounts.has(account.id);
              return <div className="mail-account-tree" key={account.id}>
                <button
                  className="mail-account-toggle"
                  aria-expanded={expanded}
                  aria-haspopup="menu"
                  onClick={() => setExpandedMailAccounts((current) => {
                    const next = new Set(current);
                    if (next.has(account.id)) next.delete(account.id); else next.add(account.id);
                    return next;
                  })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSidebarProjectMenu(undefined);
                    setSidebarProjectAreaMenu(undefined);
                    setSidebarMailAccountMenu({
                      accountId: account.id,
                      x: event.clientX,
                      y: event.clientY,
                      returnFocus: event.currentTarget,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setSidebarMailAccountMenu({
                      accountId: account.id,
                      x: bounds.right - 12,
                      y: bounds.bottom + 4,
                      returnFocus: event.currentTarget,
                    });
                  }}
                >
                  {sidebarMailSyncBusyId === account.id
                    ? <LoaderCircle className="spin" size={13} />
                    : <ChevronDown className={expanded ? "" : "collapsed"} size={13} />}
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
        </div>}

        {section === "calendar" && <div className="account-block sidebar-context-block">
          <p className="eyebrow">日历来源</p>
          {sidebarCalendars === undefined ? <small>正在读取日历…</small> : sidebarCalendars.length
            ? <div className="sidebar-calendar-list">{sidebarCalendars.map((calendar) => <div
              className="sidebar-calendar-source"
              key={calendar.id}
              role="button"
              tabIndex={0}
              aria-label={`${calendar.name} 日历操作`}
              onContextMenu={(event) => {
                event.preventDefault();
                setSidebarCalendarMenu({
                  calendarId: calendar.id,
                  x: event.clientX,
                  y: event.clientY,
                  returnFocus: event.currentTarget,
                });
              }}
            >
              {sidebarCalendarSyncBusyId === calendar.id
                ? <LoaderCircle className="spin" size={13} />
                : <i style={{ background: calendar.color ?? "#86bdf5" }} />}
              <span><strong>{calendar.name}</strong><small>{sidebarCalendarSourceLabel(calendar)}</small></span>
              {calendar.primary && <em>默认</em>}
            </div>)}</div>
            : <Link className="sidebar-connect-mail" href="/settings"><Plus size={13} />连接日历</Link>}
        </div>}

        {section === "tasks" && <div className="account-block sidebar-context-block">
          <p className="eyebrow">ToDo 分组</p>
          {sidebarTasks === undefined ? <small>正在读取任务…</small> : <nav className="sidebar-task-groups" aria-label="ToDo 分组">
            {sidebarTaskViews.map(({ view, label, icon: Icon }) => <Link className={initialTaskView === view || (!initialTaskView && view === "today") ? "active" : ""} href={`/tasks?view=${view}`} key={view} onClick={() => setSidebarOpen(false)}>
              <Icon size={14} /><span>{label}</span><em>{sidebarTaskCounts?.[view] ?? 0}</em>
            </Link>)}
          </nav>}
        </div>}

        {section === "projects" && <div className="account-block sidebar-context-block">
          <div className="sidebar-context-heading">
            <p className="eyebrow">项目</p>
            <button
              type="button"
              aria-label="新建项目"
              title="新建项目"
              onClick={() => {
                window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
                setSidebarOpen(false);
              }}
            ><Plus size={14} /></button>
          </div>
          {sidebarProjectNotice && <div className="sidebar-project-notice" role="status">{sidebarProjectNotice}</div>}
          {sidebarProjects === undefined ? <small>正在读取项目…</small> : sidebarProjects.length ? <>
            <SidebarProjectGroups
              collapsedAreas={collapsedProjectAreas}
              groups={activeSidebarProjectGroups}
              selectedProjectId={initialProjectId ?? defaultSidebarProjectId}
              counts={sidebarProjectTaskCounts}
              onNavigate={() => setSidebarOpen(false)}
              onAreaContextMenu={(areaName, x, y, returnFocus) => {
                setSidebarProjectMenu(undefined);
                setSidebarProjectAreaMenu({ areaName, x, y, returnFocus });
              }}
              onToggleArea={(areaName) => setCollapsedProjectAreas((current) => {
                const next = new Set(current);
                if (next.has(areaName)) next.delete(areaName); else next.add(areaName);
                return next;
              })}
              onProjectContextMenu={(projectId, x, y, returnFocus) => {
                setSidebarProjectAreaMenu(undefined);
                setSidebarProjectMenu({ projectId, x, y, returnFocus });
              }}
            />
            {archivedSidebarProjects.length > 0 && <details className="sidebar-archived-projects">
              <summary><Archive size={12} />已归档<span>{archivedSidebarProjects.length}</span></summary>
              <SidebarProjectGroups
                collapsedAreas={collapsedProjectAreas}
                groups={archivedSidebarProjectGroups}
                selectedProjectId={initialProjectId ?? defaultSidebarProjectId}
                counts={sidebarProjectTaskCounts}
                onNavigate={() => setSidebarOpen(false)}
                onAreaContextMenu={(areaName, x, y, returnFocus) => {
                  setSidebarProjectMenu(undefined);
                  setSidebarProjectAreaMenu({ areaName, x, y, returnFocus });
                }}
                onToggleArea={(areaName) => setCollapsedProjectAreas((current) => {
                  const next = new Set(current);
                  if (next.has(areaName)) next.delete(areaName); else next.add(areaName);
                  return next;
                })}
                onProjectContextMenu={(projectId, x, y, returnFocus) => {
                  setSidebarProjectAreaMenu(undefined);
                  setSidebarProjectMenu({ projectId, x, y, returnFocus });
                }}
              />
            </details>}
          </> : <button className="sidebar-create-project" type="button" onClick={() => {
            window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
            setSidebarOpen(false);
          }}><Plus size={13} />创建第一个项目</button>}
        </div>}

        {section === "notes" && <div className="account-block sidebar-context-block">
          <div className="sidebar-context-heading">
            <p className="eyebrow">笔记项目</p>
            <button
              type="button"
              aria-label="新建项目"
              title="新建项目"
              onClick={() => {
                window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
                setSidebarOpen(false);
              }}
            ><Plus size={14} /></button>
          </div>
          {sidebarProjects === undefined ? <small>正在读取项目…</small> : activeSidebarProjects.length ? <SidebarProjectGroups
            collapsedAreas={collapsedProjectAreas}
            groups={activeSidebarProjectGroups}
            selectedProjectId={initialProjectId}
            counts={sidebarProjectNoteCounts}
            countLabel="篇笔记"
            projectHref={(project) => `/notes?project=${encodeURIComponent(project.id)}`}
            onNavigate={() => setSidebarOpen(false)}
            onToggleArea={(areaName) => setCollapsedProjectAreas((current) => {
              const next = new Set(current);
              if (next.has(areaName)) next.delete(areaName); else next.add(areaName);
              return next;
            })}
          /> : <button className="sidebar-create-project" type="button" onClick={() => {
            window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
            setSidebarOpen(false);
          }}><Plus size={13} />创建第一个项目</button>}
        </div>}

        <div className="sidebar-user-area" ref={userMenuRef}>
          {userMenuOpen && (
            <div className="sidebar-user-menu" role="menu">
              <Link href="/settings" role="menuitem" onClick={() => { setUserMenuOpen(false); setSidebarOpen(false); }}>
                <Settings size={16} /><span><strong>账户设置</strong><small>邮件、日历与服务连接</small></span>
              </Link>
              <button type="button" role="menuitem" onClick={() => void logout()}>
                <LogOut size={16} /><span><strong>退出登录</strong><small>结束当前工作台会话</small></span>
              </button>
            </div>
          )}
          <button
            className={`sidebar-footer ${section === "settings" ? "active" : ""}`}
            aria-expanded={userMenuOpen}
            aria-haspopup="menu"
            onClick={() => setUserMenuOpen((value) => !value)}
          >
            <div className="avatar">{userInitial}</div>
            <div><strong>{currentUser.displayName}</strong><span>{roleLabel(currentUser.role)}</span></div>
            <ChevronDown className={userMenuOpen ? "user-menu-chevron-open" : ""} size={15} />
          </button>
        </div>
        <SidebarResizeHandle width={sidebarWidth} onChange={setSidebarWidth} />
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

      <section className="workspace">
        <GlobalCommandBar
          onOpenSidebar={() => setSidebarOpen(true)}
          assistantAvailable={assistantAvailable}
          assistantOpen={assistantOpen}
          onToggleAssistant={() => setAssistantOpen((open) => !open)}
        />

        <div
          className={`page-grid ${section === "notes" ? "notes-page-grid" : ""} ${section === "today" ? "today-page-grid" : ""} ${section === "projects" ? "projects-page-grid" : ""} ${section === "calendar" ? "calendar-page-grid" : ""} ${section === "tasks" ? "tasks-page-grid" : ""} ${assistantAvailable && assistantOpen ? "context-assistant-open" : ""}`}
          style={{ "--context-assistant-width": `${assistantWidth}px` } as CSSProperties}
        >
          <main className="page-main">
            <PageContent section={section} currentUser={currentUser} initialMessageId={initialMessageId} initialMailFolderId={initialMailFolderId} initialMailCorrespondent={initialMailCorrespondent} initialComposeTo={initialComposeTo} initialTaskId={initialTaskId} initialTaskView={initialTaskView} initialCreateTask={initialCreateTask} initialScheduleTaskId={initialScheduleTaskId} initialEventId={initialEventId} initialCalendarDate={initialCalendarDate} initialNoteId={initialNoteId} initialNoteFilter={initialNoteFilter} initialProjectId={initialProjectId} onOpenAssistant={() => setAssistantOpen(true)} />
          </main>
          {assistantAvailable && assistantOpen && <>
            <button className="assistant-scrim" type="button" aria-label="关闭上下文助手" onClick={() => setAssistantOpen(false)} />
            <ContextAssistantResizeHandle width={assistantWidth} onChange={setAssistantWidth} />
            <AssistantPanel title={pageAssistantTitles[section]} section={section} onClose={() => setAssistantOpen(false)} />
          </>}
        </div>
      </section>
      <MobileBottomNav section={section} unreadCount={sidebarUnreadCount} />
      {sidebarMailAccountMenu && sidebarMailAccounts?.find((account) => account.id === sidebarMailAccountMenu.accountId) && (() => {
        const account = sidebarMailAccounts.find((item) => item.id === sidebarMailAccountMenu.accountId)!;
        const busy = sidebarMailSyncBusyId === account.id || account.syncStatus === "syncing";
        return <ContextMenu
          anchor={{ x: sidebarMailAccountMenu.x, y: sidebarMailAccountMenu.y }}
          ariaLabel={`邮箱账户操作：${account.displayName}`}
          commands={[{
            id: "mail-account.sync",
            label: busy ? "正在同步…" : "立即同步",
            group: "primary",
            risk: "external-write",
            icon: "refresh",
            disabledReason: account.syncStatus === "paused" ? "账户已暂停" : busy ? "同步进行中" : undefined,
          }]}
          heading={account.displayName}
          returnFocus={sidebarMailAccountMenu.returnFocus}
          testId="mail-account-context-menu"
          onClose={() => setSidebarMailAccountMenu(undefined)}
          onSelect={(commandId) => {
            if ((commandId as MailAccountCommandId) === "mail-account.sync") void syncSidebarMailAccount(account);
          }}
        />;
      })()}
      {sidebarMailNotice && <TransientToast message={sidebarMailNotice} onClose={() => setSidebarMailNotice(undefined)} duration={4_000} testId="mail-account-sync-notice" />}
      {sidebarCalendarMenu && sidebarCalendars?.find((calendar) => calendar.id === sidebarCalendarMenu.calendarId) && (() => {
        const calendar = sidebarCalendars.find((item) => item.id === sidebarCalendarMenu.calendarId)!;
        const busy = sidebarCalendarSyncBusyId === calendar.id;
        return <ContextMenu
          anchor={{ x: sidebarCalendarMenu.x, y: sidebarCalendarMenu.y }}
          ariaLabel={`日历操作：${calendar.name}`}
          commands={[{
            id: "calendar-account.sync",
            label: busy ? "正在刷新…" : "立即刷新",
            group: "primary",
            risk: calendar.providerData?.accountId ? "external-write" : "read",
            icon: "refresh",
            disabledReason: busy ? "刷新进行中" : undefined,
          }]}
          heading={calendar.name}
          returnFocus={sidebarCalendarMenu.returnFocus}
          testId="calendar-account-context-menu"
          onClose={() => setSidebarCalendarMenu(undefined)}
          onSelect={(commandId) => {
            if ((commandId as CalendarAccountCommandId) === "calendar-account.sync") void refreshSidebarCalendar(calendar);
          }}
        />;
      })()}
      {sidebarCalendarNotice && <TransientToast message={sidebarCalendarNotice} onClose={() => setSidebarCalendarNotice(undefined)} duration={4_000} testId="calendar-account-sync-notice" />}
      {sidebarProjectMenu && sidebarProjectMenuTarget && <ContextMenu
        anchor={{ x: sidebarProjectMenu.x, y: sidebarProjectMenu.y }}
        ariaLabel={`项目操作：${sidebarProjectMenuTarget.name}`}
        commands={resolveContextCommands({
          kind: "project",
          id: sidebarProjectMenuTarget.id,
          title: sidebarProjectMenuTarget.name,
          busy: sidebarProjectBusyId === sidebarProjectMenuTarget.id,
          archived: sidebarProjectMenuTarget.status === "archived",
        })}
        heading={sidebarProjectMenuTarget.name}
        returnFocus={sidebarProjectMenu.returnFocus}
        testId="project-context-menu"
        onClose={() => setSidebarProjectMenu(undefined)}
        onSelect={(commandId) => handleSidebarProjectCommand(commandId as ProjectCommandId)}
      />}
      {sidebarProjectAreaMenu && <ContextMenu
        anchor={{ x: sidebarProjectAreaMenu.x, y: sidebarProjectAreaMenu.y }}
        ariaLabel={`领域操作：${sidebarProjectAreaMenu.areaName}`}
        commands={[
          { id: "project-area.create-project", label: "在此领域新建项目", group: "primary", risk: "local-write", icon: "folder" },
          { id: "project-area.rename", label: "重命名领域", group: "primary", risk: "local-write", icon: "edit", disabledReason: sidebarProjectAreaMenu.areaName === "未分类" ? "系统分组不能重命名" : sidebarProjectBusyId ? "操作进行中" : undefined },
          { id: "project-area.toggle", label: collapsedProjectAreas.has(sidebarProjectAreaMenu.areaName) ? "展开领域" : "折叠领域", group: "organize", risk: "read", icon: collapsedProjectAreas.has(sidebarProjectAreaMenu.areaName) ? "eye" : "eye-off" },
          { id: "project-area.collapse-others", label: "折叠其他领域", group: "organize", risk: "read", icon: "archive" },
        ]}
        heading={sidebarProjectAreaMenu.areaName}
        returnFocus={sidebarProjectAreaMenu.returnFocus}
        testId="project-area-context-menu"
        onClose={() => setSidebarProjectAreaMenu(undefined)}
        onSelect={(commandId) => void handleSidebarProjectAreaCommand(commandId as ProjectAreaCommandId)}
      />}
      {sidebarProjectAreaTarget && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sidebarProjectBusyId) setSidebarProjectAreaTargetId(undefined);
      }}>
        <section className="calendar-dialog project-area-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-area-dialog-title">
          <header><div><h2 id="project-area-dialog-title">移动到领域</h2></div><button aria-label="关闭" disabled={Boolean(sidebarProjectBusyId)} onClick={() => setSidebarProjectAreaTargetId(undefined)}><X size={18} /></button></header>
          <p>“{sidebarProjectAreaTarget.name}”所属领域</p>
          <div className="project-area-options">
            {Array.from(new Set([...allSidebarProjectAreas, "未分类"])).map((areaName) => {
              const currentAreaName = sidebarProjectAreaTarget.areaName?.trim() || "未分类";
              const current = areaName === currentAreaName;
              return <button key={areaName} type="button" className={current ? "active" : ""} disabled={current || Boolean(sidebarProjectBusyId)} onClick={() => {
                setSidebarProjectAreaTargetId(undefined);
                void updateSidebarProject(
                  sidebarProjectAreaTarget,
                  { areaName: areaName === "未分类" ? "" : areaName },
                  `已移动到“${areaName}”`,
                );
              }}><Folder size={14} /><span>{areaName}</span>{current && <Check size={13} />}</button>;
            })}
          </div>
        </section>
      </div>}
    </div>
    </WorkspaceAssistantProvider>
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

function ContextAssistantResizeHandle({
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
    document.body.classList.remove("assistant-is-resizing");
  }, []);

  useEffect(() => () => document.body.classList.remove("assistant-is-resizing"), []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragState.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, previewWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("assistant-is-resizing");
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.previewWidth = clampContextAssistantWidth(drag.startWidth - (event.clientX - drag.startX));
    event.currentTarget.closest<HTMLElement>(".page-grid")?.style.setProperty("--context-assistant-width", `${drag.previewWidth}px`);
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
    if (event.key === "ArrowLeft") nextWidth = width + step;
    if (event.key === "ArrowRight") nextWidth = width - step;
    if (event.key === "Home") nextWidth = MIN_CONTEXT_ASSISTANT_WIDTH;
    if (event.key === "End") nextWidth = MAX_CONTEXT_ASSISTANT_WIDTH;
    if (nextWidth === undefined) return;
    event.preventDefault();
    onChange(clampContextAssistantWidth(nextWidth));
  };

  return (
    <div
      className="assistant-resize-handle"
      role="separator"
      aria-label="调整邮件与助手的宽度"
      aria-orientation="vertical"
      aria-valuemin={MIN_CONTEXT_ASSISTANT_WIDTH}
      aria-valuemax={MAX_CONTEXT_ASSISTANT_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整宽度；双击恢复默认"
      onDoubleClick={() => onChange(DEFAULT_CONTEXT_ASSISTANT_WIDTH)}
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

  const handleFolderCommand = async (commandId: MailFolderCommandId) => {
    const folder = accountFolders.find((item) => item.id === folderMenu?.folderId);
    setFolderMenu(undefined);
    if (!folder) return;
    if (commandId === "mail-folder.create-child" || commandId === "mail-folder.create-sibling") {
      const name = await appPrompt({
        title: commandId === "mail-folder.create-child" ? "新建子文件夹" : "新建同级文件夹",
        description: commandId === "mail-folder.create-child" ? `位置：“${mailFolderLabel(folder)}”` : undefined,
        placeholder: "输入文件夹名称",
        confirmLabel: "创建",
      });
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
      const name = await appPrompt({
        title: "重命名文件夹",
        defaultValue: folder.name,
        placeholder: "输入文件夹名称",
        confirmLabel: "重命名",
        selectOnFocus: true,
      });
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

function sidebarCalendarSourceLabel(calendar: SidebarCalendarSource): string {
  const provider = calendar.providerData?.providerId;
  const source = provider === "local-calendar"
    ? "本地"
    : provider === "caldav"
      ? "CalDAV"
      : provider === "exchange"
        ? "Exchange"
        : provider === "ics"
          ? "ICS"
          : "日历";
  return `${source}${calendar.readOnly ? " · 只读" : ""}`;
}

function createSidebarTaskCounts(tasks: readonly SidebarTaskSummary[]): Record<TaskView, number> {
  const activeTasks = tasks.filter((task) => task.status !== "inbox" && task.status !== "done");
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const todayEndTime = todayEnd.getTime();

  return {
    today: activeTasks.filter((task) =>
      (task.dueAt && new Date(task.dueAt).getTime() <= todayEndTime)
      || (task.status === "next" && task.isUrgent),
    ).length,
    inbox: tasks.filter((task) => task.status === "inbox").length,
    upcoming: activeTasks.filter((task) => task.dueAt && new Date(task.dueAt).getTime() > todayEndTime).length,
    waiting: tasks.filter((task) => task.status === "waiting").length,
    projects: new Set(activeTasks.flatMap((task) => task.projectName ? [task.projectName] : [])).size,
    completed: tasks.filter((task) => task.status === "done").length,
    matrix: activeTasks.length,
  };
}

function createSidebarProjectTaskCounts(tasks: readonly SidebarTaskSummary[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.projectId || task.status === "done") continue;
    counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  }
  return counts;
}

interface SidebarProjectGroup {
  readonly areaName: string;
  readonly projects: readonly SidebarProjectSummary[];
}

function groupSidebarProjectsByArea(projects: readonly SidebarProjectSummary[]): readonly SidebarProjectGroup[] {
  const groups = new Map<string, SidebarProjectSummary[]>();
  for (const project of projects) {
    const areaName = project.areaName?.trim() || "未分类";
    const entries = groups.get(areaName) ?? [];
    entries.push(project);
    groups.set(areaName, entries);
  }
  return Array.from(groups, ([areaName, entries]) => ({
    areaName,
    projects: entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
  })).sort((left, right) => {
    if (left.areaName === "未分类") return 1;
    if (right.areaName === "未分类") return -1;
    return left.areaName.localeCompare(right.areaName, "zh-CN");
  });
}

function SidebarProjectGroups({
  collapsedAreas,
  groups,
  selectedProjectId,
  counts,
  countLabel = "个未完成任务",
  projectHref = (project) => `/projects?project=${encodeURIComponent(project.id)}`,
  onNavigate,
  onAreaContextMenu,
  onToggleArea,
  onProjectContextMenu,
}: {
  readonly collapsedAreas: ReadonlySet<string>;
  readonly groups: readonly SidebarProjectGroup[];
  readonly selectedProjectId?: string;
  readonly counts?: ReadonlyMap<string, number>;
  readonly countLabel?: string;
  readonly projectHref?: (project: SidebarProjectSummary) => string;
  readonly onNavigate: () => void;
  readonly onAreaContextMenu?: (areaName: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
  readonly onToggleArea: (areaName: string) => void;
  readonly onProjectContextMenu?: (projectId: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  return <div className="sidebar-project-groups">
    {groups.map((group) => {
      const collapsed = collapsedAreas.has(group.areaName);
      return <section className={`sidebar-project-group ${collapsed ? "collapsed" : ""}`} key={group.areaName}>
      <h3 onContextMenu={(event) => {
        if (!onAreaContextMenu) return;
        event.preventDefault();
        onAreaContextMenu(group.areaName, event.clientX, event.clientY, event.currentTarget.querySelector("button"));
      }}><button type="button" aria-expanded={!collapsed} onClick={() => onToggleArea(group.areaName)}><ChevronRight size={11} />{group.areaName}</button><span>{group.projects.length}</span></h3>
      {!collapsed && <nav className="sidebar-project-list" aria-label={`${group.areaName}项目`}>
        {group.projects.map((project) => <SidebarProjectLink
          active={selectedProjectId === project.id}
          key={project.id}
          project={project}
          count={counts?.get(project.id) ?? 0}
          countLabel={countLabel}
          href={projectHref(project)}
          onNavigate={onNavigate}
          onContextMenu={onProjectContextMenu}
        />)}
      </nav>}
    </section>;
    })}
  </div>;
}

function SidebarProjectLink({
  active,
  project,
  count,
  countLabel,
  href,
  onNavigate,
  onContextMenu,
}: {
  readonly active: boolean;
  readonly project: SidebarProjectSummary;
  readonly count: number;
  readonly countLabel: string;
  readonly href: string;
  readonly onNavigate: () => void;
  readonly onContextMenu?: (projectId: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  return <Link
    className={active ? "active" : ""}
    href={href}
    onClick={onNavigate}
    onContextMenu={(event) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu(project.id, event.clientX, event.clientY, event.currentTarget);
    }}
  >
    <i style={{ background: project.color }} />
    <span><strong>{project.name}</strong></span>
    <em title={`${count} ${countLabel}`}>{count}</em>
  </Link>;
}

function PageContent({
  section,
  currentUser,
  initialMessageId,
  initialMailFolderId,
  initialMailCorrespondent,
  initialComposeTo,
  initialTaskId,
  initialTaskView,
  initialCreateTask,
  initialScheduleTaskId,
  initialEventId,
  initialCalendarDate,
  initialNoteId,
  initialNoteFilter,
  initialProjectId,
  onOpenAssistant,
}: {
  readonly section: WorkspaceSection;
  readonly currentUser: {
    readonly id: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: AppRole;
  };
  readonly initialMessageId?: string;
  readonly initialMailFolderId?: string;
  readonly initialMailCorrespondent?: string;
  readonly initialComposeTo?: string;
  readonly initialTaskId?: string;
  readonly initialTaskView?: TaskView;
  readonly initialCreateTask?: boolean;
  readonly initialScheduleTaskId?: string;
  readonly initialEventId?: string;
  readonly initialCalendarDate?: string;
  readonly initialNoteId?: string;
  readonly initialNoteFilter?: "pinned" | "unfiled";
  readonly initialProjectId?: string;
  readonly onOpenAssistant: () => void;
}) {
  switch (section) {
    case "today": return <TodayPage />;
    case "inbox": return <InboxPage initialMessageId={initialMessageId} initialFolderId={initialMailFolderId} initialCorrespondent={initialMailCorrespondent} initialComposeTo={initialComposeTo} onOpenAssistant={onOpenAssistant} />;
    case "calendar": return <CalendarPage initialEventId={initialEventId} initialCalendarDate={initialCalendarDate} />;
    case "tasks": return <TasksPage initialTaskId={initialTaskId} initialTaskView={initialTaskView} initialCreateTask={initialCreateTask} initialProjectId={initialProjectId} initialScheduleTaskId={initialScheduleTaskId} />;
    case "projects": return <ProjectsPage initialProjectId={initialProjectId} />;
    case "notes": return <NotesPage initialNoteId={initialNoteId} initialFilter={initialNoteFilter} initialProjectId={initialProjectId} />;
    case "ai": return <AiPage />;
    case "settings": return <SettingsPage currentUser={currentUser} />;
  }
}

type WorkspaceUser = {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: AppRole;
};

function SettingsPage({ currentUser }: { readonly currentUser: WorkspaceUser }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = normalizeSettingsTab(searchParams.get("tab"), currentUser.role);
  return (
    <div className="settings-page">
      <div className="settings-content">
        {activeTab === "appearance" && <AppearanceSettings />}
        {activeTab === "profile" && <ProfileSettings currentUser={currentUser} />}
        {activeTab === "users" && currentUser.role === "admin" && <UserManagementSettings currentUser={currentUser} />}
        {activeTab === "diagnostics" && currentUser.role === "admin" && <WorkspaceDiagnosticsSettings />}
        {activeTab === "jobs" && <JobCenterSettings />}
        {activeTab === "operations" && currentUser.role === "admin" && <OperationsSettings />}
        {activeTab === "sync" && <SyncSettings />}
        {activeTab === "mail" && <MailAccountSettings onManageExchange={() => router.push("/settings?tab=calendar")} />}
        {activeTab === "calendar" && <CalendarAccountSettings />}
        {activeTab === "shortcuts" && <ShortcutsSettings />}
        {activeTab === "ai" && <><AiAutomationSettings /><AiProviderSettings /></>}
        {activeTab === "backup" && <BackupSettings />}
      </div>
    </div>
  );
}

const shortcutGroups = [
  {
    title: "全局",
    shortcuts: [
      { keys: ["Ctrl/Cmd", "K"], action: "打开全局搜索" },
      { keys: ["Esc"], action: "关闭搜索、菜单或当前确认弹窗" },
    ],
  },
  {
    title: "搜索",
    shortcuts: [
      { keys: ["Enter"], action: "打开当前搜索结果" },
      { keys: ["Esc"], action: "关闭搜索面板" },
      { keys: ["菜单键"], action: "打开搜索结果操作菜单" },
      { keys: ["Shift", "F10"], action: "打开搜索结果操作菜单" },
    ],
  },
  {
    title: "上下文菜单",
    shortcuts: [
      { keys: ["↑↓"], action: "在菜单项之间移动焦点" },
      { keys: ["Home"], action: "跳到第一个菜单项" },
      { keys: ["End"], action: "跳到最后一个菜单项" },
      { keys: ["Esc"], action: "关闭菜单并恢复焦点" },
    ],
  },
  {
    title: "左侧导航",
    shortcuts: [
      { keys: ["←"], action: "缩小左侧导航" },
      { keys: ["→"], action: "放大左侧导航" },
      { keys: ["Shift", "←/→"], action: "以更大步进调整左侧导航宽度" },
      { keys: ["Home"], action: "设置为最小宽度" },
      { keys: ["End"], action: "设置为最大宽度" },
    ],
  },
  {
    title: "邮件",
    shortcuts: [
      { keys: ["↑↓"], action: "选择上一封或下一封邮件" },
      { keys: ["Shift", "↑↓"], action: "连续选择多封邮件" },
      { keys: ["Ctrl/Cmd", "点击"], action: "增减选择单封邮件" },
      { keys: ["Shift", "点击"], action: "从上次选择位置连续选择" },
      { keys: ["Ctrl/Cmd", "A"], action: "全选当前筛选结果" },
      { keys: ["Esc"], action: "清除邮件多选" },
      { keys: ["Enter"], action: "打开当前选中的邮件" },
      { keys: ["Delete/Entf"], action: "删除当前邮件或已多选的邮件" },
      { keys: ["菜单键"], action: "打开邮件操作菜单" },
      { keys: ["Shift", "F10"], action: "打开邮件操作菜单" },
      { keys: ["Enter"], action: "展开或收起聚焦的邮件线程" },
      { keys: ["Space"], action: "展开或收起聚焦的邮件线程" },
    ],
  },
  {
    title: "日历",
    shortcuts: [
      { keys: ["菜单键"], action: "打开日历事件操作菜单" },
      { keys: ["Shift", "F10"], action: "打开日历事件操作菜单" },
      { keys: ["Shift", "右键"], action: "保留浏览器原生右键菜单" },
    ],
  },
  {
    title: "项目计划",
    shortcuts: [
      { keys: ["Ctrl", "滚轮"], action: "缩放项目甘特图时间轴" },
      { keys: ["Enter"], action: "编辑聚焦的计划任务" },
      { keys: ["Space"], action: "编辑聚焦的计划任务" },
      { keys: ["菜单键"], action: "打开计划任务操作菜单" },
      { keys: ["Shift", "F10"], action: "打开计划任务操作菜单" },
    ],
  },
  {
    title: "笔记",
    shortcuts: [
      { keys: ["菜单键"], action: "打开笔记操作菜单" },
      { keys: ["Shift", "F10"], action: "打开笔记操作菜单" },
      { keys: ["Ctrl/Cmd", "B"], action: "加粗" },
      { keys: ["Ctrl/Cmd", "I"], action: "斜体" },
      { keys: ["Ctrl/Cmd", "U"], action: "下划线" },
      { keys: ["Ctrl/Cmd", "E"], action: "行内代码" },
      { keys: ["Ctrl/Cmd", "Shift", "X"], action: "删除线" },
      { keys: ["Ctrl/Cmd", ","], action: "下标" },
      { keys: ["Ctrl/Cmd", "."], action: "上标" },
      { keys: ["Ctrl/Cmd", "Shift", "H"], action: "高亮" },
      { keys: ["Ctrl/Cmd", "Shift", "M"], action: "添加评论草稿" },
    ],
  },
  {
    title: "设置与运维",
    shortcuts: [
      { keys: ["菜单键"], action: "打开当前任务或备份的操作菜单" },
      { keys: ["Shift", "F10"], action: "打开当前任务或备份的操作菜单" },
      { keys: ["Esc"], action: "关闭用户菜单或文件夹编辑浮层" },
    ],
  },
  {
    title: "编辑器块级格式",
    shortcuts: [
      { keys: ["Ctrl/Cmd", "Alt", "1-6"], action: "切换为 1 至 6 级标题" },
      { keys: ["Ctrl/Cmd", "Alt", "8"], action: "切换代码块" },
      { keys: ["Ctrl/Cmd", "Shift", "."], action: "切换引用块" },
      { keys: ["Ctrl/Cmd", "Enter"], action: "在当前块后插入退出换行" },
      { keys: ["Ctrl/Cmd", "Shift", "Enter"], action: "在当前块前插入退出换行" },
    ],
  },
  {
    title: "编辑器 AI 与工具弹层",
    shortcuts: [
      { keys: ["Tab"], action: "接受 AI 补全文本" },
      { keys: ["Ctrl/Cmd", "→"], action: "接受 AI 补全的下一个词" },
      { keys: ["Ctrl", "Space"], action: "触发 AI 补全建议" },
      { keys: ["Esc"], action: "拒绝 AI 补全或停止编辑器 AI 输出" },
      { keys: ["Enter"], action: "提交编辑器 AI 输入" },
      { keys: ["Backspace"], action: "在空 AI 输入中关闭 AI 菜单" },
      { keys: ["↓"], action: "打开媒体上传按钮的附加菜单" },
      { keys: ["Enter"], action: "确认媒体 URL 或字号输入" },
      { keys: ["Enter"], action: "提交评论回复" },
      { keys: ["Shift", "Enter"], action: "在评论回复中换行" },
    ],
  },
  {
    title: "AI Command",
    shortcuts: [
      { keys: ["Enter"], action: "发送当前消息" },
      { keys: ["Shift", "Enter"], action: "在消息中换行" },
    ],
  },
] as const;

function ShortcutsSettings() {
  return (
    <section className="shortcuts-settings panel">
      <div className="settings-section-heading">
        <h2>快捷键</h2>
      </div>
      <div className="shortcuts-layout">
        {shortcutGroups.map((group) => (
          <section className="shortcut-card" key={group.title}>
            <header><h3>{group.title}</h3></header>
            <div className="shortcut-list">
              {group.shortcuts.map((shortcut) => (
                <div className="shortcut-row" key={`${group.title}:${shortcut.action}`}>
                  <span>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
                  <strong>{shortcut.action}</strong>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

interface ManagedUser extends WorkspaceUser {
  readonly disabledAt?: string;
  readonly lastLoginAt?: string;
  readonly sessionVersion: number;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ManagedInvitation {
  readonly id: string;
  readonly email: string;
  readonly displayName?: string;
  readonly role: AppRole;
  readonly inviteUrl?: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface WorkspaceDiagnosticUser {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: AppRole;
  readonly disabledAt?: string;
  readonly counts: Readonly<Record<string, number>>;
}

interface WorkspaceDiagnosticPayload {
  readonly users: readonly WorkspaceDiagnosticUser[];
  readonly unownedCounts: Readonly<Record<string, number>>;
  readonly totalUnowned: number;
}

interface AppJobPayload {
  readonly id: string;
  readonly kind: string;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly title: string;
  readonly progress: number;
  readonly errorMessage?: string;
  readonly logLines: readonly string[];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

interface ContextMenuState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

function JobCenterSettings() {
  const [jobs, setJobs] = useState<readonly AppJobPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyJobId, setBusyJobId] = useState<string>();
  const [filter, setFilter] = useState("active");
  const [menu, setMenu] = useState<ContextMenuState>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly message: string }>();

  const loadJobs = useCallback(async () => {
    try {
      const status = filter === "active" ? "" : `?status=${encodeURIComponent(filter)}`;
      const response = await fetch(`/api/jobs${status}`, { cache: "no-store" });
      const payload = await response.json() as { readonly ok?: boolean; readonly jobs?: readonly AppJobPayload[]; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.jobs) throw new Error(payload.message || "无法读取任务");
      setJobs(filter === "active" ? payload.jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "failed") : payload.jobs);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法读取任务" });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);
  useRealtimeRefresh([], loadJobs, 80);
  useRealtimeEvent(["job"], (event) => {
    if (event.entityType !== "app_jobs" || !event.entityId) {
      void loadJobs();
      return;
    }
    if (event.action === "delete") {
      setJobs((current) => current.filter((job) => job.id !== event.entityId));
      return;
    }
    const nextStatus = appJobStatus(event.status);
    const knownJob = jobs.some((job) => job.id === event.entityId);
    setJobs((current) => current.map((job) => {
      if (job.id !== event.entityId) return job;
      return {
        ...job,
        ...(nextStatus ? { status: nextStatus } : {}),
        ...(typeof event.progress === "number" ? { progress: event.progress } : {}),
      };
    }));
    if (!knownJob || nextStatus === "succeeded" || nextStatus === "failed" || nextStatus === "cancelled") {
      void loadJobs();
    }
  });
  useVisiblePageRefresh(loadJobs, 60_000);

  const updateJob = async (job: AppJobPayload, action: "cancel" | "retry") => {
    setBusyJobId(job.id);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "任务操作失败");
      setFeedback({ kind: "success", message: action === "retry" ? "任务已重新排队" : "任务已取消" });
      await loadJobs();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "任务操作失败" });
    } finally {
      setBusyJobId(undefined);
    }
  };

  const deleteJobRecord = async (job: AppJobPayload) => {
    if (!await appConfirm({
      title: `删除任务记录“${job.title}”？`,
      description: "只会删除任务历史和日志，不会删除任务已经生成的备份或其他数据。",
      confirmLabel: "删除记录",
      tone: "danger",
    })) return;
    setBusyJobId(job.id);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "无法删除任务记录");
      setFeedback({ kind: "success", message: "任务记录已删除" });
      await loadJobs();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法删除任务记录" });
    } finally {
      setBusyJobId(undefined);
    }
  };

  const menuJob = menu ? jobs.find((job) => job.id === menu.id) : undefined;
  const menuJobFinished = menuJob ? !["queued", "running"].includes(menuJob.status) : false;
  const jobCommands: readonly ResolvedContextCommand[] = menuJob ? [
    { id: "job.copy-id", label: "复制任务 ID", group: "primary", risk: "read", icon: "copy" },
    { id: "job.copy-logs", label: "复制日志", group: "primary", risk: "read", icon: "info", disabledReason: menuJob.logLines.length ? undefined : "暂无日志" },
    { id: "job.retry", label: "重新排队", group: "state", risk: "local-write", icon: "restore", disabledReason: menuJob.status === "failed" || menuJob.status === "cancelled" ? undefined : "只有失败或取消的任务可重试" },
    { id: "job.cancel", label: "取消任务", group: "danger", risk: "local-write", icon: "trash", disabledReason: menuJob.status === "queued" ? undefined : "只能取消排队任务" },
    { id: "job.delete", label: "删除任务记录", group: "danger", risk: "destructive", icon: "trash", disabledReason: menuJobFinished ? undefined : "排队或运行中的任务不能删除" },
  ] : [];

  const openJobMenu = (event: ReactMouseEvent<HTMLElement>, job: AppJobPayload) => {
    event.preventDefault();
    setMenu({ id: job.id, x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
  };

  const selectJobCommand = (commandId: ContextCommandId) => {
    if (!menuJob) return;
    if (commandId === "job.copy-id") void copyText(menuJob.id, "任务 ID 已复制", setFeedback);
    if (commandId === "job.copy-logs") void copyText(menuJob.logLines.join("\n"), "任务日志已复制", setFeedback);
    if (commandId === "job.retry") void updateJob(menuJob, "retry");
    if (commandId === "job.cancel") void updateJob(menuJob, "cancel");
    if (commandId === "job.delete") void deleteJobRecord(menuJob);
  };

  return (
    <section className="job-center-settings panel">
      <div className="settings-section-heading">
        <h2>后台任务</h2>
        <span className="step-badge">{loading ? "读取中" : `${jobs.length} 个任务`}</span>
      </div>
      <div className="job-toolbar">
        {["active", "queued", "running", "failed", "succeeded", "cancelled"].map((item) => (
          <button key={item} className={filter === item ? "active" : ""} onClick={() => { setLoading(true); setFilter(item); }}>{jobFilterLabel(item)}</button>
        ))}
        <button className="secondary-button" disabled={loading} onClick={() => { setLoading(true); void loadJobs(); }}><RefreshCw size={14} />刷新</button>
      </div>
      <div className="job-list">
        {jobs.length ? jobs.map((job) => (
          <article
            key={job.id}
            className={`job-row ${job.status}`}
            tabIndex={0}
            onContextMenu={(event) => openJobMenu(event, job)}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({ id: job.id, x: bounds.right - 12, y: bounds.top + 28, returnFocus: event.currentTarget });
            }}
          >
            <header>
              <div><strong>{job.title}</strong><small>{jobKindLabel(job.kind)} · {formatAccountTime(job.createdAt)}</small></div>
              <span>{jobStatusLabel(job.status)}</span>
            </header>
            <div className="job-progress"><i><b style={{ width: `${job.progress}%` }} /></i><small>{job.progress}%</small></div>
            {job.errorMessage && <p>{job.errorMessage}</p>}
            {job.logLines.length > 0 && <details><summary>日志</summary>{job.logLines.slice(0, 8).map((line, index) => <code key={`${job.id}-${index}`}>{line}</code>)}</details>}
            <footer>
              {job.status === "queued" && <button className="ghost-button" disabled={busyJobId === job.id} onClick={() => void updateJob(job, "cancel")}><X size={13} />取消</button>}
              {(job.status === "failed" || job.status === "cancelled") && <button className="secondary-button" disabled={busyJobId === job.id} onClick={() => void updateJob(job, "retry")}><RefreshCw size={13} />重试</button>}
              {!["queued", "running"].includes(job.status) && <button className="ghost-button danger-button" disabled={busyJobId === job.id} onClick={() => void deleteJobRecord(job)}><Trash2 size={13} />删除记录</button>}
            </footer>
          </article>
        )) : <div className="accounts-empty">{loading ? "正在读取任务…" : "暂无任务"}</div>}
      </div>
      {feedback && <div className={`user-settings-feedback ${feedback.kind}`}>{feedback.message}</div>}
      {menu && menuJob && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          ariaLabel={`任务操作：${menuJob.title}`}
          commands={jobCommands}
          heading={menuJob.title}
          returnFocus={menu.returnFocus}
          testId="job-context-menu"
          onClose={() => setMenu(undefined)}
          onSelect={selectJobCommand}
        />
      )}
    </section>
  );
}

interface OperationsPayload {
  readonly database: { readonly connected: boolean; readonly currentVersion: number; readonly latestVersion: number; readonly pendingVersions: readonly number[] };
  readonly dataDirectory: { readonly path: string; readonly writable: boolean };
  readonly masterKey: { readonly configured: boolean };
  readonly environment: {
    readonly backupPasswordConfigured: boolean;
    readonly healthcheckTokenConfigured: boolean;
    readonly aiAutoExecutionEnabled: boolean;
  };
  readonly storage: {
    readonly layout: readonly {
      readonly id: string;
      readonly label: string;
      readonly path: string;
      readonly exists: boolean;
      readonly writable: boolean;
      readonly bytes: number;
      readonly files: number;
    }[];
  };
  readonly jobs: { readonly queued: number; readonly running: number; readonly failed: number };
  readonly recentErrors: readonly {
    readonly id: string;
    readonly source: "job" | "audit";
    readonly title: string;
    readonly message: string;
    readonly createdAt: string;
  }[];
  readonly backup: BackupStatusPayload;
}

function OperationsSettings() {
  const [operations, setOperations] = useState<OperationsPayload>();
  const [feedback, setFeedback] = useState<string>();

  const loadOperations = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/diagnostics", { cache: "no-store" });
      const payload = await response.json() as { readonly ok?: boolean; readonly operations?: OperationsPayload; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.operations) throw new Error(payload.message || "无法读取运维状态");
      setOperations(payload.operations);
      setFeedback(undefined);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取运维状态");
    }
  }, []);

  useEffect(() => { void loadOperations(); }, [loadOperations]);

  return (
    <section className="operations-settings panel">
      <div className="settings-section-heading">
        <h2>系统状态</h2>
        <button className="secondary-button" onClick={() => void loadOperations()}><RefreshCw size={14} />刷新</button>
      </div>
      {operations ? (
        <>
          <div className="operations-grid">
            <article><span><DatabaseBackup size={17} /></span><small>数据库</small><strong>{operations.database.connected ? "已连接" : "异常"}</strong><p>v{operations.database.currentVersion} / v{operations.database.latestVersion}{operations.database.pendingVersions.length ? ` · 待迁移 ${operations.database.pendingVersions.join(", ")}` : ""}</p></article>
            <article><span><Clock3 size={17} /></span><small>任务队列</small><strong>{operations.jobs.running} 运行 · {operations.jobs.queued} 排队</strong><p>{operations.jobs.failed} 个失败</p></article>
            <article><span><HardDrive size={17} /></span><small>数据目录</small><strong>{operations.dataDirectory.writable ? "可写" : "不可写"}</strong><p>{operations.dataDirectory.path}</p></article>
            <article><span><ShieldCheck size={17} /></span><small>主密钥</small><strong>{operations.masterKey.configured ? "环境变量" : "未配置"}</strong><p>KALENDER_MASTER_KEY</p></article>
            <article><span><DatabaseBackup size={17} /></span><small>备份工具</small><strong>{operations.backup.strategy?.tools.pgDump && operations.backup.strategy.tools.pgRestore ? "pg_dump/restore 可用" : "工具缺失"}</strong><p>{operations.backup.strategy?.backupDirectory}</p></article>
            <article><span><Paperclip size={17} /></span><small>附件</small><strong>{operations.backup.attachmentFiles} 个</strong><p>{formatFileSize(operations.backup.attachmentBytes)}</p></article>
          </div>
          <div className="operations-detail-grid">
            <section>
              <h3>功能配置</h3>
              <div className="operations-check-list">
                <span className={operations.environment.aiAutoExecutionEnabled ? "ready" : "optional"}><Check size={13} />AI 自动执行：{operations.environment.aiAutoExecutionEnabled ? "开启" : "关闭"}</span>
                <span className={operations.environment.backupPasswordConfigured ? "ready" : "optional"}>{operations.environment.backupPasswordConfigured ? <Check size={13} /> : <Circle size={13} />}自动备份密码：{operations.environment.backupPasswordConfigured ? "已配置" : "按需配置"}</span>
                <span className={operations.environment.healthcheckTokenConfigured ? "ready" : "optional"}><ShieldCheck size={13} />健康检查：{operations.environment.healthcheckTokenConfigured ? "受令牌保护" : "公开轻量检查"}</span>
              </div>
            </section>
            <section>
              <h3>存储目录</h3>
              <div className="operations-storage-list">
                {operations.storage.layout.map((item) => (
                  <article key={item.id}>
                    <div><strong>{item.label}</strong><small>{item.path}</small></div>
                    <span>{item.exists ? "存在" : "未创建"} · {item.writable ? "可写" : "不可写"} · {formatFileSize(item.bytes)} · {item.files} 文件</span>
                  </article>
                ))}
              </div>
            </section>
            <section>
              <h3>最近错误</h3>
              <div className="operations-error-list">
                {operations.recentErrors.length ? operations.recentErrors.map((item) => (
                  <article key={item.id}><strong>{item.title}</strong><small>{formatAccountTime(item.createdAt)}</small><p>{item.message}</p></article>
                )) : <div className="accounts-empty">最近没有失败任务</div>}
              </div>
            </section>
          </div>
        </>
      ) : <div className="accounts-empty">{feedback ?? "正在读取运维状态…"}</div>}
      {feedback && <div className="user-settings-feedback error">{feedback}</div>}
    </section>
  );
}

const backgroundSyncIntervals = [
  { value: 60_000, label: "1 分钟" },
  { value: 3 * 60_000, label: "3 分钟" },
  { value: 5 * 60_000, label: "5 分钟" },
  { value: 10 * 60_000, label: "10 分钟" },
  { value: 15 * 60_000, label: "15 分钟" },
  { value: 30 * 60_000, label: "30 分钟" },
] as const;

const clientRefreshIntervals = [
  { value: 15_000, label: "15 秒" },
  { value: 30_000, label: "30 秒" },
  { value: 60_000, label: "1 分钟" },
  { value: 2 * 60_000, label: "2 分钟" },
] as const;

function SyncSettings() {
  const { settings, loading, canEdit, error, save } = useSyncSettings();
  const realtime = useRealtimeConnection();
  const [draft, setDraft] = useState<ClientSyncSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly message: string }>();

  useEffect(() => { setDraft(settings); }, [settings]);

  const changed = syncSettingsChanged(settings, draft);
  const activeServices = Number(draft.mailSyncEnabled) + Number(draft.calendarSyncEnabled);
  const realtimeStatus = realtimeConnectionCopy(realtime.status);
  const fallbackActive = realtime.status !== "connected" && draft.clientRefreshEnabled;

  const saveSettings = async () => {
    if (!canEdit || saving || !changed) return;
    setSaving(true);
    setFeedback(undefined);
    try {
      const saved = await save(draft);
      setDraft(saved);
      setFeedback({ kind: "success", message: "同步设置已保存，后台定时器与页面刷新频率已立即更新。" });
    } catch (saveError) {
      setFeedback({ kind: "error", message: saveError instanceof Error ? saveError.message : "无法保存同步设置" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sync-settings panel" aria-labelledby="sync-settings-title">
      <div className="settings-section-heading">
        <h2 id="sync-settings-title">同步</h2>
        <span className="step-badge">{loading ? "读取中" : `${activeServices}/2 项运行`}</span>
      </div>

      <div className={`sync-realtime-overview ${realtime.status}`} role="status">
        <span className="sync-realtime-icon">
          {realtime.status === "connected"
            ? <Wifi size={18} />
            : realtime.status === "connecting"
              ? <LoaderCircle className="spin" size={18} />
              : <WifiOff size={18} />}
        </span>
        <div className="sync-realtime-copy">
          <strong>{realtimeStatus.title}</strong>
          <small>
            {realtime.status === "connected"
              ? "邮件、日历、任务和备份变化会立即推送到当前页面。"
              : fallbackActive
                ? `当前使用 ${formatRealtimeFallbackInterval(draft.clientRefreshIntervalMs)} 断线备用刷新。`
                : realtimeStatus.description}
          </small>
        </div>
        <dl className="sync-realtime-metrics">
          <div><dt>最近事件</dt><dd>{realtime.lastEvent ? `${realtimeTopicLabel(realtime.lastEvent.topic)} · ${formatAccountTime(realtime.lastEvent.occurredAt)}` : "暂无"}</dd></div>
          <div><dt>本次连接</dt><dd>{realtime.connectedAt ? formatAccountTime(realtime.connectedAt) : "尚未连接"}</dd></div>
          <div><dt>自动重连</dt><dd>{realtime.reconnectCount} 次</dd></div>
        </dl>
        <button
          type="button"
          className="secondary-button"
          disabled={realtime.status === "connecting"}
          title="重新建立实时连接"
          onClick={realtime.reconnect}
        >
          <RefreshCw size={14} />
          重新连接
        </button>
      </div>

      <div className="sync-settings-group">
        <header>
          <div><h3>后台数据同步</h3></div>
          <span>{activeServices ? "运行中" : "已暂停"}</span>
        </header>
        <SyncSettingsRow
          icon={<Mail size={17} />}
          title="邮件自动同步"
          description="更新文件夹、未读状态和邮件索引。"
          enabled={draft.mailSyncEnabled}
          intervalMs={draft.mailSyncIntervalMs}
          intervals={backgroundSyncIntervals}
          disabled={loading || saving || !canEdit}
          onEnabledChange={(mailSyncEnabled) => setDraft((current) => ({ ...current, mailSyncEnabled }))}
          onIntervalChange={(mailSyncIntervalMs) => setDraft((current) => ({ ...current, mailSyncIntervalMs }))}
        />
        <SyncSettingsRow
          icon={<CalendarDays size={17} />}
          title="日历自动同步"
          description="更新远程日历、事件变更和参与者信息。"
          enabled={draft.calendarSyncEnabled}
          intervalMs={draft.calendarSyncIntervalMs}
          intervals={backgroundSyncIntervals}
          disabled={loading || saving || !canEdit}
          onEnabledChange={(calendarSyncEnabled) => setDraft((current) => ({ ...current, calendarSyncEnabled }))}
          onIntervalChange={(calendarSyncIntervalMs) => setDraft((current) => ({ ...current, calendarSyncIntervalMs }))}
        />
      </div>

      <div className="sync-settings-group">
        <header>
          <div><h3>断线备用刷新</h3></div>
          <span>{draft.clientRefreshEnabled ? "备用已开启" : "备用已关闭"}</span>
        </header>
        <SyncSettingsRow
          icon={<Monitor size={17} />}
          title="可见页面备用刷新"
          description="仅在实时连接断开且页面可见时运行；切回窗口时校验一次。"
          enabled={draft.clientRefreshEnabled}
          intervalMs={draft.clientRefreshIntervalMs}
          intervals={clientRefreshIntervals}
          disabled={loading || saving || !canEdit}
          onEnabledChange={(clientRefreshEnabled) => setDraft((current) => ({ ...current, clientRefreshEnabled }))}
          onIntervalChange={(clientRefreshIntervalMs) => setDraft((current) => ({ ...current, clientRefreshIntervalMs }))}
        />
      </div>

      {(feedback || error) && (
        <div className={`sync-settings-feedback ${feedback?.kind === "success" ? "success" : "error"}`} role="status">
          {feedback?.kind === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span>{feedback?.message ?? error}</span>
        </div>
      )}

      <footer className="sync-settings-actions">
        <span>{canEdit ? changed ? "有尚未保存的修改" : "当前设置已生效" : "只有管理员可以修改这些设置"}</span>
        <button
          type="button"
          className="primary-button"
          disabled={!canEdit || loading || saving || !changed}
          onClick={() => void saveSettings()}
        >
          {saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          保存设置
        </button>
      </footer>
    </section>
  );
}

function realtimeConnectionCopy(status: ReturnType<typeof useRealtimeConnection>["status"]): {
  readonly title: string;
  readonly description: string;
} {
  if (status === "connected") return { title: "WebSocket 已连接", description: "实时推送工作正常。" };
  if (status === "connecting") return { title: "正在连接实时服务", description: "正在建立经过会话鉴权的连接。" };
  if (status === "offline") return { title: "浏览器当前离线", description: "网络恢复后会自动重新连接。" };
  return { title: "实时连接已断开", description: "系统正在自动重连。" };
}

function realtimeTopicLabel(topic: RealtimeTopic): string {
  return ({
    system: "连接",
    mail: "邮件",
    calendar: "日历",
    task: "任务",
    project: "项目",
    note: "笔记",
    relation: "关联",
    job: "后台任务",
    backup: "备份",
    settings: "设置",
  } as Record<RealtimeTopic, string>)[topic];
}

function formatRealtimeFallbackInterval(intervalMs: number): string {
  if (intervalMs < 60_000) return `${Math.round(intervalMs / 1_000)} 秒`;
  return `${Math.round(intervalMs / 60_000)} 分钟`;
}

function SyncSettingsRow({
  icon,
  title,
  description,
  enabled,
  intervalMs,
  intervals,
  disabled,
  onEnabledChange,
  onIntervalChange,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly intervals: readonly { readonly value: number; readonly label: string }[];
  readonly disabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onIntervalChange: (intervalMs: number) => void;
}) {
  return (
    <div className={`sync-settings-row ${enabled ? "enabled" : ""}`}>
      <span className="sync-settings-row-icon">{icon}</span>
      <div className="sync-settings-row-copy"><strong>{title}</strong><small>{description}</small></div>
      <label className="sync-settings-interval">
        <span>频率</span>
        <AppSelect
          ariaLabel={`${title}同步频率`}
          size="compact"
          value={String(intervalMs)}
          disabled={disabled || !enabled}
          onValueChange={(value) => onIntervalChange(Number(value))}
          options={intervals.map((interval) => ({ value: String(interval.value), label: interval.label }))}
        />
      </label>
      <label className="sync-settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        <span aria-hidden="true"><i /></span>
        <em>{enabled ? "开启" : "关闭"}</em>
      </label>
    </div>
  );
}

function syncSettingsChanged(current: ClientSyncSettings, draft: ClientSyncSettings): boolean {
  return current.mailSyncEnabled !== draft.mailSyncEnabled
    || current.mailSyncIntervalMs !== draft.mailSyncIntervalMs
    || current.calendarSyncEnabled !== draft.calendarSyncEnabled
    || current.calendarSyncIntervalMs !== draft.calendarSyncIntervalMs
    || current.clientRefreshEnabled !== draft.clientRefreshEnabled
    || current.clientRefreshIntervalMs !== draft.clientRefreshIntervalMs;
}

interface AuditEventPayload {
  readonly id: string;
  readonly actorEmail?: string;
  readonly actorDisplayName?: string;
  readonly targetEmail?: string;
  readonly targetDisplayName?: string;
  readonly action: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

type ThemeMode = "system" | "light" | "dark";
type LightThemeTone = "light-fog" | "light-warm" | "light-blue";
type DarkThemeTone = "dark-pro";

function AppearanceSettings() {
  const [preference, setPreference] = useState(() => readThemePreference());
  const [feedback, setFeedback] = useState<string>();

  const saveAppearance = (next = preference) => {
    try {
      saveThemePreference(next);
      setPreference(next);
      setFeedback(undefined);
    } catch {
      setFeedback("无法保存外观设置");
    }
  };

  const setMode = (mode: ThemeMode) => {
    const next = { ...preference, mode };
    setPreference(next);
    saveAppearance(next);
  };

  const setLightTone = (lightTone: LightThemeTone) => {
    const next = { ...preference, lightTone };
    setPreference(next);
    saveAppearance(next);
  };

  const setDarkTone = (darkTone: DarkThemeTone) => {
    const next = { ...preference, darkTone };
    setPreference(next);
    saveAppearance(next);
  };

  return (
    <section className="appearance-settings panel">
      <div className="settings-section-heading">
        <h2>外观</h2>
      </div>
      <div className="appearance-layout">
        <section>
          <h3>模式</h3>
          <div className="appearance-choice-grid mode">
            <button className={preference.mode === "system" ? "active" : ""} onClick={() => setMode("system")}><Monitor size={17} /><strong>跟随系统</strong><small>自动匹配设备深浅模式</small></button>
            <button className={preference.mode === "light" ? "active" : ""} onClick={() => setMode("light")}><Sun size={17} /><strong>浅色</strong><small>默认使用浅色办公界面</small></button>
            <button className={preference.mode === "dark" ? "active" : ""} onClick={() => setMode("dark")}><Moon size={17} /><strong>深色</strong><small>适合夜间或弱光环境</small></button>
          </div>
        </section>
        <section>
          <h3>浅色色调</h3>
          <div className="appearance-choice-grid tone">
            {[
              { id: "light-fog" as const, title: "雾灰", text: "现代、专业、默认推荐", swatches: ["#f5f7f8", "#ffffff", "#4f8fcf", "#4f9d69"] },
              { id: "light-warm" as const, title: "暖白", text: "柔和、亲切、适合长时间阅读", swatches: ["#fbfaf7", "#ffffff", "#5e8fb8", "#8f7659"] },
              { id: "light-blue" as const, title: "蓝灰", text: "企业、稳重、适合运维视角", swatches: ["#eef3f6", "#ffffff", "#2d78b8", "#27a3a3"] },
            ].map((tone) => (
              <button key={tone.id} className={preference.lightTone === tone.id ? "active" : ""} onClick={() => setLightTone(tone.id)}>
                <span className="appearance-swatches">{tone.swatches.map((color) => <i key={color} style={{ background: color }} />)}</span>
                <strong>{tone.title}</strong>
                <small>{tone.text}</small>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h3>深色色调</h3>
          <div className="appearance-choice-grid tone single">
            <button className={preference.darkTone === "dark-pro" ? "active" : ""} onClick={() => setDarkTone("dark-pro")}>
              <span className="appearance-swatches">{["#151817", "#222725", "#76b7f2", "#d8a24e"].map((color) => <i key={color} style={{ background: color }} />)}</span>
              <strong>专业深色</strong>
              <small>保留深色习惯，但提升层次和对比</small>
            </button>
          </div>
        </section>
      </div>
      {feedback && <div className="user-settings-feedback error">{feedback}</div>}
    </section>
  );
}

function ProfileSettings({ currentUser }: { readonly currentUser: WorkspaceUser }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly message: string }>();

  async function saveProfile() {
    if (newPassword && newPassword !== confirmPassword) {
      setFeedback({ kind: "error", message: "两次输入的新密码不一致" });
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          currentPassword: currentPassword || undefined,
          newPassword: newPassword || undefined,
        }),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "无法更新个人账号");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setFeedback({ kind: "success", message: "个人账号已更新" });
      router.refresh();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法更新个人账号" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="profile-settings panel" aria-labelledby="profile-settings-title">
      <div className="settings-section-heading">
        <h2 id="profile-settings-title">账号</h2>
        <span className="step-badge">{roleLabel(currentUser.role)}</span>
      </div>
      <div className="account-form profile-form">
        <label><span>昵称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" /></label>
        <label><span>登录邮箱</span><input value={currentUser.email} disabled /></label>
        <label><span>当前密码</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" placeholder="修改密码时必填" /></label>
        <label><span>新密码</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" placeholder="至少 8 个字符" /></label>
        <label><span>确认新密码</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label>
      </div>
      {feedback && <div className={`user-settings-feedback ${feedback.kind}`} role="status">{feedback.message}</div>}
      <footer className="settings-actions">
        <button className="primary-button" disabled={busy || displayName.trim().length < 2 || Boolean(newPassword) !== Boolean(currentPassword)} onClick={() => void saveProfile()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{busy ? "正在保存…" : "保存个人账号"}
        </button>
      </footer>
    </section>
  );
}

function UserManagementSettings({ currentUser }: { readonly currentUser: WorkspaceUser }) {
  const [users, setUsers] = useState<readonly ManagedUser[]>([]);
  const [invitations, setInvitations] = useState<readonly ManagedInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly message: string }>();
  const [draft, setDraft] = useState({ displayName: "", email: "", password: "", role: "user" as AppRole, mustChangePassword: true });
  const [inviteDraft, setInviteDraft] = useState({ displayName: "", email: "", role: "user" as AppRole });
  const [editing, setEditing] = useState<Record<string, { displayName: string; email: string; role: AppRole; password: string; mustChangePassword: boolean }>>({});

  const loadUsers = useCallback(async () => {
    try {
      const [usersResponse, invitationsResponse] = await Promise.all([
        fetch("/api/users", { cache: "no-store" }),
        fetch("/api/invitations", { cache: "no-store" }),
      ]);
      const usersPayload = await usersResponse.json().catch(() => null) as { readonly users?: readonly ManagedUser[]; readonly message?: string } | null;
      const invitationsPayload = await invitationsResponse.json().catch(() => null) as { readonly invitations?: readonly ManagedInvitation[]; readonly message?: string } | null;
      if (!usersResponse.ok) throw new Error(usersPayload?.message || "无法读取用户");
      if (!invitationsResponse.ok) throw new Error(invitationsPayload?.message || "无法读取邀请");
      setUsers(usersPayload?.users ?? []);
      setInvitations(invitationsPayload?.invitations ?? []);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法读取用户" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  async function createUser() {
    setBusyId("create");
    setFeedback(undefined);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "无法创建用户");
      setDraft({ displayName: "", email: "", password: "", role: "user", mustChangePassword: true });
      await loadUsers();
      setFeedback({ kind: "success", message: "用户已创建" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法创建用户" });
    } finally {
      setBusyId(undefined);
    }
  }

  async function patchUser(user: ManagedUser, changes: Partial<{ displayName: string; email: string; role: AppRole; password: string; disabled: boolean; mustChangePassword: boolean }>) {
    setBusyId(user.id);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "无法更新用户");
      await loadUsers();
      setFeedback({ kind: "success", message: "用户已更新" });
      if ("displayName" in changes || "email" in changes || "role" in changes || "password" in changes) {
        setEditing((current) => {
          const next = { ...current };
          delete next[user.id];
          return next;
        });
      }
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法更新用户" });
    } finally {
      setBusyId(undefined);
    }
  }

  async function createInvitation() {
    setBusyId("invite");
    setFeedback(undefined);
    try {
      const response = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inviteDraft),
      });
      const payload = await response.json().catch(() => null) as { readonly invitation?: ManagedInvitation; readonly message?: string } | null;
      if (!response.ok || !payload?.invitation) throw new Error(payload?.message || "无法创建邀请");
      setInviteDraft({ displayName: "", email: "", role: "user" });
      await navigator.clipboard?.writeText(payload.invitation.inviteUrl ?? "").catch(() => undefined);
      await loadUsers();
      setFeedback({ kind: "success", message: payload.invitation.inviteUrl ? "邀请已创建，链接已复制" : "邀请已创建" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法创建邀请" });
    } finally {
      setBusyId(undefined);
    }
  }

  async function revokeInvitation(invitation: ManagedInvitation) {
    setBusyId(invitation.id);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/invitations/${encodeURIComponent(invitation.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "无法撤销邀请");
      await loadUsers();
      setFeedback({ kind: "success", message: "邀请已撤销" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法撤销邀请" });
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="user-management-settings panel" aria-labelledby="user-management-title">
      <div className="settings-section-heading">
        <h2 id="user-management-title">用户管理</h2>
        <span className="step-badge">{users.filter((user) => !user.disabledAt).length} 个可用用户</span>
      </div>

      <div className="account-form user-create-form">
        <label><span>昵称</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label><span>邮箱</span><input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
        <label><span>初始密码</span><input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} autoComplete="new-password" /></label>
        <label><span>角色</span><AppSelect ariaLabel="用户角色" value={draft.role} onValueChange={(role) => setDraft({ ...draft, role: role as AppRole })} options={roleOptions()} /></label>
        <label className="secure-toggle"><input type="checkbox" checked={draft.mustChangePassword} onChange={(event) => setDraft({ ...draft, mustChangePassword: event.target.checked })} /><span>首次登录必须改密码</span></label>
      </div>
      <footer className="settings-actions">
        <button className="primary-button" disabled={busyId === "create" || draft.displayName.trim().length < 2 || !draft.email.includes("@") || draft.password.length < 8} onClick={() => void createUser()}>
          {busyId === "create" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{busyId === "create" ? "正在创建…" : "创建用户"}
        </button>
      </footer>

      <div className="account-form user-create-form">
        <label><span>邀请昵称</span><input value={inviteDraft.displayName} onChange={(event) => setInviteDraft({ ...inviteDraft, displayName: event.target.value })} /></label>
        <label><span>邀请邮箱</span><input type="email" value={inviteDraft.email} onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })} /></label>
        <label><span>邀请角色</span><AppSelect ariaLabel="邀请角色" value={inviteDraft.role} onValueChange={(role) => setInviteDraft({ ...inviteDraft, role: role as AppRole })} options={roleOptions()} /></label>
        <div className="settings-actions inline"><button className="secondary-button" disabled={busyId === "invite" || !inviteDraft.email.includes("@")} onClick={() => void createInvitation()}>{busyId === "invite" ? <LoaderCircle className="spin" size={15} /> : <Mail size={15} />}{busyId === "invite" ? "正在创建…" : "创建邀请链接"}</button></div>
      </div>

      {invitations.some((invitation) => !invitation.acceptedAt && !invitation.revokedAt) && <div className="user-list invitation-list">
        {invitations.filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt).map((invitation) => (
          <article className="saved-account-card user-card" key={invitation.id}>
            <div className="saved-account-color" />
            <div className="saved-account-main">
              <div className="saved-account-title">
                <div><strong>{invitation.displayName || invitation.email}</strong><span>{invitation.email}</span></div>
                <span className="sync-status sync-status-syncing">{roleLabel(invitation.role)}</span>
              </div>
              <div className="saved-account-meta"><span>过期于 {formatAccountTime(invitation.expiresAt)}</span><span>创建于 {formatAccountTime(invitation.createdAt)}</span></div>
              <div className="saved-account-actions">
                {invitation.inviteUrl && <button className="ghost-button" onClick={() => void navigator.clipboard?.writeText(invitation.inviteUrl!)}><Link2 size={14} />复制链接</button>}
                <button className="ghost-button danger-button" disabled={busyId === invitation.id} onClick={() => void revokeInvitation(invitation)}>{busyId === invitation.id ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}撤销</button>
              </div>
            </div>
          </article>
        ))}
      </div>}

      <div className="user-list">
        {loading ? <div className="accounts-empty"><LoaderCircle className="spin" size={18} />正在读取用户…</div> : users.map((user) => {
          const edit = editing[user.id];
          const disabled = Boolean(user.disabledAt);
          const busy = busyId === user.id;
          return (
            <article className={`saved-account-card user-card ${disabled ? "disabled" : ""}`} key={user.id}>
              <div className="saved-account-color" />
              <div className="saved-account-main">
                <div className="saved-account-title">
                  <div><strong>{user.displayName}</strong><span>{user.email}</span></div>
                  <span className={`sync-status ${disabled ? "sync-status-paused" : "sync-status-ready"}`}>{disabled ? "已禁用" : roleLabel(user.role)}</span>
                </div>
                <div className="saved-account-meta">
                  <span>创建于 {formatAccountTime(user.createdAt)}</span>
                  <span>更新于 {formatAccountTime(user.updatedAt)}</span>
                  <span>最近登录 {user.lastLoginAt ? formatAccountTime(user.lastLoginAt) : "从未登录"}</span>
                  <span>Session v{user.sessionVersion}</span>
                  {user.mustChangePassword && <span>需改密码</span>}
                  {user.id === currentUser.id && <span>当前账号</span>}
                </div>
                {edit && (
                  <div className="account-form user-edit-form">
                    <label><span>昵称</span><input value={edit.displayName} onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, displayName: event.target.value } })} /></label>
                    <label><span>邮箱</span><input type="email" value={edit.email} onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, email: event.target.value } })} /></label>
                    <label><span>重置密码</span><input type="password" value={edit.password} placeholder="留空则不修改" onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, password: event.target.value } })} /></label>
                    <label><span>角色</span><AppSelect ariaLabel={`${user.displayName}的角色`} value={edit.role} onValueChange={(role) => setEditing({ ...editing, [user.id]: { ...edit, role: role as AppRole } })} options={roleOptions()} /></label>
                    <label className="secure-toggle"><input type="checkbox" checked={edit.mustChangePassword} onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, mustChangePassword: event.target.checked } })} /><span>要求改密</span></label>
                  </div>
                )}
                <div className="saved-account-actions">
                  {edit ? <>
                    <button className="primary-button" disabled={busy || edit.displayName.trim().length < 2 || !edit.email.includes("@") || (edit.password.length > 0 && edit.password.length < 8)} onClick={() => void patchUser(user, { displayName: edit.displayName, email: edit.email, role: edit.role, password: edit.password || undefined, mustChangePassword: edit.mustChangePassword })}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存</button>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditing((current) => { const next = { ...current }; delete next[user.id]; return next; })}>取消</button>
                  </> : <>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditing({ ...editing, [user.id]: { displayName: user.displayName, email: user.email, role: user.role, password: "", mustChangePassword: user.mustChangePassword } })}><Pencil size={14} />编辑</button>
                    <button className={`ghost-button ${disabled ? "" : "danger-button"}`} disabled={busy || user.id === currentUser.id} onClick={() => void patchUser(user, { disabled: !disabled })}>
                      {busy ? <LoaderCircle className="spin" size={14} /> : disabled ? <Play size={14} /> : <Pause size={14} />}{disabled ? "启用" : "禁用"}
                    </button>
                  </>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {feedback && <div className={`user-settings-feedback ${feedback.kind}`} role="status">{feedback.message}</div>}
    </section>
  );
}

function WorkspaceDiagnosticsSettings() {
  const [diagnostic, setDiagnostic] = useState<WorkspaceDiagnosticPayload>();
  const [auditEvents, setAuditEvents] = useState<readonly AuditEventPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [targetUserId, setTargetUserId] = useState("");
  const [showAllAuditEvents, setShowAllAuditEvents] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly message: string }>();

  const loadDiagnostics = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/diagnostics", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as {
        readonly diagnostic?: WorkspaceDiagnosticPayload;
        readonly auditEvents?: readonly AuditEventPayload[];
        readonly message?: string;
      } | null;
      if (!response.ok || !payload?.diagnostic) throw new Error(payload?.message || "无法读取诊断数据");
      setDiagnostic(payload.diagnostic);
      setAuditEvents(payload.auditEvents ?? []);
      setTargetUserId((current) => current || payload.diagnostic?.users.find((user) => !user.disabledAt)?.userId || "");
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法读取诊断数据" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDiagnostics(); }, [loadDiagnostics]);

  async function assignUnownedData() {
    if (!targetUserId || assigning) return;
    const target = diagnostic?.users.find((user) => user.userId === targetUserId);
    if (!await appConfirm({
      title: "分配未归属历史数据？",
      description: `这些数据将分配给“${target?.displayName ?? "选中用户"}”。`,
      confirmLabel: "确认分配",
    })) return;
    setAssigning(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/admin/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId }),
      });
      const payload = await response.json().catch(() => null) as { readonly diagnostic?: WorkspaceDiagnosticPayload; readonly message?: string } | null;
      if (!response.ok || !payload?.diagnostic) throw new Error(payload?.message || "无法分配历史数据");
      setDiagnostic(payload.diagnostic);
      setFeedback({ kind: "success", message: "未归属历史数据已分配" });
      await loadDiagnostics();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法分配历史数据" });
    } finally {
      setAssigning(false);
    }
  }

  const unownedEntries = Object.entries(diagnostic?.unownedCounts ?? {}).filter(([, count]) => count > 0);
  const visibleAuditEvents = showAllAuditEvents ? auditEvents : auditEvents.slice(0, 10);
  return (
    <section className="workspace-diagnostics-settings panel" aria-labelledby="workspace-diagnostics-title">
      <div className="settings-section-heading">
        <h2 id="workspace-diagnostics-title">数据诊断</h2>
        <button className="secondary-button" disabled={loading} onClick={() => { setLoading(true); void loadDiagnostics(); }}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
        </button>
      </div>

      <div className="diagnostic-summary">
        <article><span><Users size={17} /></span><div><small>用户</small><strong>{loading ? "…" : diagnostic?.users.length ?? 0}</strong></div></article>
        <article><span><ShieldCheck size={17} /></span><div><small>未归属数据</small><strong>{loading ? "…" : diagnostic?.totalUnowned ?? 0}</strong></div></article>
        <article><span><DatabaseBackup size={17} /></span><div><small>审计事件</small><strong>{loading ? "…" : auditEvents.length}</strong></div></article>
      </div>

      {unownedEntries.length > 0 && <div className="diagnostic-unowned">
        <div>
          <strong>未归属历史数据</strong>
          <p>{unownedEntries.map(([key, count]) => `${diagnosticLabel(key)} ${count}`).join(" · ")}</p>
        </div>
        <div>
          <AppSelect ariaLabel="选择历史数据目标用户" size="compact" value={targetUserId} onValueChange={setTargetUserId} options={[{ value: "", label: "选择用户" }, ...(diagnostic?.users ?? []).filter((user) => !user.disabledAt).map((user) => ({ value: user.userId, label: `${user.displayName} · ${user.email}` }))]} />
          <button className="primary-button" disabled={assigning || !targetUserId} onClick={() => void assignUnownedData()}>
            {assigning ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{assigning ? "正在分配…" : "分配"}
          </button>
        </div>
      </div>}

      <div className="diagnostic-user-grid">
        {loading ? <div className="accounts-empty"><LoaderCircle className="spin" size={18} />正在读取诊断数据…</div> : (diagnostic?.users ?? []).map((user) => (
          <article className={`diagnostic-user-card ${user.disabledAt ? "disabled" : ""}`} key={user.userId}>
            <header>
              <div><strong>{user.displayName}</strong><span>{user.email}</span></div>
              <em>{user.disabledAt ? "已禁用" : roleLabel(user.role)}</em>
            </header>
            <div className="diagnostic-counts">
              {diagnosticCoreCounts(user.counts).map(([key, count]) => <span key={key}><small>{diagnosticLabel(key)}</small><strong>{count}</strong></span>)}
            </div>
          </article>
        ))}
      </div>

      <div className="diagnostic-audit">
        <div className="diagnostic-audit-heading">
          <h3>最近审计</h3>
          {auditEvents.length > 10 && <button className="quiet-button" onClick={() => setShowAllAuditEvents((current) => !current)}>
            {showAllAuditEvents ? "收起" : `查看全部 ${auditEvents.length} 条`}
          </button>}
        </div>
        {visibleAuditEvents.length ? visibleAuditEvents.map((event) => (
          <article key={event.id}>
            <span>{auditActionLabel(event.action)}</span>
            <strong>{event.actorDisplayName ?? event.actorEmail ?? "系统"}</strong>
            <small>{event.targetDisplayName || event.targetEmail ? `目标：${event.targetDisplayName ?? event.targetEmail}` : "无目标"} · {formatAccountTime(event.createdAt)}</small>
          </article>
        )) : <div className="accounts-empty">暂无审计事件</div>}
      </div>

      {feedback && <div className={`user-settings-feedback ${feedback.kind}`} role="status">{feedback.message}</div>}
    </section>
  );
}

function AiAutomationSettings() {
  const [settings, setSettings] = useState<{ readonly autoExecutionEnabled: boolean; readonly highRiskAutoEnabled: boolean }>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly message: string }>();
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/actions/settings", { cache: "no-store" });
      const payload = await response.json() as { readonly ok?: boolean; readonly settings?: typeof settings; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.settings) throw new Error(payload.message || "无法读取 AI 自动执行设置");
      setSettings(payload.settings);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法读取 AI 自动执行设置" });
    }
  }, []);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const save = async (next: { readonly autoExecutionEnabled: boolean; readonly highRiskAutoEnabled: boolean }) => {
    setSaving(true);
    try {
      const response = await fetch("/api/ai/actions/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly settings?: typeof settings; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.settings) throw new Error(payload.message || "无法保存 AI 自动执行设置");
      setSettings(payload.settings);
      setFeedback({ kind: "success", message: "AI 自动执行设置已保存" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法保存 AI 自动执行设置" });
    } finally {
      setSaving(false);
    }
  };

  const current = settings ?? { autoExecutionEnabled: false, highRiskAutoEnabled: false };
  return (
    <section className="ai-automation-settings panel">
      <div className="settings-section-heading">
        <h2>AI 自动执行</h2>
      </div>
      <div className="ai-automation-grid">
        <label><input type="checkbox" checked={current.autoExecutionEnabled} disabled={saving} onChange={(event) => void save({ ...current, autoExecutionEnabled: event.target.checked, highRiskAutoEnabled: event.target.checked ? current.highRiskAutoEnabled : false })} /><span><strong>允许自动写入</strong><small>创建任务、笔记、日程和邮件草稿。</small></span></label>
        <label><input type="checkbox" checked={current.highRiskAutoEnabled} disabled={saving || !current.autoExecutionEnabled} onChange={(event) => void save({ ...current, highRiskAutoEnabled: event.target.checked })} /><span><strong>允许高风险外部动作</strong><small>发送邮件、归档/删除/移动邮件等动作。</small></span></label>
      </div>
      {feedback && <div className={`user-settings-feedback ${feedback.kind}`}>{feedback.message}</div>}
    </section>
  );
}

interface BackupStatusPayload {
  readonly databaseBytes: number;
  readonly estimatedLightweightBytes: number;
  readonly attachmentBytes: number;
  readonly attachmentFiles: number;
  readonly keySource: "environment" | "none";
  readonly counts: Readonly<Record<string, number>>;
  readonly mailCache: {
    readonly totalMessages: number;
    readonly cachedBodies: number;
    readonly cachedBodyBytes: number;
  };
  readonly latestAutomaticBackupAt?: string;
  readonly automatic: AutomaticBackupPayload;
  readonly strategy?: BackupStrategyPayload;
  readonly artifacts?: readonly BackupArtifactPayload[];
}

interface AutomaticBackupPayload {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly retentionCount: number;
  readonly encryptAutomatic: boolean;
  readonly encryptionPasswordConfigured: boolean;
  readonly nextRunAt?: string;
  readonly lastEnqueuedAt?: string;
  readonly lastCompletedAt?: string;
  readonly updatedAt?: string;
}

interface BackupStrategyPayload {
  readonly recommendedMailPolicy: BackupMailPolicyPayload;
  readonly backupDirectory: string;
  readonly attachmentDirectory: string;
  readonly tools: {
    readonly pgDump: boolean;
    readonly pgRestore: boolean;
    readonly tar: boolean;
    readonly openssl: boolean;
  };
  readonly coverage: readonly BackupCoveragePayload[];
  readonly options?: readonly BackupPolicyOptionPayload[];
  readonly warnings: readonly string[];
}

type BackupMailPolicyPayload = "lightweight" | "full-archive" | "configuration-only";

interface BackupPolicyOptionPayload {
  readonly policy: BackupMailPolicyPayload;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly available: boolean;
  readonly disabledReason?: string;
  readonly coverage: readonly BackupCoveragePayload[];
}

interface BackupCoveragePayload {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly included: boolean;
}

interface BackupArtifactPayload {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly encrypted: boolean;
  readonly mailPolicy?: BackupMailPolicyPayload;
  readonly source: "server" | "upload" | "safety";
  readonly restoredAt?: string;
  readonly createdAt: string;
}

function BackupSettings() {
  const [status, setStatus] = useState<BackupStatusPayload>();
  const [loading, setLoading] = useState(true);
  const [backupPassword, setBackupPassword] = useState("");
  const [encryptBackup, setEncryptBackup] = useState(true);
  const [selectedBackupPolicy, setSelectedBackupPolicy] = useState<BackupMailPolicyPayload>("lightweight");
  const [automaticDraft, setAutomaticDraft] = useState<AutomaticBackupPayload>();
  const [busyBackupId, setBusyBackupId] = useState<string>();
  const [artifactMenu, setArtifactMenu] = useState<ContextMenuState>();
  const [activeBackupJobId, setActiveBackupJobId] = useState<string>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error" | "info"; readonly message: string }>();
  const backupUploadRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async (options: {
    readonly preserveAutomaticDraft?: boolean;
    readonly silent?: boolean;
  } = {}) => {
    try {
      const response = await fetch("/api/backups", { cache: "no-store" });
      const payload = await response.json() as { readonly ok?: boolean; readonly status?: BackupStatusPayload; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.status) throw new Error(payload.message || "无法读取备份状态");
      setStatus(payload.status);
      if (!options.preserveAutomaticDraft) setAutomaticDraft(payload.status.automatic);
      setSelectedBackupPolicy((current) => {
        const options = payload.status?.strategy?.options ?? [];
        return options.some((option) => option.policy === current && option.available)
          ? current
          : payload.status?.strategy?.recommendedMailPolicy ?? "lightweight";
      });
    } catch (error) {
      if (!options.silent) {
        setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法读取备份状态" });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  const refreshBackupStatus = useCallback(
    () => loadStatus({ preserveAutomaticDraft: true, silent: true }),
    [loadStatus],
  );
  useRealtimeRefresh(["backup"], refreshBackupStatus, 100);
  useVisiblePageRefresh(refreshBackupStatus, 60_000);
  useRealtimeEvent(["job"], (event) => {
    if (!activeBackupJobId || event.entityId !== activeBackupJobId) return;
    if (event.status === "succeeded") {
      setActiveBackupJobId(undefined);
      setFeedback({ kind: "success", message: "备份创建完成，历史记录已更新" });
      void refreshBackupStatus();
    } else if (event.status === "failed" || event.status === "cancelled") {
      setActiveBackupJobId(undefined);
      setFeedback({ kind: "error", message: event.status === "failed" ? "备份创建失败，请在任务中心查看日志" : "备份任务已取消" });
      void refreshBackupStatus();
    }
  });

  const createBackup = async () => {
    if (encryptBackup && backupPassword.length < 8) {
      setFeedback({ kind: "error", message: "加密备份密码至少需要 8 个字符" });
      return;
    }
    setBusyBackupId("create");
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encrypted: encryptBackup, mailPolicy: selectedBackupPolicy, password: encryptBackup ? backupPassword : undefined }),
      });
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly job?: Pick<AppJobPayload, "id">;
        readonly message?: string;
      };
      if (!response.ok || !payload.ok || !payload.job) throw new Error(payload.message || "无法创建备份任务");
      setActiveBackupJobId(payload.job.id);
      setFeedback({ kind: "info", message: "正在创建备份，完成后会自动更新历史" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法创建备份任务" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const uploadBackup = async (file: File) => {
    setBusyBackupId("upload");
    try {
      const response = await fetch("/api/backups/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Backup-Filename": file.name },
        body: file,
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "无法上传备份");
      setFeedback({ kind: "success", message: "备份文件已上传并加入历史" });
      await loadStatus();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法上传备份" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const restoreArtifact = async (artifact: BackupArtifactPayload) => {
    if (!await appConfirm({
      title: `恢复备份“${artifact.filename}”？`,
      description: "系统会先创建恢复前安全备份，然后替换当前数据库和附件。",
      confirmLabel: "恢复备份",
      tone: "danger",
    })) return;
    if (artifact.encrypted && backupPassword.length < 8) {
      setFeedback({ kind: "error", message: "恢复加密备份需要输入备份密码" });
      return;
    }
    setBusyBackupId(artifact.id);
    try {
      const response = await fetch(`/api/backups/${encodeURIComponent(artifact.id)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, password: artifact.encrypted ? backupPassword : undefined }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "无法创建恢复任务");
      setFeedback({ kind: "success", message: "恢复任务已创建，可在任务中心查看进度" });
      await loadStatus();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法创建恢复任务" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const deleteArtifact = async (artifact: BackupArtifactPayload) => {
    if (!await appConfirm({
      title: `永久删除备份“${artifact.filename}”？`,
      description: `服务器上的备份文件和历史记录都会被删除，将释放 ${formatFileSize(artifact.sizeBytes)} 空间。此操作无法撤销。`,
      confirmLabel: "删除备份",
      tone: "danger",
    })) return;
    setBusyBackupId(artifact.id);
    try {
      const response = await fetch(`/api/backups/${encodeURIComponent(artifact.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "无法删除备份");
      setFeedback({ kind: "success", message: "备份文件和历史记录已删除" });
      await loadStatus();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法删除备份" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const saveAutomaticSettings = async () => {
    const draft = automaticDraft ?? status?.automatic;
    if (!draft) return;
    setBusyBackupId("automatic");
    try {
      const response = await fetch("/api/backups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: draft.enabled,
          intervalHours: draft.intervalHours,
          retentionCount: draft.retentionCount,
          encryptAutomatic: draft.encryptAutomatic,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly settings?: AutomaticBackupPayload; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.settings) throw new Error(payload.message || "无法保存自动备份设置");
      setAutomaticDraft(payload.settings);
      setStatus((current) => current ? { ...current, automatic: payload.settings! } : current);
      setFeedback({ kind: "success", message: "自动备份设置已保存" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法保存自动备份设置" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const strategy = status?.strategy;
  const toolsReady = Boolean(strategy?.tools.pgDump && strategy.tools.pgRestore && strategy.tools.tar);
  const backupOptions = strategy?.options ?? [{
    policy: "lightweight" as const,
    label: "轻量工作区快照",
    description: "备份数据库和草稿附件。",
    recommended: true,
    available: true,
    coverage: strategy?.coverage ?? [],
  }];
  const selectedBackupOption = backupOptions.find((option) => option.policy === selectedBackupPolicy) ?? backupOptions[0];
  const selectedCoverage = selectedBackupOption?.coverage.length ? selectedBackupOption.coverage : strategy?.coverage ?? [];
  const compactCoverage = selectedCoverage.filter((item) => item.included || item.id === "mail-bodies");
  const selectedPolicyAvailable = selectedBackupOption?.available !== false;
  const availableBackupOptions = backupOptions.filter((option) => option.available);
  const mailCache = status?.mailCache;
  const mailCacheLabel = mailCache
    ? `${mailCache.cachedBodies}/${mailCache.totalMessages} 封正文 · ${formatFileSize(mailCache.cachedBodyBytes)}`
    : "—";
  const automatic = automaticDraft ?? status?.automatic;
  const artifactMenuItem = artifactMenu ? status?.artifacts?.find((artifact) => artifact.id === artifactMenu.id) : undefined;
  const artifactCommands: readonly ResolvedContextCommand[] = artifactMenuItem ? [
    { id: "backup.download", label: "下载备份文件", group: "primary", risk: "read", icon: "download" },
    { id: "backup.copy-name", label: "复制文件名", group: "primary", risk: "read", icon: "copy" },
    { id: "backup.copy-checksum", label: "复制 SHA256", group: "primary", risk: "read", icon: "info" },
    { id: "backup.restore", label: "从此备份恢复", group: "danger", risk: "destructive", icon: "restore" },
    { id: "backup.delete", label: "永久删除备份", group: "danger", risk: "destructive", icon: "trash" },
  ] : [];

  const openArtifactMenu = (event: ReactMouseEvent<HTMLElement>, artifact: BackupArtifactPayload) => {
    event.preventDefault();
    setArtifactMenu({ id: artifact.id, x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
  };

  const selectArtifactCommand = (commandId: ContextCommandId) => {
    if (!artifactMenuItem) return;
    if (commandId === "backup.download") window.open(`/api/backups/${encodeURIComponent(artifactMenuItem.id)}/download`, "_blank", "noopener,noreferrer");
    if (commandId === "backup.restore") void restoreArtifact(artifactMenuItem);
    if (commandId === "backup.copy-name") void copyText(artifactMenuItem.filename, "备份文件名已复制", setFeedback);
    if (commandId === "backup.copy-checksum") void copyText(artifactMenuItem.checksumSha256, "SHA256 已复制", setFeedback);
    if (commandId === "backup.delete") void deleteArtifact(artifactMenuItem);
  };

  return (
    <section className="backup-settings panel" aria-labelledby="backup-settings-title">
      <div className="settings-section-heading">
        <h2 id="backup-settings-title">备份</h2>
        <span className="step-badge">{loading ? "检查中" : toolsReady ? "可执行" : "需安装工具"}</span>
      </div>

      <div className="backup-summary" aria-label="当前数据概况">
        <article><span><HardDrive size={17} /></span><div><small>数据库占用</small><strong>{loading ? "正在计算…" : formatFileSize(status?.databaseBytes ?? 0)}</strong></div></article>
        <article title="根据 PostgreSQL 压缩转储和草稿附件估算；结果缓存 5 分钟，实际文件可能略有差异"><span><DatabaseBackup size={17} /></span><div><small>预计轻量备份</small><strong>{loading ? "正在估算…" : `约 ${formatFileSize(status?.estimatedLightweightBytes ?? 0)}`}</strong></div></article>
        <article><span><Mail size={17} /></span><div><small>邮件缓存（不备份）</small><strong>{loading ? "—" : mailCacheLabel}</strong></div></article>
        <article><span><Paperclip size={17} /></span><div><small>草稿附件</small><strong>{loading ? "—" : `${status?.attachmentFiles ?? 0} 个 · ${formatFileSize(status?.attachmentBytes ?? 0)}`}</strong></div></article>
      </div>

      {availableBackupOptions.length > 1 && (
        <section className="backup-type-picker" aria-label="备份类型">
          <header><h3>备份类型</h3></header>
          <div>
            {availableBackupOptions.map((option) => (
              <button
                type="button"
                className={option.policy === selectedBackupPolicy ? "active" : ""}
                key={option.policy}
                aria-pressed={option.policy === selectedBackupPolicy}
                onClick={() => setSelectedBackupPolicy(option.policy)}
              >
                <span><Check size={14} /></span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="backup-live-actions backup-live-actions-single">
        <article className="backup-create-card">
          <header>
            <DatabaseBackup size={18} />
            <div><h3>创建{selectedBackupOption ? backupPolicyLabel(selectedBackupOption.policy) : "备份"}</h3><p>保存工作区数据和草稿附件，邮件正文恢复后按需重新获取。</p></div>
          </header>
          <div className="backup-scope-summary" aria-label="备份范围">
            {compactCoverage.map((item) => (
              <span key={item.id} className={item.included ? "included" : "excluded"}>
                {item.included ? <Check size={12} /> : <Circle size={12} />}{item.label}
              </span>
            ))}
          </div>
          <div className="backup-create-controls">
            <label className="secure-toggle"><input type="checkbox" checked={encryptBackup} onChange={(event) => setEncryptBackup(event.target.checked)} /><span>加密备份</span></label>
            {encryptBackup && <input value={backupPassword} type="password" placeholder="输入备份密码（至少 8 位）" onChange={(event) => setBackupPassword(event.target.value)} />}
            <button className="primary-button" disabled={Boolean(busyBackupId) || !selectedPolicyAvailable || !toolsReady} onClick={() => void createBackup()}>{busyBackupId === "create" ? <LoaderCircle className="spin" size={14} /> : <DatabaseBackup size={14} />}创建备份</button>
          </div>
          {!selectedPolicyAvailable && selectedBackupOption?.disabledReason && <small className="backup-risk">{selectedBackupOption.disabledReason}</small>}
          {!toolsReady && <small className="backup-risk">服务器缺少备份工具，请先完成运行环境配置。</small>}
          {!encryptBackup && <small className="backup-risk">未加密备份包含敏感配置，请只保存在可信设备。</small>}
        </article>
      </div>

      {automatic && (
        <div className="automatic-backup-card">
          <header>
            <div><h3>自动备份</h3><p>后台任务会按间隔创建服务器历史备份，并按保留数量清理旧自动备份。</p></div>
            <span className={automatic.enabled ? "ready" : ""}>{automatic.enabled ? "已开启" : "未开启"}</span>
          </header>
          <div className="automatic-backup-controls">
            <label><input type="checkbox" checked={automatic.enabled} onChange={(event) => setAutomaticDraft({ ...automatic, enabled: event.target.checked })} /><span>启用自动备份</span></label>
            <label><span>间隔小时</span><input type="number" min={1} max={720} value={automatic.intervalHours} onChange={(event) => setAutomaticDraft({ ...automatic, intervalHours: Number(event.target.value) })} /></label>
            <label><span>保留份数</span><input type="number" min={1} max={365} value={automatic.retentionCount} onChange={(event) => setAutomaticDraft({ ...automatic, retentionCount: Number(event.target.value) })} /></label>
            <label><input type="checkbox" checked={automatic.encryptAutomatic} onChange={(event) => setAutomaticDraft({ ...automatic, encryptAutomatic: event.target.checked })} /><span>自动备份加密</span></label>
            <button className="secondary-button" disabled={busyBackupId === "automatic"} onClick={() => void saveAutomaticSettings()}>{busyBackupId === "automatic" ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}保存策略</button>
          </div>
          <footer>
            <small>下次执行：{automatic.enabled && automatic.nextRunAt ? formatAccountTime(automatic.nextRunAt) : "未计划"}</small>
            <small>最近完成：{automatic.lastCompletedAt ? formatAccountTime(automatic.lastCompletedAt) : "暂无"}</small>
            {automatic.encryptAutomatic && !automatic.encryptionPasswordConfigured && <small className="backup-risk">自动加密需要在服务器设置 KALENDER_BACKUP_PASSWORD。</small>}
          </footer>
        </div>
      )}

      <div className="backup-history">
        <div className="backup-history-heading">
          <h3>备份历史</h3>
          <input
            ref={backupUploadRef}
            className="backup-file-input"
            type="file"
            accept=".backup,.qgwbackup,.enc,application/octet-stream"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadBackup(file);
              event.currentTarget.value = "";
            }}
          />
          <button className="secondary-button" disabled={Boolean(busyBackupId)} onClick={() => backupUploadRef.current?.click()}>
            {busyBackupId === "upload" ? <LoaderCircle className="spin" size={13} /> : <Upload size={13} />}上传备份
          </button>
        </div>
        {status?.artifacts?.length ? status.artifacts.map((artifact) => (
          <article
            key={artifact.id}
            tabIndex={0}
            onContextMenu={(event) => openArtifactMenu(event, artifact)}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              setArtifactMenu({ id: artifact.id, x: bounds.right - 12, y: bounds.top + 28, returnFocus: event.currentTarget });
            }}
          >
            <div><strong>{artifact.filename}</strong><small>{backupPolicyLabel(artifact.mailPolicy ?? "lightweight")} · {artifact.source === "safety" ? "恢复前安全备份" : artifact.source === "upload" ? "上传文件" : "服务器创建"} · {artifact.encrypted ? "已加密" : "未加密"} · {formatAccountTime(artifact.createdAt)}</small></div>
            <span>{formatFileSize(artifact.sizeBytes)}</span>
            <a className="secondary-button" href={`/api/backups/${encodeURIComponent(artifact.id)}/download`}><Download size={13} />下载</a>
            <button className="danger-confirm-button" disabled={Boolean(busyBackupId)} onClick={() => void restoreArtifact(artifact)}>{busyBackupId === artifact.id ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}恢复</button>
            <button className="ghost-button danger-button" disabled={Boolean(busyBackupId)} onClick={() => void deleteArtifact(artifact)}><Trash2 size={13} />删除</button>
          </article>
        )) : <div className="accounts-empty">还没有备份历史</div>}
      </div>

      {feedback && <div className={`backup-feedback ${feedback.kind}`} role="status"><span>{feedback.message}</span><button aria-label="关闭提示" onClick={() => setFeedback(undefined)}><X size={13} /></button></div>}
      {artifactMenu && artifactMenuItem && (
        <ContextMenu
          anchor={{ x: artifactMenu.x, y: artifactMenu.y }}
          ariaLabel={`备份操作：${artifactMenuItem.filename}`}
          commands={artifactCommands}
          heading={artifactMenuItem.filename}
          returnFocus={artifactMenu.returnFocus}
          testId="backup-context-menu"
          onClose={() => setArtifactMenu(undefined)}
          onSelect={selectArtifactCommand}
        />
      )}

      {status?.keySource !== "environment" && (
        <div className="backup-notes">
          <ShieldCheck size={16} />
          <div><strong>缺少 KALENDER_MASTER_KEY</strong><p>恢复账户凭据需要使用创建备份时的原始主密钥。</p></div>
        </div>
      )}
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function backupPolicyLabel(policy: BackupMailPolicyPayload): string {
  if (policy === "configuration-only") return "仅配置备份";
  if (policy === "full-archive") return "完整归档";
  return "轻量备份";
}

async function copyText(
  value: string,
  successMessage: string,
  setFeedback: (feedback: { readonly kind: "success" | "error"; readonly message: string }) => void,
): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
    setFeedback({ kind: "success", message: successMessage });
  } catch {
    setFeedback({ kind: "error", message: "复制失败，请手动选择文本" });
  }
}

function jobFilterLabel(value: string): string {
  return { active: "活跃", queued: "排队", running: "运行", failed: "失败", succeeded: "成功", cancelled: "取消" }[value] ?? value;
}

function jobStatusLabel(value: string): string {
  return { queued: "排队", running: "运行中", succeeded: "成功", failed: "失败", cancelled: "已取消" }[value] ?? value;
}

function appJobStatus(value: string | undefined): AppJobPayload["status"] | undefined {
  return value === "queued"
    || value === "running"
    || value === "succeeded"
    || value === "failed"
    || value === "cancelled"
    ? value
    : undefined;
}

function jobKindLabel(value: string): string {
  return {
    "backup.create": "创建备份",
    "backup.restore": "恢复备份",
    "mail.sync": "邮件同步",
    "calendar.sync": "日历同步",
    "ai.action": "AI 动作",
    maintenance: "维护",
  }[value] ?? value;
}

function roleLabel(role: AppRole): string {
  return role === "admin" ? "管理员" : role === "viewer" ? "只读用户" : "普通用户";
}

function roleOptions() {
  return [
    { value: "user", label: "普通用户" },
    { value: "viewer", label: "只读用户" },
    { value: "admin", label: "管理员" },
  ];
}

function diagnosticLabel(key: string): string {
  return ({
    accounts: "邮箱账户",
    calendar_accounts: "日历账户",
    exchange_connections: "Exchange",
    calendars: "日历",
    calendar_events: "日程",
    projects: "项目",
    notes: "笔记",
    tasks: "任务",
    entity_links: "关联",
    mail_drafts: "草稿",
    mail_signatures: "邮件签名",
    mail_draft_attachments: "草稿附件",
    mail_messages: "邮件",
    ai_providers: "AI Provider",
    ai_conversations: "AI 对话",
    ai_feature_bindings: "AI 绑定",
    ai_messages: "AI 消息",
  } as Record<string, string>)[key] ?? key;
}

function diagnosticCoreCounts(counts: Readonly<Record<string, number>>): readonly [string, number][] {
  return ["accounts", "calendar_events", "projects", "tasks", "notes", "mail_messages", "ai_conversations"]
    .map((key) => [key, counts[key] ?? 0] as [string, number]);
}

function auditActionLabel(action: string): string {
  return ({
    "auth.login": "登录",
    "user.create": "创建用户",
    "user.update": "更新用户",
    "user.profile.update": "修改个人账号",
    "workspace.assign-unowned": "分配历史数据",
    "sync.settings.update": "修改同步设置",
  } as Record<string, string>)[action] ?? action;
}

function MailAccountSettings({ onManageExchange }: { readonly onManageExchange: () => void }) {
  const [accounts, setAccounts] = useState<readonly SavedMailAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncIntervalMs, setSyncIntervalMs] = useState(3 * 60 * 1000);
  const [accountAction, setAccountAction] = useState<{ readonly id: string; readonly kind: AccountAction }>();
  const [accountFeedback, setAccountFeedback] = useState("");
  const providerId = "imap";
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
        readonly scheduler?: { readonly enabled?: boolean; readonly intervalMs?: number };
      };
      if (!response.ok) throw new Error("无法读取邮箱账户");
      setAccounts(result.accounts ?? []);
      if (typeof result.scheduler?.enabled === "boolean") setSyncEnabled(result.scheduler.enabled);
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
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);
  useRealtimeRefresh(["mail"], loadAccounts);
  useVisiblePageRefresh(loadAccounts, 60_000);

  async function performAccountAction(account: SavedMailAccount, kind: Exclude<AccountAction, "edit">) {
    if (kind === "delete" && !await appConfirm({
      title: account.providerId === "exchange-ews"
        ? `移除“${account.displayName}”的邮件连接？`
        : `删除邮件账户“${account.displayName}”？`,
      description: account.providerId === "exchange-ews"
        ? "本地邮件索引会被删除，日历连接和共享加密凭据将保留。"
        : "该账户的加密凭据、邮件索引和同步记录都会从本机删除。",
      confirmLabel: account.providerId === "exchange-ews" ? "移除连接" : "删除账户",
      tone: "danger",
    })) return;
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
          imap: { host: imapHost, port: Number(imapPort), secure: imapSecure, username, password },
          smtp: { host: smtpHost, port: Number(smtpPort), secure: smtpSecure, username, password },
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

  const canTest = emailAddress.includes("@") && Boolean(imapHost && smtpHost && username && (password || editingAccountId));

  async function saveAccount() {
    if (state.kind !== "success") return;
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
        <h2 id="saved-accounts-title">邮箱账户</h2>
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
                    <span>自动同步：{syncEnabled ? `每 ${formatSyncInterval(syncIntervalMs)}` : "已关闭"}</span>
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

    <MailSignatureSettings accounts={accounts} />

    <details className="account-settings panel" id="add-mail-account" open={editingAccountId ? true : undefined}>
      <summary className="settings-disclosure-heading">
        <span><strong>{editingAccountId ? "重新配置邮箱账户" : "添加邮箱账户"}</strong><small>IMAP / SMTP</small></span>
        <ChevronDown size={16} />
      </summary>
      <div className="account-settings-body">
        {editingAccountId && <p className="settings-inline-note">密码留空时保留原密码。</p>}
        <div className="account-form">
        <label><span>账户名称</span><input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setState({ kind: "idle" }); }} placeholder="例如：工作邮箱" /></label>
        <label><span>邮箱地址</span><input type="email" value={emailAddress} onChange={(event) => { setEmailAddress(event.target.value); setState({ kind: "idle" }); }} placeholder="name@example.com" /></label>
        <label><span>IMAP 服务器</span><input value={imapHost} onChange={(event) => { setImapHost(event.target.value); setState({ kind: "idle" }); }} placeholder="imap.example.com" /></label>
        <label><span>端口</span><input inputMode="numeric" value={imapPort} onChange={(event) => { setImapPort(event.target.value); setState({ kind: "idle" }); }} /></label>
        <label><span>SMTP 服务器</span><input value={smtpHost} onChange={(event) => { setSmtpHost(event.target.value); setState({ kind: "idle" }); }} placeholder="smtp.example.com" /></label>
        <label><span>端口</span><input inputMode="numeric" value={smtpPort} onChange={(event) => { setSmtpPort(event.target.value); setState({ kind: "idle" }); }} /></label>
        <label><span>用户名</span><input value={username} onChange={(event) => { setUsername(event.target.value); setState({ kind: "idle" }); }} autoComplete="username" /></label>
        <label><span>密码或应用专用密码</span><input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setState({ kind: "idle" }); }} autoComplete="new-password" placeholder={editingAccountId ? "留空则保留原密码" : undefined} /></label>
        <label className="secure-toggle"><input type="checkbox" checked={imapSecure} onChange={(event) => { setImapSecure(event.target.checked); setState({ kind: "idle" }); }} /><span>IMAP 使用直接 TLS（通常为 993）</span></label>
        <label className="secure-toggle"><input type="checkbox" checked={smtpSecure} onChange={(event) => { setSmtpSecure(event.target.checked); setState({ kind: "idle" }); }} /><span>SMTP 使用直接 TLS（通常为 465；587 请取消）</span></label>
        </div>
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
        <button className="primary-button" disabled={!online || state.kind !== "success" || saving} onClick={saveAccount}>
          {saving && <LoaderCircle className="spin" size={16} />}{saving ? "正在保存和同步…" : "保存并开始同步"}
        </button>
        </footer>
        <p className="settings-footnote">凭据会加密保存。Exchange / RWTH 邮箱请在“日历账户”中统一连接。</p>
      </div>
    </details>
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
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncIntervalMs, setSyncIntervalMs] = useState(3 * 60 * 1000);
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
      const payload = await response.json() as {
        readonly accounts?: readonly SavedCalendarAccount[];
        readonly scheduler?: { readonly enabled?: boolean; readonly intervalMs?: number };
        readonly message?: string;
      };
      if (!response.ok) throw new Error(payload.message || "无法读取日历账户");
      setAccounts(payload.accounts ?? []);
      if (typeof payload.scheduler?.enabled === "boolean") setSyncEnabled(payload.scheduler.enabled);
      if (payload.scheduler?.intervalMs) setSyncIntervalMs(payload.scheduler.intervalMs);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取日历账户");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useRealtimeRefresh(["calendar"], loadAccounts);
  useVisiblePageRefresh(loadAccounts, 60_000);

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
    if (kind === "delete" && !await appConfirm({
      title: `删除日历账户“${account.displayName}”？`,
      description: "加密凭据和已同步的本地日历索引将从本机删除，远端日历不会受到影响。",
      confirmLabel: "删除账户",
      tone: "danger",
    })) return;
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
        <h2 id="calendar-accounts-title">日历账户</h2>
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
                <div className="saved-account-meta"><span>{account.providerId === "ics" ? "ICS 订阅 · 只读" : account.providerId === "exchange" ? `Exchange / RWTH · ${[account.mailEnabled && "邮件", account.calendarEnabled && "日历"].filter(Boolean).join(" + ") || "已暂停"}` : "CalDAV · 只读"}</span><span>{account.calendarsCount} 个日历</span><span>上次同步：{account.lastSyncAt ? formatAccountTime(account.lastSyncAt) : "尚未同步"}</span><span>自动同步：{syncEnabled ? `每 ${formatSyncInterval(syncIntervalMs)}` : "已关闭"}</span></div>
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
      {feedback && <TransientToast message={feedback} onClose={() => setFeedback("")} />}
      <p className="settings-footnote">CalDAV 与 ICS 为只读；Exchange 凭据会加密保存。会议邀请和重复日程请在原服务中修改。</p>
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

function AiPage() {
  return <AiCommand />;
}

function AssistantPanel({
  title,
  section,
  onClose,
}: {
  readonly title: string;
  readonly section: WorkspaceSection;
  readonly onClose: () => void;
}) {
  const { snapshot, sendCommand } = useWorkspaceAssistant();
  const [confirmTask, setConfirmTask] = useState(false);
  const mailSnapshot = section === "inbox" && snapshot?.kind === "mail" ? snapshot : undefined;
  const selectedMessage = mailSnapshot?.message;
  const mailResult = mailSnapshot?.result;
  const result = mailResult?.messageId === selectedMessage?.id ? mailResult : undefined;

  useEffect(() => setConfirmTask(false), [selectedMessage?.id, section]);

  if (section !== "inbox") {
    const EmptyIcon = section === "calendar" ? CalendarClock : ListChecks;
    return (
      <aside className="assistant-panel context-assistant-panel" aria-label={title}>
        <AssistantHeader title={title} subtitle="上下文助手" onClose={onClose} />
        <section className="assistant-empty-state">
          <EmptyIcon size={22} />
          <h3>当前页面还没有可用建议</h3>
          <p>此模块尚未接入真实的{section === "calendar" ? "日程" : "任务"}上下文，因此不会生成或执行操作。</p>
        </section>
      </aside>
    );
  }

  return (
    <aside className="assistant-panel context-assistant-panel" aria-label={title}>
      <AssistantHeader title={title} subtitle="当前邮件上下文" onClose={onClose} />
      {!mailSnapshot || mailSnapshot.loading ? (
        <section className="assistant-empty-state" role="status">
          <LoaderCircle className="spin" size={21} />
          <h3>正在读取邮件上下文</h3>
        </section>
      ) : !mailSnapshot.hasAccounts ? (
        <section className="assistant-empty-state">
          <Mail size={22} />
          <h3>尚未连接邮箱</h3>
          <p>连接邮箱后，助手才能分析真实邮件内容。</p>
          <Link className="secondary-button" href="/settings?tab=mail">连接邮箱</Link>
        </section>
      ) : !selectedMessage ? (
        <section className="assistant-empty-state">
          <Mail size={22} />
          <h3>选择一封邮件</h3>
          <p>选择邮件后可生成摘要、提取行动项或准备回复草稿。</p>
        </section>
      ) : (
        <>
          <section className="assistant-context-source">
            <span>当前邮件</span>
            <h3>{selectedMessage.subject}</h3>
            <p>{selectedMessage.sender} &lt;{selectedMessage.senderAddress}&gt;</p>
            <small>{selectedMessage.accountName} · {formatAssistantMailTime(selectedMessage.receivedAt)}</small>
          </section>

          <section className="assistant-mail-actions" aria-label="邮件 AI 操作">
            <button disabled={Boolean(mailSnapshot.aiBusy)} onClick={() => sendCommand({ type: "mail.run-ai", action: "summarize" })}>
              {mailSnapshot.aiBusy === "summarize" ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span><strong>生成摘要</strong><small>概括请求、日期和风险</small></span>
            </button>
            <button disabled={Boolean(mailSnapshot.aiBusy)} onClick={() => sendCommand({ type: "mail.run-ai", action: "extract-actions" })}>
              {mailSnapshot.aiBusy === "extract-actions" ? <LoaderCircle className="spin" size={16} /> : <ListChecks size={16} />}
              <span><strong>提取行动项</strong><small>识别负责人和截止时间</small></span>
            </button>
            <button disabled={Boolean(mailSnapshot.aiBusy)} onClick={() => sendCommand({ type: "mail.run-ai", action: "draft-reply" })}>
              {mailSnapshot.aiBusy === "draft-reply" ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
              <span><strong>准备回复草稿</strong><small>生成后仍需检查并手动发送</small></span>
            </button>
          </section>

          {result && <section className="assistant-ai-result" aria-live="polite">
            <header>
              <div><Sparkles size={15} /><strong>{result.action === "summarize" ? "AI 摘要" : result.action === "extract-actions" ? "AI 行动项" : "AI 回复草稿"}</strong></div>
              <button type="button" aria-label="关闭 AI 结果" title="关闭 AI 结果" onClick={() => sendCommand({ type: "mail.clear-result" })}><X size={14} /></button>
            </header>
            <small>{result.modelName}{result.usedFallback ? " · 已使用备用模型" : ""}</small>
            <div>{result.text}</div>
          </section>}

          {mailSnapshot.notice && <div className="assistant-notice" role="status">{mailSnapshot.notice}</div>}

          <section className="assistant-write-action">
            <header><CheckCircle2 size={16} /><strong>关联到任务</strong></header>
            <p>以邮件主题创建待整理任务，并保留返回原邮件的链接。</p>
            {confirmTask ? <div className="assistant-confirm-row">
              <button className="primary-button" disabled={mailSnapshot.actionBusy} onClick={() => {
                sendCommand({ type: "mail.create-task" });
                setConfirmTask(false);
              }}>{mailSnapshot.actionBusy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}确认创建</button>
              <button className="ghost-button" disabled={mailSnapshot.actionBusy} onClick={() => setConfirmTask(false)}>取消</button>
            </div> : <button className="secondary-button" disabled={mailSnapshot.actionBusy} onClick={() => setConfirmTask(true)}><Plus size={14} />创建关联任务</button>}
          </section>
        </>
      )}
    </aside>
  );
}

function AssistantHeader({
  title,
  subtitle,
  onClose,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly onClose: () => void;
}) {
  return <header>
    <div className="assistant-icon"><Sparkles size={18} /></div>
    <div><h2>{title}</h2><p>{subtitle}</p></div>
    <button className="assistant-close" type="button" aria-label="收起上下文助手" title="收起上下文助手" onClick={onClose}><X size={16} /></button>
  </header>;
}

function formatAssistantMailTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
