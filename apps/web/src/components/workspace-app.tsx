"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { ContextMenu } from "./context-menu";
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
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import {
  resolveContextCommands,
  type CalendarEventCommandId,
  type CalendarSlotCommandId,
  type ContextCommandId,
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
  readonly providerData?: { readonly providerId?: string };
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

const pageCopy: Record<WorkspaceSection, { title: string; subtitle: string; assistant: string }> = {
  today: { title: "Today", subtitle: "当天日程、需要推进的任务和未读邮件。", assistant: "每日简报" },
  inbox: { title: "统一收件箱", subtitle: "两个账户 · 16 封未读", assistant: "邮件助手" },
  calendar: { title: "日历", subtitle: "在周视图和月视图中管理时间", assistant: "日程建议" },
  tasks: { title: "Today Tasks", subtitle: "从沟通到执行的统一任务列表", assistant: "任务建议" },
  projects: { title: "Projects", subtitle: "把任务、笔记和专注时间组织成可推进的项目", assistant: "项目建议" },
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

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function WorkspaceApp({
  section,
  initialMessageId,
  initialMailFolderId,
  initialTaskId,
  initialTaskView,
  initialCreateTask,
  initialScheduleTaskId,
  initialEventId,
  initialCalendarDate,
  initialNoteId,
  initialProjectId,
}: {
  readonly section: WorkspaceSection;
  readonly initialMessageId?: string;
  readonly initialMailFolderId?: string;
  readonly initialTaskId?: string;
  readonly initialTaskView?: TaskView;
  readonly initialCreateTask?: boolean;
  readonly initialScheduleTaskId?: string;
  readonly initialEventId?: string;
  readonly initialCalendarDate?: string;
  readonly initialNoteId?: string;
  readonly initialProjectId?: string;
}) {
  useVisualViewportLayout();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarWidthLoaded, setSidebarWidthLoaded] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sidebarMailAccounts, setSidebarMailAccounts] = useState<readonly SidebarMailAccount[]>();
  const [sidebarMailFolders, setSidebarMailFolders] = useState<readonly SidebarMailFolder[]>([]);
  const [sidebarMailUnreadCount, setSidebarMailUnreadCount] = useState(0);
  const [expandedMailAccounts, setExpandedMailAccounts] = useState<ReadonlySet<string>>(() => new Set());
  const [sidebarCalendars, setSidebarCalendars] = useState<readonly SidebarCalendarSource[]>();
  const [sidebarTasks, setSidebarTasks] = useState<readonly SidebarTaskSummary[]>();
  const [sidebarProjects, setSidebarProjects] = useState<readonly SidebarProjectSummary[]>();
  const [sidebarProjectMenu, setSidebarProjectMenu] = useState<SidebarProjectMenuState>();
  const [sidebarProjectAreaMenu, setSidebarProjectAreaMenu] = useState<SidebarProjectAreaMenuState>();
  const [sidebarProjectAreaTargetId, setSidebarProjectAreaTargetId] = useState<string>();
  const [sidebarProjectBusyId, setSidebarProjectBusyId] = useState<string>();
  const [sidebarProjectNotice, setSidebarProjectNotice] = useState<string>();
  const [collapsedProjectAreas, setCollapsedProjectAreas] = useState<ReadonlySet<string>>(() => new Set());
  const userMenuRef = useRef<HTMLDivElement>(null);
  const copy = pageCopy[section];
  const sidebarUnreadCount = sidebarMailAccounts?.reduce((total, account) => total + account.unreadCount, 0)
    ?? sidebarMailUnreadCount;

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
      workspaceFetch("/api/mail-accounts").then((response) => response.json()) as Promise<{ readonly accounts?: readonly { readonly id: string; readonly displayName: string; readonly color: string; readonly lastSyncAt?: string }[] }>,
      workspaceFetch("/api/mail-folders").then((response) => response.json()) as Promise<{ readonly folders?: readonly SidebarMailFolder[] }>,
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

  useEffect(() => {
    let cancelled = false;
    if (section === "inbox") {
      void refreshSidebarMail().catch(() => {
        if (!cancelled) setSidebarMailAccounts([]);
      });
    } else {
      setSidebarMailAccounts(undefined);
      setSidebarMailFolders([]);
      void workspaceFetch("/api/mail-summary")
        .then(async (response) => {
          const payload = await response.json() as { readonly ok?: boolean; readonly unreadCount?: number };
          if (!response.ok || !payload.ok) throw new Error("无法读取未读邮件数量");
          if (!cancelled) setSidebarMailUnreadCount(payload.unreadCount ?? 0);
        })
        .catch(() => {
          if (!cancelled) setSidebarMailUnreadCount(0);
        });
    }
    return () => { cancelled = true; };
  }, [refreshSidebarMail, section]);

  const refreshSidebarCalendars = useCallback(async () => {
    const response = await workspaceFetch("/api/calendars");
    const payload = await response.json() as { readonly ok?: boolean; readonly calendars?: readonly SidebarCalendarSource[] };
    if (!response.ok || !payload.ok) throw new Error("无法读取日历来源");
    setSidebarCalendars(payload.calendars ?? []);
  }, []);

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
    if (section !== "projects") return;
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

  const handleSidebarProjectCommand = (commandId: ProjectCommandId) => {
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
        void navigator.clipboard.writeText(href)
          .then(() => setSidebarProjectNotice("项目链接已复制"))
          .catch(() => window.prompt("复制项目链接", href));
      } else {
        window.prompt("复制项目链接", href);
      }
    } else if (commandId === "project.archive") {
      if (window.confirm(`归档项目“${project.name}”？关联内容会保留，之后可以恢复。`)) {
        void updateSidebarProject(project, { status: "archived" }, `已归档“${project.name}”`);
      }
    } else if (commandId === "project.restore") {
      void updateSidebarProject(project, { status: "active" }, `已恢复“${project.name}”`);
    }
  };

  const handleSidebarProjectAreaCommand = (commandId: ProjectAreaCommandId) => {
    const areaName = sidebarProjectAreaMenu?.areaName;
    if (!areaName) return;
    if (commandId === "project-area.create-project") {
      window.dispatchEvent(new CustomEvent<{ readonly areaName?: string }>(OPEN_PROJECT_DIALOG_EVENT, {
        detail: { areaName: areaName === "未分类" ? undefined : areaName },
      }));
      setSidebarOpen(false);
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

        {section === "inbox" && <div className="account-block">
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
        </div>}

        {section === "calendar" && <div className="account-block sidebar-context-block">
          <p className="eyebrow">日历来源</p>
          {sidebarCalendars === undefined ? <small>正在读取日历…</small> : sidebarCalendars.length
            ? <div className="sidebar-calendar-list">{sidebarCalendars.map((calendar) => <div className="sidebar-calendar-source" key={calendar.id}>
              <i style={{ background: calendar.color ?? "#86bdf5" }} />
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
              taskCounts={sidebarProjectTaskCounts}
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
                taskCounts={sidebarProjectTaskCounts}
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

        <div className={`page-grid ${section === "notes" ? "notes-page-grid" : ""} ${section === "today" ? "today-page-grid" : ""} ${section === "projects" ? "projects-page-grid" : ""}`}>
          <main className="page-main">
            {(section === "today" || section === "settings") && <header className="page-heading">
              <div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
              <PageAction section={section} />
            </header>}
            <PageContent section={section} initialMessageId={initialMessageId} initialMailFolderId={initialMailFolderId} initialTaskId={initialTaskId} initialTaskView={initialTaskView} initialCreateTask={initialCreateTask} initialScheduleTaskId={initialScheduleTaskId} initialEventId={initialEventId} initialCalendarDate={initialCalendarDate} initialNoteId={initialNoteId} initialProjectId={initialProjectId} />
          </main>
          {section !== "notes" && section !== "today" && section !== "projects" && <AssistantPanel title={copy.assistant} section={section} />}
        </div>
      </section>
      <MobileBottomNav section={section} unreadCount={sidebarUnreadCount} />
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
          { id: "project-area.toggle", label: collapsedProjectAreas.has(sidebarProjectAreaMenu.areaName) ? "展开领域" : "折叠领域", group: "organize", risk: "read", icon: collapsedProjectAreas.has(sidebarProjectAreaMenu.areaName) ? "eye" : "eye-off" },
          { id: "project-area.collapse-others", label: "折叠其他领域", group: "organize", risk: "read", icon: "archive" },
        ]}
        heading={sidebarProjectAreaMenu.areaName}
        returnFocus={sidebarProjectAreaMenu.returnFocus}
        testId="project-area-context-menu"
        onClose={() => setSidebarProjectAreaMenu(undefined)}
        onSelect={(commandId) => handleSidebarProjectAreaCommand(commandId as ProjectAreaCommandId)}
      />}
      {sidebarProjectAreaTarget && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sidebarProjectBusyId) setSidebarProjectAreaTargetId(undefined);
      }}>
        <section className="calendar-dialog project-area-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-area-dialog-title">
          <header><div><span>重新组织项目</span><h2 id="project-area-dialog-title">移动到领域</h2></div><button aria-label="关闭" disabled={Boolean(sidebarProjectBusyId)} onClick={() => setSidebarProjectAreaTargetId(undefined)}><X size={18} /></button></header>
          <p>选择“{sidebarProjectAreaTarget.name}”所属的领域。</p>
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
          <footer><small>移动领域不会改变项目中的任务、笔记或日程。</small><div><button className="secondary-button" disabled={Boolean(sidebarProjectBusyId)} onClick={() => setSidebarProjectAreaTargetId(undefined)}>取消</button></div></footer>
        </section>
      </div>}
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
  taskCounts,
  onNavigate,
  onAreaContextMenu,
  onToggleArea,
  onProjectContextMenu,
}: {
  readonly collapsedAreas: ReadonlySet<string>;
  readonly groups: readonly SidebarProjectGroup[];
  readonly selectedProjectId?: string;
  readonly taskCounts?: ReadonlyMap<string, number>;
  readonly onNavigate: () => void;
  readonly onAreaContextMenu: (areaName: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
  readonly onToggleArea: (areaName: string) => void;
  readonly onProjectContextMenu: (projectId: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  return <div className="sidebar-project-groups">
    {groups.map((group) => {
      const collapsed = collapsedAreas.has(group.areaName);
      return <section className={`sidebar-project-group ${collapsed ? "collapsed" : ""}`} key={group.areaName}>
      <h3 onContextMenu={(event) => {
        event.preventDefault();
        onAreaContextMenu(group.areaName, event.clientX, event.clientY, event.currentTarget.querySelector("button"));
      }}><button type="button" aria-expanded={!collapsed} onClick={() => onToggleArea(group.areaName)}><ChevronRight size={11} />{group.areaName}</button><span>{group.projects.length}</span></h3>
      {!collapsed && <nav className="sidebar-project-list" aria-label={`${group.areaName}项目`}>
        {group.projects.map((project) => <SidebarProjectLink
          active={selectedProjectId === project.id}
          key={project.id}
          project={project}
          taskCount={taskCounts?.get(project.id) ?? 0}
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
  taskCount,
  onNavigate,
  onContextMenu,
}: {
  readonly active: boolean;
  readonly project: SidebarProjectSummary;
  readonly taskCount: number;
  readonly onNavigate: () => void;
  readonly onContextMenu: (projectId: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  return <Link
    className={active ? "active" : ""}
    href={`/projects?project=${encodeURIComponent(project.id)}`}
    onClick={onNavigate}
    onContextMenu={(event) => {
      event.preventDefault();
      onContextMenu(project.id, event.clientX, event.clientY, event.currentTarget);
    }}
  >
    <i style={{ background: project.color }} />
    <span><strong>{project.name}</strong></span>
    <em title={`${taskCount} 个未完成任务`}>{taskCount}</em>
  </Link>;
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
  initialTaskView,
  initialCreateTask,
  initialScheduleTaskId,
  initialEventId,
  initialCalendarDate,
  initialNoteId,
  initialProjectId,
}: {
  readonly section: WorkspaceSection;
  readonly initialMessageId?: string;
  readonly initialMailFolderId?: string;
  readonly initialTaskId?: string;
  readonly initialTaskView?: TaskView;
  readonly initialCreateTask?: boolean;
  readonly initialScheduleTaskId?: string;
  readonly initialEventId?: string;
  readonly initialCalendarDate?: string;
  readonly initialNoteId?: string;
  readonly initialProjectId?: string;
}) {
  switch (section) {
    case "today": return <TodayPage />;
    case "inbox": return <InboxPage initialMessageId={initialMessageId} initialFolderId={initialMailFolderId} />;
    case "calendar": return <CalendarPage initialEventId={initialEventId} initialCalendarDate={initialCalendarDate} />;
    case "tasks": return <TasksPage initialTaskId={initialTaskId} initialTaskView={initialTaskView} initialCreateTask={initialCreateTask} initialProjectId={initialProjectId} initialScheduleTaskId={initialScheduleTaskId} />;
    case "projects": return <ProjectsPage initialProjectId={initialProjectId} />;
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
      {feedback && <TransientToast message={feedback} onClose={() => setFeedback("")} />}
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

function AiPage() {
  return <AiCommand />;
}

function AssistantPanel({ title, section }: { readonly title: string; readonly section: WorkspaceSection }) {
  const suggestion: Record<WorkspaceSection, string> = {
    today: "客户在等待今天的回复；完成后，11:00–12:30 有一段适合准备方案的专注时间。",
    inbox: "这封邮件包含两个行动项：确认交付时间，以及发送新的演示链接。",
    calendar: "周二上午有 90 分钟空档，可用于准备周三的项目演示。",
    tasks: "当前三个任务中，客户交付确认会阻塞后续工作，建议优先处理。",
    projects: "项目主页汇总目标、任务、笔记和时间安排；AI 项目建议会在受控写入阶段开放。",
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
