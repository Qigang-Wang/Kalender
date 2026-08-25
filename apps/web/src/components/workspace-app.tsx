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
  BellRing,
  FileText,
  Folder,
  GripVertical,
  FolderPlus,
  HardDrive,
  Inbox,
  ImageIcon,
  Keyboard,
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
import { DesktopReminderBridge } from "./desktop-reminder-bridge";
import { DesktopReminderSettingsPanel } from "./desktop-reminder-settings";
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
import { isDesktopApp, waitForDesktopApp } from "@/lib/desktop-bridge";
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
  type SidebarCommandId,
  type TaskCommandId,
} from "./context-commands";

const TodayPage = dynamic(
  () => import("./pages/today-page").then((module) => module.TodayPage),
  {
    loading: () => <EditorLoading label="Heute laden..." />,
    ssr: false,
  },
);

const InboxPage = dynamic(
  () => import("./pages/inbox-page").then((module) => module.InboxPage),
  {
    loading: () => <EditorLoading label="E-Mail wird geladen..." />,
    ssr: false,
  },
);

const CalendarPage = dynamic(
  () => import("./pages/calendar-page").then((module) => module.CalendarPage),
  {
    loading: () => <EditorLoading label="Kalender wird geladen..." />,
    ssr: false,
  },
);

const TasksPage = dynamic(
  () => import("./pages/tasks-page").then((module) => module.TasksPage),
  {
    loading: () => <EditorLoading label="Aufgaben werden geladen..." />,
    ssr: false,
  },
);

const ProjectsPage = dynamic(
  () => import("./pages/projects-page").then((module) => module.ProjectsPage),
  {
    loading: () => <EditorLoading label="Projekte werden geladen..." />,
    ssr: false,
  },
);

const NotesPage = dynamic(
  () => import("./pages/notes-page").then((module) => module.NotesPage),
  {
    loading: () => <EditorLoading label="Notizen werden geladen..." />,
    ssr: false,
  },
);

const AiCommand = dynamic(
  () => import("./ai-command").then((module) => module.AiCommand),
  {
    loading: () => <EditorLoading label="KI-Arbeitsplätze werden geladen..." />,
    ssr: false,
  },
);

const AiProviderSettings = dynamic(
  () => import("./ai-provider-settings").then((module) => module.AiProviderSettings),
  {
    loading: () => <EditorLoading label="AI-Einstellungen werden geladen..." />,
    ssr: false,
  },
);

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

export const sections = ["today", "inbox", "calendar", "tasks", "notes", "projects", "ai", "settings"] as const;
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
  readonly sortOrder: number;
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

type SidebarSectionId = "inbox-accounts" | "calendar-sources" | "tasks-groups" | "notes-projects";
type SidebarProjectDropZone = "before" | "after";

interface SidebarProjectDropTarget {
  readonly areaName?: string;
  readonly projectId?: string;
  readonly zone?: SidebarProjectDropZone;
}

interface SidebarSectionMenuState {
  readonly sectionId: SidebarSectionId;
  readonly title: string;
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
  { section: "notes", label: "Notes", icon: NotebookPen },
  { section: "projects", label: "Projects", icon: Folder },
  { section: "ai", label: "AI Command", icon: WandSparkles },
];

type SettingsTab = "appearance" | "profile" | "users" | "diagnostics" | "jobs" | "operations" | "sync" | "desktop" | "mail" | "calendar" | "shortcuts" | "ai" | "backup";

const settingsNavigation: ReadonlyArray<{
  tab: SettingsTab;
  label: string;
  icon: typeof Inbox;
  adminOnly?: boolean;
}> = [
  { tab: "appearance", label: "Erscheinungsbild", icon: Palette },
  { tab: "profile", label: "Konten", icon: UserRound },
  { tab: "users", label: "Benutzerverwaltung", icon: Users, adminOnly: true },
  { tab: "diagnostics", label: "Datendiagnose", icon: ShieldCheck, adminOnly: true },
  { tab: "jobs", label: "Hintergrundaufgaben", icon: Clock3 },
  { tab: "operations", label: "Systemstatus", icon: HardDrive, adminOnly: true },
  { tab: "sync", label: "Synchronisierung", icon: RefreshCw },
  { tab: "desktop", label: "Desktop-App", icon: BellRing },
  { tab: "mail", label: "E-Mail-Konten", icon: Mail },
  { tab: "calendar", label: "Kalenderkonten", icon: CalendarDays },
  { tab: "shortcuts", label: "Tastenkürzel", icon: Keyboard },
  { tab: "ai", label: "AI-Einstellungen", icon: WandSparkles },
  { tab: "backup", label: "Datensicherung", icon: DatabaseBackup },
];

function visibleSettingsNavigation(role: AppRole, desktopAvailable: boolean) {
  return settingsNavigation.filter((item) => (
    (!item.adminOnly || role === "admin") && (item.tab !== "desktop" || desktopAvailable)
  ));
}

function normalizeSettingsTab(value: string | null | undefined, role: AppRole, desktopAvailable: boolean): SettingsTab {
  const visibleTabs = new Set(visibleSettingsNavigation(role, desktopAvailable).map((item) => item.tab));
  return visibleTabs.has(value as SettingsTab) ? value as SettingsTab : "appearance";
}

const pageAssistantTitles: Record<WorkspaceSection, string> = {
  today: "Tagesübersicht",
  inbox: "E-Mail-Assistent",
  calendar: "Terminvorschläge",
  tasks: "Aufgabenvorschläge",
  projects: "Projektvorschläge",
  notes: "Notiz-Assistent",
  ai: "Sicherheitsgrenzen",
  settings: "Verbindungssicherheit",
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
const UI_PREF_COLLAPSED_PROJECT_AREAS_KEY = "sidebar.collapsedProjectAreas";
const UI_PREF_EXPANDED_MAIL_ACCOUNTS_KEY = "sidebar.expandedMailAccounts";
const UI_PREF_COLLAPSED_SECTIONS_KEY = "sidebar.collapsedSections";
const UI_PREF_STORAGE_PREFIX = "kalender:ui-pref:";
const sidebarSectionIds = new Set<SidebarSectionId>(["inbox-accounts", "calendar-sources", "tasks-groups", "notes-projects"]);
const PROJECT_DRAG_TYPE = "application/x-kalender-project";
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

function readStoredStringSet(key: string): { readonly found: boolean; readonly values: ReadonlySet<string> } {
  try {
    const raw = window.localStorage.getItem(`${UI_PREF_STORAGE_PREFIX}${key}`);
    if (!raw) return { found: false, values: new Set() };
    const parsed = JSON.parse(raw) as unknown;
    return { found: true, values: new Set(stringArrayFromPreference(parsed)) };
  } catch {
    return { found: false, values: new Set() };
  }
}

function writeStoredStringSet(key: string, values: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(`${UI_PREF_STORAGE_PREFIX}${key}`, JSON.stringify([...values]));
  } catch {
    // UI state remains available for the current session.
  }
}

function stringArrayFromPreference(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (value && typeof value === "object" && Array.isArray((value as { readonly ids?: unknown }).ids)) {
    return (value as { readonly ids: readonly unknown[] }).ids.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function replaceStringSetIfChanged<T extends string = string>(values: ReadonlySet<T>) {
  return (current: ReadonlySet<T>) => sameStringSet(current, values) ? current : new Set(values);
}

async function fetchUserPreferences(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
  const query = keys.map((key) => `key=${encodeURIComponent(key)}`).join("&");
  const response = await workspaceFetch(`/api/user-preferences?${query}`, {}, 0);
  const payload = await response.json() as {
    readonly ok?: boolean;
    readonly preferences?: Readonly<Record<string, unknown>>;
  };
  if (!response.ok || !payload.ok) throw new Error("Benutzeroberflächeneinstellungen können nicht gelesen werden");
  return payload.preferences ?? {};
}

async function putUserPreference(key: string, ids: readonly string[]): Promise<void> {
  await fetch("/api/user-preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value: { ids } }),
  });
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
        <DesktopReminderBridge />
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
  const [sidebarSectionMenu, setSidebarSectionMenu] = useState<SidebarSectionMenuState>();
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<ReadonlySet<SidebarSectionId>>(() => new Set());
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
  const [draggedSidebarProjectId, setDraggedSidebarProjectId] = useState<string>();
  const [projectDropTarget, setProjectDropTarget] = useState<SidebarProjectDropTarget>();
  const [uiPreferencesLoaded, setUiPreferencesLoaded] = useState(false);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const uiPreferenceSaveTimersRef = useRef(new Map<string, number>());
  const mailAccountPreferenceFoundRef = useRef(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const activeSettingsTab = normalizeSettingsTab(searchParams.get("tab"), currentUser.role, desktopAvailable);
  const visibleSettingItems = visibleSettingsNavigation(currentUser.role, desktopAvailable);
  const sidebarUnreadCount = sidebarMailAccounts?.reduce((total, account) => total + account.unreadCount, 0)
    ?? sidebarMailUnreadCount;
  const userInitial = userInitialFor(currentUser.displayName, currentUser.email);
  const assistantAvailable = section === "inbox" || section === "calendar" || section === "tasks";

  useEffect(() => {
    if (isDesktopApp()) {
      setDesktopAvailable(true);
      return;
    }
    let disposed = false;
    void waitForDesktopApp().then((available) => {
      if (!disposed && available) setDesktopAvailable(true);
    });
    return () => { disposed = true; };
  }, []);

  const applyUiPreferences = useCallback((preferences: Readonly<Record<string, unknown>>) => {
    const projectAreas = new Set(stringArrayFromPreference(preferences[UI_PREF_COLLAPSED_PROJECT_AREAS_KEY]));
    const mailAccounts = new Set(stringArrayFromPreference(preferences[UI_PREF_EXPANDED_MAIL_ACCOUNTS_KEY]));
    const collapsedSections = new Set(
      stringArrayFromPreference(preferences[UI_PREF_COLLAPSED_SECTIONS_KEY])
        .filter((id): id is SidebarSectionId => sidebarSectionIds.has(id as SidebarSectionId)),
    );
    if (UI_PREF_COLLAPSED_PROJECT_AREAS_KEY in preferences) {
      setCollapsedProjectAreas(replaceStringSetIfChanged(projectAreas));
    }
    if (UI_PREF_EXPANDED_MAIL_ACCOUNTS_KEY in preferences) {
      mailAccountPreferenceFoundRef.current = true;
      setExpandedMailAccounts(replaceStringSetIfChanged(mailAccounts));
    }
    if (UI_PREF_COLLAPSED_SECTIONS_KEY in preferences) {
      setCollapsedSidebarSections(replaceStringSetIfChanged(collapsedSections));
    }
  }, []);

  const refreshUiPreferences = useCallback(async () => {
    const preferences = await fetchUserPreferences([
      UI_PREF_COLLAPSED_PROJECT_AREAS_KEY,
      UI_PREF_EXPANDED_MAIL_ACCOUNTS_KEY,
      UI_PREF_COLLAPSED_SECTIONS_KEY,
    ]);
    applyUiPreferences(preferences);
  }, [applyUiPreferences]);

  const saveUiPreferenceSet = useCallback((key: string, values: ReadonlySet<string>) => {
    writeStoredStringSet(key, values);
    if (!uiPreferencesLoaded) return;
    const timers = uiPreferenceSaveTimersRef.current;
    const existing = timers.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    const snapshot = [...values];
    timers.set(key, window.setTimeout(() => {
      timers.delete(key);
      void putUserPreference(key, snapshot).catch(() => undefined);
    }, 180));
  }, [uiPreferencesLoaded]);

  useEffect(() => {
    const storedProjectAreas = readStoredStringSet(UI_PREF_COLLAPSED_PROJECT_AREAS_KEY);
    const storedMailAccounts = readStoredStringSet(UI_PREF_EXPANDED_MAIL_ACCOUNTS_KEY);
    const storedCollapsedSections = readStoredStringSet(UI_PREF_COLLAPSED_SECTIONS_KEY);
    if (storedProjectAreas.found) setCollapsedProjectAreas(new Set(storedProjectAreas.values));
    if (storedMailAccounts.found) {
      mailAccountPreferenceFoundRef.current = true;
      setExpandedMailAccounts(new Set(storedMailAccounts.values));
    }
    if (storedCollapsedSections.found) {
      setCollapsedSidebarSections(new Set(
        [...storedCollapsedSections.values].filter((id): id is SidebarSectionId => sidebarSectionIds.has(id as SidebarSectionId)),
      ));
    }
    let cancelled = false;
    void refreshUiPreferences()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setUiPreferencesLoaded(true);
      });
    return () => {
      cancelled = true;
      for (const timer of uiPreferenceSaveTimersRef.current.values()) window.clearTimeout(timer);
      uiPreferenceSaveTimersRef.current.clear();
    };
  }, [refreshUiPreferences]);

  useEffect(() => {
    saveUiPreferenceSet(UI_PREF_COLLAPSED_PROJECT_AREAS_KEY, collapsedProjectAreas);
  }, [collapsedProjectAreas, saveUiPreferenceSet]);

  useEffect(() => {
    saveUiPreferenceSet(UI_PREF_EXPANDED_MAIL_ACCOUNTS_KEY, expandedMailAccounts);
  }, [expandedMailAccounts, saveUiPreferenceSet]);

  useEffect(() => {
    saveUiPreferenceSet(UI_PREF_COLLAPSED_SECTIONS_KEY, collapsedSidebarSections);
  }, [collapsedSidebarSections, saveUiPreferenceSet]);

  useRealtimeEvent(["settings"], (event) => {
    if (event.entityType === "user_preferences") void refreshUiPreferences().catch(() => undefined);
  });

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
    setExpandedMailAccounts((current) => mailAccountPreferenceFoundRef.current || current.size ? current : new Set(accounts.map((account) => account.id)));
  }, []);

  const syncSidebarMailAccount = async (account: SidebarMailAccount) => {
    if (sidebarMailSyncBusyId || account.syncStatus === "syncing" || account.syncStatus === "paused") return;
    setSidebarMailSyncBusyId(account.id);
    setSidebarMailNotice(`„${account.displayName}“ wird synchronisiert …`);
    try {
      const response = await fetch(`/api/mail-accounts/${encodeURIComponent(account.id)}/sync`, { method: "POST" });
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly message?: string;
        readonly sync?: { readonly messagesProcessed?: number; readonly messagesRemoved?: number };
      };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Synchronisierung von Postfächern fehlgeschlagen");
      await refreshSidebarMail();
      window.dispatchEvent(new Event(MAIL_SYNCED_EVENT));
      const changedCount = (payload.sync?.messagesProcessed ?? 0) + (payload.sync?.messagesRemoved ?? 0);
      setSidebarMailNotice(
        changedCount > 0
          ? `„${account.displayName}“ synchronisiert: ${changedCount} E-Mail(s) aktualisiert`
          : `„${account.displayName}“ synchronisiert: keine neuen Änderungen`,
      );
    } catch (error) {
      setSidebarMailNotice(error instanceof Error ? error.message : "Synchronisierung von Postfächern fehlgeschlagen");
    } finally {
      setSidebarMailSyncBusyId(undefined);
    }
  };

  const refreshSidebarMailSummary = useCallback(async () => {
    const response = await workspaceFetch("/api/mail-summary", {}, 0);
    const payload = await response.json() as { readonly ok?: boolean; readonly unreadCount?: number };
    if (!response.ok || !payload.ok) throw new Error("Anzahl ungelesener E-Mails konnte nicht gelesen werden");
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
    if (!response.ok || !payload.ok) throw new Error("Kalenderquelle konnte nicht gelesen werden");
    setSidebarCalendars(payload.calendars ?? []);
  }, []);

  const refreshSidebarCalendar = async (calendar: SidebarCalendarSource) => {
    if (sidebarCalendarSyncBusyId) return;
    setSidebarCalendarMenu(undefined);
    setSidebarCalendarSyncBusyId(calendar.id);
    setSidebarCalendarNotice(`„${calendar.name}“ wird aktualisiert …`);
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
        if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Kalenderaktualisierung fehlgeschlagen");
        eventsProcessed = payload.sync?.eventsProcessed;
        mailSynced = Boolean(payload.mailSync);
      }
      await refreshSidebarCalendars();
      window.dispatchEvent(new Event(CALENDAR_SYNCED_EVENT));
      if (mailSynced) window.dispatchEvent(new Event(MAIL_SYNCED_EVENT));
      setSidebarCalendarNotice(
        eventsProcessed === undefined
          ? `„${calendar.name}“ wurde aktualisiert`
          : `„${calendar.name}“ wurde aktualisiert: ${eventsProcessed} Termin(e) verarbeitet`,
      );
    } catch (error) {
      setSidebarCalendarNotice(error instanceof Error ? error.message : "Kalenderaktualisierung fehlgeschlagen");
    } finally {
      setSidebarCalendarSyncBusyId(undefined);
    }
  };

  const refreshSidebarTasks = useCallback(async () => {
    const response = await workspaceFetch("/api/tasks?includeCompleted=true");
    const payload = await response.json() as { readonly ok?: boolean; readonly tasks?: readonly SidebarTaskSummary[] };
    if (!response.ok || !payload.ok) throw new Error("Aufgaben konnten nicht geladen werden");
    setSidebarTasks(payload.tasks ?? []);
  }, []);

  const refreshSidebarProjects = useCallback(async () => {
    const [projectsResponse, tasksResponse] = await Promise.all([
      workspaceFetch("/api/projects?includeArchived=true"),
      workspaceFetch("/api/tasks?includeCompleted=true"),
    ]);
    const projectsPayload = await projectsResponse.json() as { readonly ok?: boolean; readonly projects?: readonly SidebarProjectSummary[] };
    const tasksPayload = await tasksResponse.json() as { readonly ok?: boolean; readonly tasks?: readonly SidebarTaskSummary[] };
    if (!projectsResponse.ok || !projectsPayload.ok || !tasksResponse.ok || !tasksPayload.ok) throw new Error("Die Liste der Projekte kann nicht gelesen werden");
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
    if (!response.ok || !payload.ok || !payload.task) throw new Error("Aufgaben können nicht schrittweise aktualisiert werden");
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
    if (section !== "projects" && section !== "notes" && section !== "tasks") return;
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
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Projekt kann nicht aktualisiert werden");
      await refreshSidebarProjects();
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setSidebarProjectNotice(successMessage);
    } catch (error) {
      setSidebarProjectNotice(error instanceof Error ? error.message : "Projekt kann nicht aktualisiert werden");
    } finally {
      setSidebarProjectBusyId(undefined);
    }
  };

  const toggleSidebarSection = (sectionId: SidebarSectionId) => {
    setCollapsedSidebarSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) next.delete(sectionId); else next.add(sectionId);
      return next;
    });
  };

  const toggleCollapsedProjectArea = (areaName: string) => {
    setCollapsedProjectAreas((current) => {
      const next = new Set(current);
      if (next.has(areaName)) next.delete(areaName); else next.add(areaName);
      return next;
    });
  };

  const reorderSidebarProject = async (
    projectId: string,
    areaName: string,
    targetProjectId?: string,
    zone: SidebarProjectDropZone = "after",
  ) => {
    const project = sidebarProjects?.find((entry) => entry.id === projectId);
    if (!project || sidebarProjectBusyId) return;
    const currentArea = project.areaName?.trim() || "Nicht kategorisiert";
    const targetProject = targetProjectId ? sidebarProjects?.find((entry) => entry.id === targetProjectId) : undefined;
    if (targetProject && targetProject.status !== project.status) {
      setSidebarProjectNotice("kann nur im gleichen Projektzustand sortiert werden");
      return;
    }

    const currentAreaProjectIds = (sidebarProjects ?? [])
      .filter((entry) => entry.status === project.status && (entry.areaName?.trim() || "Nicht kategorisiert") === currentArea)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "de-DE"))
      .map((entry) => entry.id);
    const destinationProjects = (sidebarProjects ?? [])
      .filter((entry) => entry.status === project.status && (entry.areaName?.trim() || "Nicht kategorisiert") === areaName && entry.id !== projectId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "de-DE"));
    const insertIndex = targetProject
      ? Math.max(0, destinationProjects.findIndex((entry) => entry.id === targetProject.id) + (zone === "after" ? 1 : 0))
      : destinationProjects.length;
    const nextAreaProjects = [
      ...destinationProjects.slice(0, insertIndex),
      { ...project, areaName: areaName === "Nicht kategorisiert" ? undefined : areaName },
      ...destinationProjects.slice(insertIndex),
    ];
    const nextProjectIds = nextAreaProjects.map((entry) => entry.id);
    if (currentArea === areaName && nextProjectIds.length === currentAreaProjectIds.length && nextProjectIds.every((id, index) => id === currentAreaProjectIds[index])) return;

    setSidebarProjectBusyId(project.id);
    setSidebarProjects((current) => current?.map((entry) => {
      const nextIndex = nextProjectIds.indexOf(entry.id);
      if (entry.id === project.id || nextIndex >= 0) {
        return {
          ...entry,
          areaName: entry.id === project.id ? (areaName === "Nicht kategorisiert" ? undefined : areaName) : entry.areaName,
          sortOrder: nextIndex >= 0 ? (nextIndex + 1) * 1000 : entry.sortOrder,
        };
      }
      return entry;
    }));
    try {
      if (currentArea !== areaName) {
        const moveResponse = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: project.name,
            description: project.description,
            areaName: areaName === "Nicht kategorisiert" ? "" : areaName,
            color: project.color,
            status: project.status,
          }),
        });
        const movePayload = await moveResponse.json() as { readonly ok?: boolean; readonly message?: string };
        if (!moveResponse.ok || !movePayload.ok) throw new Error(movePayload.message ?? "Projekte können nicht verschoben werden");
      }
      const reorderResponse = await fetch("/api/projects/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectIds: nextProjectIds }),
      });
      const reorderPayload = await reorderResponse.json() as { readonly ok?: boolean; readonly message?: string };
      if (!reorderResponse.ok || !reorderPayload.ok) throw new Error(reorderPayload.message ?? "kann die Reihenfolge der Projekte nicht speichern");
      await refreshSidebarProjects();
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setSidebarProjectNotice(currentArea === areaName ? "Projektreihenfolge aktualisiert" : `In den Bereich „${areaName}“ verschoben`);
      setCollapsedProjectAreas((current) => {
        if (!current.has(areaName)) return current;
        const next = new Set(current);
        next.delete(areaName);
        return next;
      });
    } catch (error) {
      await refreshSidebarProjects().catch(() => undefined);
      setSidebarProjectNotice(error instanceof Error ? error.message : "kann die Reihenfolge der Projekte nicht speichern");
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
          title: `${project.name} – Notiz`,
          content: "",
          noteType: "project",
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly note?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "Projekt-Notizen können nicht erstellt werden");
      window.location.assign(`/notes?note=${encodeURIComponent(payload.note.id)}`);
    } catch (error) {
      setSidebarProjectNotice(error instanceof Error ? error.message : "Projekt-Notizen können nicht erstellt werden");
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
          setSidebarProjectNotice("Projektlink kopiert");
        } catch {
          await appPrompt({
            title: "Projektlinks kopieren",
            description: "Der Browser darf nicht automatisch in die Zwischenablage schreiben. Bitte kopieren Sie die folgende Adresse manuell.",
            defaultValue: href,
            confirmLabel: "Schließen",
            selectOnFocus: true,
          });
        }
      } else {
        await appPrompt({
          title: "Projektlink kopieren",
          description: "Bitte kopieren Sie die untenstehende Adresse manuell.",
          defaultValue: href,
          confirmLabel: "Schließen",
          selectOnFocus: true,
        });
      }
    } else if (commandId === "project.archive") {
      if (await appConfirm({
        title: `Projekt „${project.name}“ archivieren?`,
        description: "Verknüpfte Inhalte bleiben erhalten und das Projekt kann später wiederhergestellt werden.",
        confirmLabel: "Projekt archivieren",
      })) {
        void updateSidebarProject(project, { status: "archived" }, `„${project.name}“ wurde archiviert`);
      }
    } else if (commandId === "project.restore") {
      void updateSidebarProject(project, { status: "active" }, `„${project.name}“ wurde wiederhergestellt`);
    }
  };

  const handleSidebarProjectAreaCommand = async (commandId: ProjectAreaCommandId) => {
    const areaName = sidebarProjectAreaMenu?.areaName;
    if (!areaName) return;
    if (commandId === "project-area.create-project") {
      window.dispatchEvent(new CustomEvent<{ readonly areaName?: string }>(OPEN_PROJECT_DIALOG_EVENT, {
        detail: { areaName: areaName === "Nicht kategorisiert" ? undefined : areaName },
      }));
      setSidebarOpen(false);
      return;
    }
    if (commandId === "project-area.rename") {
      if (areaName === "Nicht kategorisiert") return;
      const projectsInArea = sidebarProjects?.filter((project) => project.areaName === areaName).length ?? 0;
      const input = await appPrompt({
        title: "Bereich umbenennen",
        description: `Die ${projectsInArea} Projekte im Bereich „${areaName}“ verwenden anschließend den neuen Namen. Verknüpfte Aufgaben, Notizen und Termine bleiben unverändert.`,
        defaultValue: areaName,
        placeholder: "Neuen Bereichsnamen eingeben",
        confirmLabel: "Umbenennen",
        selectOnFocus: true,
      });
      if (input === null) return;
      const name = input.trim();
      if (!name || name.length > 100) {
        setSidebarProjectNotice("Der Bereichsname muss 1 bis 100 Zeichen lang sein");
        return;
      }
      if (name === "Nicht kategorisiert") {
        setSidebarProjectNotice("„Nicht kategorisiert“ ist eine Systemgruppe und kann nicht als Bereichsname verwendet werden");
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
        if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Feld kann nicht umbenennen");
        setCollapsedProjectAreas((current) => {
          if (!current.has(areaName)) return current;
          const next = new Set(current);
          next.delete(areaName);
          next.add(name);
          return next;
        });
        await refreshSidebarProjects();
        window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
        setSidebarProjectNotice(`Schon "${areaName}"Umbenennen in"${name}Aktualisierung ${payload.result?.projectsUpdated ?? projectsInArea} Projekt`);
      } catch (error) {
        setSidebarProjectNotice(error instanceof Error ? error.message : "Feld kann nicht umbenennen");
      } finally {
        setSidebarProjectBusyId(undefined);
      }
      return;
    }
    if (commandId === "project-area.toggle") {
      toggleCollapsedProjectArea(areaName);
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
          <button className="mobile-close" aria-label="Navigator Weniger anzeigen" onClick={() => setSidebarOpen(false)}><X /></button>
        </div>

        <nav className="primary-nav" aria-label="Hauptnavigation">
          {navigation.map(({ section: item, label, icon: Icon }) => (
            <Link className={item === section ? "active" : ""} href={`/${item}`} key={item} onClick={() => setSidebarOpen(false)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {item === "inbox" && sidebarUnreadCount > 0 && <em>{sidebarUnreadCount}</em>}
            </Link>
          ))}
        </nav>

        {section === "settings" && <div className="account-block sidebar-context-block settings-sidebar-block">
          <nav className="sidebar-settings-links" aria-label="Einstellungskategorien">
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
          <SidebarListHeading
            title="E-Mail-Konten"
            collapsed={collapsedSidebarSections.has("inbox-accounts")}
            onToggle={() => toggleSidebarSection("inbox-accounts")}
            onContextMenu={(x, y, returnFocus) => setSidebarSectionMenu({ sectionId: "inbox-accounts", title: "E-Mail-Konten", x, y, returnFocus })}
          />
          {!collapsedSidebarSections.has("inbox-accounts") && (sidebarMailAccounts === undefined ? <small>Konto lesen...</small> : sidebarMailAccounts.length ? <>
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
          </> : <Link className="sidebar-connect-mail" href="/settings"><Plus size={13} />Mailkonto verbinden</Link>)}
        </div>}

        {section === "calendar" && <div className="account-block sidebar-context-block">
          <SidebarListHeading
            title="Kalenderquellen"
            collapsed={collapsedSidebarSections.has("calendar-sources")}
            onToggle={() => toggleSidebarSection("calendar-sources")}
            onContextMenu={(x, y, returnFocus) => setSidebarSectionMenu({ sectionId: "calendar-sources", title: "Kalenderquellen", x, y, returnFocus })}
          />
          {!collapsedSidebarSections.has("calendar-sources") && (sidebarCalendars === undefined ? <small>Lesekalender...</small> : sidebarCalendars.length
            ? <div className="sidebar-calendar-list">{sidebarCalendars.map((calendar) => <div
              className="sidebar-calendar-source"
              key={calendar.id}
              role="button"
              tabIndex={0}
              aria-label={`${calendar.name} Kalenderbetrieb`}
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
              {calendar.primary && <em>Standard</em>}
            </div>)}</div>
            : <Link className="sidebar-connect-mail" href="/settings"><Plus size={13} />Kalender verbinden</Link>)}
        </div>}

        {section === "tasks" && <div className="account-block sidebar-context-block">
          <SidebarListHeading
            title="Aufgabenprojekte"
            collapsed={collapsedSidebarSections.has("tasks-groups")}
            onToggle={() => toggleSidebarSection("tasks-groups")}
            onContextMenu={(x, y, returnFocus) => setSidebarSectionMenu({ sectionId: "tasks-groups", title: "Aufgabenprojekte", x, y, returnFocus })}
          />
          {!collapsedSidebarSections.has("tasks-groups") && (sidebarProjects === undefined || sidebarTasks === undefined ? <small>Projekt lesen...</small> : activeSidebarProjects.length ? <>
            <nav className="sidebar-task-groups" aria-label="Übersicht der Aufgabenprojekte">
              <Link className={initialTaskView === "projects" && !initialProjectId ? "active" : ""} href="/tasks?view=projects" onClick={() => setSidebarOpen(false)}>
                <FolderPlus size={14} /><span>Alle Projekte</span><em>{Array.from(sidebarProjectTaskCounts?.values() ?? []).reduce((total, count) => total + count, 0)}</em>
              </Link>
            </nav>
            <SidebarProjectGroups
              collapsedAreas={collapsedProjectAreas}
              groups={activeSidebarProjectGroups}
              selectedProjectId={initialProjectId}
              counts={sidebarProjectTaskCounts}
              projectHref={(project) => `/tasks?view=projects&project=${encodeURIComponent(project.id)}`}
              onNavigate={() => setSidebarOpen(false)}
              onToggleArea={toggleCollapsedProjectArea}
            />
          </> : <Link className="sidebar-create-project" href="/projects" onClick={() => setSidebarOpen(false)}><Plus size={13} />Erstes Projekt erstellen</Link>)}
        </div>}

        {section === "projects" && <div className="account-block sidebar-context-block">
          <div className="sidebar-context-heading">
            <p className="eyebrow">Projekt</p>
            <button
              type="button"
              aria-label="Neues Projekt"
              title="Neues Projekt"
              onClick={() => {
                window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
                setSidebarOpen(false);
              }}
            ><Plus size={14} /></button>
          </div>
          {sidebarProjectNotice && <div className="sidebar-project-notice" role="status">{sidebarProjectNotice}</div>}
          {sidebarProjects === undefined ? <small>Projekt lesen...</small> : sidebarProjects.length ? <>
            <SidebarProjectGroups
              collapsedAreas={collapsedProjectAreas}
              groups={activeSidebarProjectGroups}
              draggedProjectId={draggedSidebarProjectId}
              dropTarget={projectDropTarget}
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
              onProjectDragStart={(projectId) => setDraggedSidebarProjectId(projectId)}
              onProjectDragEnd={() => {
                setDraggedSidebarProjectId(undefined);
                setProjectDropTarget(undefined);
              }}
              onProjectDragOver={(target) => setProjectDropTarget(target)}
              onProjectDrop={(projectId, target) => {
                setDraggedSidebarProjectId(undefined);
                setProjectDropTarget(undefined);
                void reorderSidebarProject(projectId, target.areaName ?? "Nicht kategorisiert", target.projectId, target.zone);
              }}
            />
            {archivedSidebarProjects.length > 0 && <details className="sidebar-archived-projects">
              <summary><Archive size={12} />Archiviert<span>{archivedSidebarProjects.length}</span></summary>
              <SidebarProjectGroups
                collapsedAreas={collapsedProjectAreas}
                groups={archivedSidebarProjectGroups}
                draggedProjectId={draggedSidebarProjectId}
                dropTarget={projectDropTarget}
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
                onProjectDragStart={(projectId) => setDraggedSidebarProjectId(projectId)}
                onProjectDragEnd={() => {
                  setDraggedSidebarProjectId(undefined);
                  setProjectDropTarget(undefined);
                }}
                onProjectDragOver={(target) => setProjectDropTarget(target)}
                onProjectDrop={(projectId, target) => {
                  setDraggedSidebarProjectId(undefined);
                  setProjectDropTarget(undefined);
                  void reorderSidebarProject(projectId, target.areaName ?? "Nicht kategorisiert", target.projectId, target.zone);
                }}
              />
            </details>}
          </> : <button className="sidebar-create-project" type="button" onClick={() => {
            window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
            setSidebarOpen(false);
          }}><Plus size={13} />Erstes Projekt erstellen</button>}
        </div>}

        {section === "notes" && <div className="account-block sidebar-context-block">
          <div className="sidebar-context-heading">
            <button
              type="button"
              className="sidebar-list-toggle"
              aria-expanded={!collapsedSidebarSections.has("notes-projects")}
              onClick={() => toggleSidebarSection("notes-projects")}
              onContextMenu={(event) => {
                event.preventDefault();
                setSidebarSectionMenu({ sectionId: "notes-projects", title: "Notizprojekte", x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
              }}
            ><ChevronRight size={12} /><span>Notizprojekte</span></button>
            <button
              type="button"
              aria-label="Neues Projekt"
              title="Neues Projekt"
              onClick={() => {
                window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
                setSidebarOpen(false);
              }}
            ><Plus size={14} /></button>
          </div>
          {!collapsedSidebarSections.has("notes-projects") && (sidebarProjects === undefined ? <small>Projekt lesen...</small> : activeSidebarProjects.length ? <SidebarProjectGroups
            collapsedAreas={collapsedProjectAreas}
            groups={activeSidebarProjectGroups}
            draggedProjectId={draggedSidebarProjectId}
            dropTarget={projectDropTarget}
            selectedProjectId={initialProjectId}
            counts={sidebarProjectNoteCounts}
            countLabel="Notizen"
            projectHref={(project) => `/notes?project=${encodeURIComponent(project.id)}`}
            onNavigate={() => setSidebarOpen(false)}
            onAreaContextMenu={(areaName, x, y, returnFocus) => {
              setSidebarProjectMenu(undefined);
              setSidebarProjectAreaMenu({ areaName, x, y, returnFocus });
            }}
            onToggleArea={toggleCollapsedProjectArea}
            onProjectContextMenu={(projectId, x, y, returnFocus) => {
              setSidebarProjectAreaMenu(undefined);
              setSidebarProjectMenu({ projectId, x, y, returnFocus });
            }}
            onProjectDragStart={(projectId) => setDraggedSidebarProjectId(projectId)}
            onProjectDragEnd={() => {
              setDraggedSidebarProjectId(undefined);
              setProjectDropTarget(undefined);
            }}
            onProjectDragOver={(target) => setProjectDropTarget(target)}
            onProjectDrop={(projectId, target) => {
              setDraggedSidebarProjectId(undefined);
              setProjectDropTarget(undefined);
              void reorderSidebarProject(projectId, target.areaName ?? "Nicht kategorisiert", target.projectId, target.zone);
            }}
          /> : <button className="sidebar-create-project" type="button" onClick={() => {
            window.dispatchEvent(new Event(OPEN_PROJECT_DIALOG_EVENT));
            setSidebarOpen(false);
          }}><Plus size={13} />Erstes Projekt erstellen</button>)}
        </div>}

        <div className="sidebar-user-area" ref={userMenuRef}>
          {userMenuOpen && (
            <div className="sidebar-user-menu" role="menu">
              <Link href="/settings" role="menuitem" onClick={() => { setUserMenuOpen(false); setSidebarOpen(false); }}>
                <Settings size={16} /><span><strong>Kontoeinstellungen</strong><small>E-Mail-, Kalender- und Dienstverbindungen</small></span>
              </Link>
              <button type="button" role="menuitem" onClick={() => void logout()}>
                <LogOut size={16} /><span><strong>Abmelden</strong><small>Beenden Sie die aktuelle Workstation-Sitzung</small></span>
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

      {sidebarOpen && <button className="sidebar-scrim" aria-label="Navigator Weniger anzeigen" onClick={() => setSidebarOpen(false)} />}

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
            <PageContent section={section} currentUser={currentUser} desktopAvailable={desktopAvailable} initialMessageId={initialMessageId} initialMailFolderId={initialMailFolderId} initialMailCorrespondent={initialMailCorrespondent} initialComposeTo={initialComposeTo} initialTaskId={initialTaskId} initialTaskView={initialTaskView} initialCreateTask={initialCreateTask} initialScheduleTaskId={initialScheduleTaskId} initialEventId={initialEventId} initialCalendarDate={initialCalendarDate} initialNoteId={initialNoteId} initialNoteFilter={initialNoteFilter} initialProjectId={initialProjectId} onOpenAssistant={() => setAssistantOpen(true)} />
          </main>
          {assistantAvailable && assistantOpen && <>
            <button className="assistant-scrim" type="button" aria-label="Kontextassistent Weniger anzeigen" onClick={() => setAssistantOpen(false)} />
            <ContextAssistantResizeHandle width={assistantWidth} onChange={setAssistantWidth} />
            <AssistantPanel title={pageAssistantTitles[section]} section={section} onClose={() => setAssistantOpen(false)} />
          </>}
        </div>
      </section>
      <MobileBottomNav section={section} unreadCount={sidebarUnreadCount} />
      {sidebarSectionMenu && <ContextMenu
        anchor={{ x: sidebarSectionMenu.x, y: sidebarSectionMenu.y }}
        ariaLabel={`${sidebarSectionMenu.title}Listenaktionen`}
        commands={[{
          id: "sidebar.toggle-section",
          label: collapsedSidebarSections.has(sidebarSectionMenu.sectionId) ? "Liste erweitern" : "Liste des Zusammenbruchs",
          group: "organize",
          risk: "read",
          icon: collapsedSidebarSections.has(sidebarSectionMenu.sectionId) ? "eye" : "eye-off",
        }]}
        heading={sidebarSectionMenu.title}
        returnFocus={sidebarSectionMenu.returnFocus}
        testId="sidebar-section-context-menu"
        onClose={() => setSidebarSectionMenu(undefined)}
        onSelect={(commandId) => {
          if ((commandId as SidebarCommandId) === "sidebar.toggle-section") toggleSidebarSection(sidebarSectionMenu.sectionId);
        }}
      />}
      {sidebarMailAccountMenu && sidebarMailAccounts?.find((account) => account.id === sidebarMailAccountMenu.accountId) && (() => {
        const account = sidebarMailAccounts.find((item) => item.id === sidebarMailAccountMenu.accountId)!;
        const busy = sidebarMailSyncBusyId === account.id || account.syncStatus === "syncing";
        return <ContextMenu
          anchor={{ x: sidebarMailAccountMenu.x, y: sidebarMailAccountMenu.y }}
          ariaLabel={`Mailbox-Kontobetrieb:${account.displayName}`}
          commands={[{
            id: "mail-account.sync",
            label: busy ? "Wird synchronisiert…" : "Jetzt synchronisieren",
            group: "primary",
            risk: "external-write",
            icon: "refresh",
            disabledReason: account.syncStatus === "paused" ? "Konto angehalten" : busy ? "Synchronisierung im Gange" : undefined,
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
          ariaLabel={`Kalender-Operation:${calendar.name}`}
          commands={[{
            id: "calendar-account.sync",
            label: busy ? "Wird aktualisiert …" : "Jetzt aktualisieren",
            group: "primary",
            risk: calendar.providerData?.accountId ? "external-write" : "read",
            icon: "refresh",
            disabledReason: busy ? "Aktualisierung läuft" : undefined,
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
        ariaLabel={`Projektbetrieb:${sidebarProjectMenuTarget.name}`}
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
        ariaLabel={`Aktionen für Bereich: ${sidebarProjectAreaMenu.areaName}`}
        commands={[
          { id: "project-area.create-project", label: "Neues Projekt in diesem Bereich", group: "primary", risk: "local-write", icon: "folder" },
          { id: "project-area.rename", label: "Bereich umbenennen", group: "primary", risk: "local-write", icon: "edit", disabledReason: sidebarProjectAreaMenu.areaName === "Nicht kategorisiert" ? "Systemgruppen können nicht umbenannt werden" : sidebarProjectBusyId ? "Aktion läuft" : undefined },
          { id: "project-area.toggle", label: collapsedProjectAreas.has(sidebarProjectAreaMenu.areaName) ? "Bereich aufklappen" : "Bereich zuklappen", group: "organize", risk: "read", icon: collapsedProjectAreas.has(sidebarProjectAreaMenu.areaName) ? "eye" : "eye-off" },
          { id: "project-area.collapse-others", label: "Andere Bereiche zuklappen", group: "organize", risk: "read", icon: "archive" },
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
          <header><div><h2 id="project-area-dialog-title">In Bereich verschieben</h2></div><button aria-label="Schließen" disabled={Boolean(sidebarProjectBusyId)} onClick={() => setSidebarProjectAreaTargetId(undefined)}><X size={18} /></button></header>
          <p>Projekt „{sidebarProjectAreaTarget.name}“ verschieben nach:</p>
          <div className="project-area-options">
            {Array.from(new Set([...allSidebarProjectAreas, "Nicht kategorisiert"])).map((areaName) => {
              const currentAreaName = sidebarProjectAreaTarget.areaName?.trim() || "Nicht kategorisiert";
              const current = areaName === currentAreaName;
              return <button key={areaName} type="button" className={current ? "active" : ""} disabled={current || Boolean(sidebarProjectBusyId)} onClick={() => {
                setSidebarProjectAreaTargetId(undefined);
                void reorderSidebarProject(sidebarProjectAreaTarget.id, areaName);
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
      aria-label="Passen Sie die Navigationsbreite links an"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="Ziehen, um die Breite anzupassen; Doppelklicken, um die Standardeinstellung wiederherzustellen"
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
      aria-label="Passen Sie die Breite der Mail an die des Assistenten an"
      aria-orientation="vertical"
      aria-valuemin={MIN_CONTEXT_ASSISTANT_WIDTH}
      aria-valuemax={MAX_CONTEXT_ASSISTANT_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="Ziehen, um die Breite anzupassen; Doppelklicken, um die Standardeinstellung wiederherzustellen"
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
    setFolderNotice("Ordner wird mit dem Mailserver synchronisiert …");
    try {
      const response = await fetch(url, init);
      const payload = await response.json() as { readonly message?: string; readonly result?: { readonly refreshed?: boolean } };
      if (!response.ok) throw new Error(payload.message || "Ordner-Operation fehlgeschlagen");
      await onRefresh();
      setFolderNotice(payload.result?.refreshed === false ? `${successMessage}; die Änderung wurde auf dem Server gespeichert und wird später synchronisiert` : successMessage);
    } catch (error) {
      setFolderNotice(error instanceof Error ? error.message : "Ordner-Operation fehlgeschlagen");
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
        title: commandId === "mail-folder.create-child" ? "Neuen Unterordner erstellen" : "Neuen Ordner auf dieser Ebene erstellen",
        description: commandId === "mail-folder.create-child" ? `Übergeordneter Ordner: „${mailFolderLabel(folder)}“` : undefined,
        placeholder: "Ordnernamen eingeben",
        confirmLabel: "Erstellen",
      });
      if (!name?.trim()) return;
      const parentFolderId = commandId === "mail-folder.create-child" ? folder.id : folder.parentId;
      void runFolderRequest(folder.id, "/api/mail-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, parentFolderId, name }),
      }, `Ordner „${name.trim()}“ erstellt`);
      return;
    }
    if (commandId === "mail-folder.rename") {
      const name = await appPrompt({
        title: "Ordner umbenennen",
        defaultValue: folder.name,
        placeholder: "Ordnernamen eingeben",
        confirmLabel: "Umbenennen",
        selectOnFocus: true,
      });
      if (!name?.trim() || name.trim() === folder.name) return;
      void runFolderRequest(folder.id, `/api/mail-folders/${encodeURIComponent(folder.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", name }),
      }, `Ordner in „${name.trim()}“ umbenannt`);
      return;
    }
    if (commandId === "mail-folder.move-root") {
      setFolderConfirmation({
        kind: "move-root",
        sourceId: folder.id,
        title: "Ordner auf die oberste Ebene verschieben?",
        description: `„${folder.name}“ gehört danach nicht mehr zum aktuellen übergeordneten Ordner.`,
        detail: "E-Mails und Unterordner bleiben unverändert.",
        confirmLabel: "Verschieben",
      });
      return;
    }
    if (commandId === "mail-folder.delete") {
      const descendants = countFolderDescendants(folder.id, children);
      const detail = `${folder.totalCount ?? 0} E-Mail(s)${descendants ? `, ${descendants} Unterordner` : ""}`;
      setFolderConfirmation({
        kind: "delete",
        sourceId: folder.id,
        title: "Diesen Ordner löschen?",
        description: `„${folder.name}“ wird in „Gelöschte Elemente“ verschoben.`,
        detail: `Enthält ${detail} und kann in Outlook wiederhergestellt werden.`,
        confirmLabel: "In Gelöschte Elemente verschieben",
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
      setFolderNotice("Zielordner hat sich geändert, bitte neu starten");
      return;
    }
    if (confirmation.kind === "delete") {
      await runFolderRequest(source.id, `/api/mail-folders/${encodeURIComponent(source.id)}`, { method: "DELETE" }, `„${source.name}“ wurde in „Gelöschte Elemente“ verschoben`);
      return;
    }
    await runFolderRequest(source.id, `/api/mail-folders/${encodeURIComponent(source.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(confirmation.kind === "move-root" ? { action: "move" } : { action: "move", parentFolderId: target?.id }),
    }, confirmation.kind === "move-root" ? `„${source.name}“ wurde auf die oberste Ebene verschoben` : `„${source.name}“ wurde nach „${target?.name ?? "Zielordner"}“ verschoben`);
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
        setFolderNotice("Das Sortieren nach oben und unten wird nur für Benutzerdefiniert Ordner auf der gleichen Ebene verwendet; ziehen Sie in die Mitte des Namens, um zu einem Unterordner zu bewegen");
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
      }, "Ordner-Ordner-Ordner-Ordner gespeichert");
      return;
    }
    setFolderConfirmation({
      kind: "move-child",
      sourceId: source.id,
      targetId: target.id,
      title: "Ordner verschieben?",
      description: `set "${source.name}"Zu bewegen"${target.name}". (Das Parlament nimmt den Entwurf der legislativen Entschließung an.)`,
      detail: "Diese Operation synchronisiert die Ordnerebene in RWTH/ Outlook.",
      confirmLabel: "Bestätigung zum Verschieben",
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
      setFolderNotice("Die gezogene E-Mail konnte nicht erkannt werden");
      return;
    }
    if (!dragged?.messageId || !dragged.accountId || !dragged.subject) return;
    if (dragged.accountId !== accountId) {
      setFolderNotice("E-Mails können nur in Ordner desselben Mailkontos verschoben werden");
      return;
    }
    setFolderBusyId(target.id);
    setFolderNotice(`„${dragged.subject}“ wird nach „${mailFolderLabel(target)}“ verschoben …`);
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
      if (!response.ok || !payload.result) throw new Error(payload.message || "E-Mail konnte nicht verschoben werden");
      await onRefresh();
      const movedCount = Math.max(1, payload.result.movedCount ?? 1);
      const destinationName = mailFolderLabel(target);
      setFolderNotice(movedCount > 1
        ? `${movedCount} E-Mails wurden nach „${destinationName}“ verschoben`
        : `E-Mail wurde nach „${destinationName}“ verschoben`);
      window.dispatchEvent(new CustomEvent<MailMessageMovedDetail>(MAIL_MESSAGE_MOVED_EVENT, {
        detail: {
          ...dragged,
          destinationFolderId: target.id,
          destinationName,
          movedCount,
        },
      }));
    } catch (error) {
      setFolderNotice(error instanceof Error ? error.message : "E-Mail konnte nicht verschoben werden");
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
            aria-label={`${expanded ? "Einklappen" : "Erweitern"}${mailFolderLabel(folder)}`}
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
            title="Ordner zum Sortieren oder Verschieben ziehen"
          ><GripVertical size={13} /></span>}
        </div>
        {hasChildren && expanded && renderLevel(folder.id, depth + 1, new Set([...visited, folder.id]))}
      </div>;
    });
  const contextFolder = accountFolders.find((folder) => folder.id === folderMenu?.folderId);
  const contextMutable = contextFolder ? isMutableMailFolder(contextFolder) : false;
  const contextCommands: readonly ResolvedContextCommand[] = contextFolder ? [
    { id: "mail-folder.create-child", label: "Neuen Unterordner erstellen", group: "primary", risk: "external-write", icon: "note" },
    { id: "mail-folder.create-sibling", label: "Neuen Ordner auf dieser Ebene erstellen", group: "primary", risk: "external-write", icon: "copy" },
    ...(contextMutable ? [
      { id: "mail-folder.rename", label: "Umbenennen", group: "organize", risk: "external-write", icon: "edit" },
      ...(contextFolder.parentId ? [{ id: "mail-folder.move-root", label: "Auf die oberste Postfachebene verschieben", group: "organize", risk: "external-write", icon: "archive" } as const] : []),
      { id: "mail-folder.delete", label: "Ordner löschen", group: "danger", risk: "destructive", icon: "trash" },
    ] as const : []),
  ] : [];
  return <div className="mail-folder-tree">
    {folderNotice && <div className="mail-folder-notice">{folderNotice}</div>}
    {renderLevel(undefined, 0, new Set())}
    {folderMenu && contextFolder && <ContextMenu
      anchor={{ x: folderMenu.x, y: folderMenu.y }}
      ariaLabel={`Ordner-Operation:${contextFolder.name}`}
      heading={contextFolder.name}
      commands={contextCommands}
      onClose={() => setFolderMenu(undefined)}
      onSelect={(commandId) => handleFolderCommand(commandId as MailFolderCommandId)}
    />}
    {folderConfirmation && <div className="app-confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !folderBusyId) setFolderConfirmation(undefined); }}>
      <section className={`app-confirmation ${folderConfirmation.danger ? "danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="mail-folder-confirmation-title" aria-describedby="mail-folder-confirmation-description">
        <header>
          <span className="app-confirmation-icon">{folderConfirmation.danger ? <Trash2 size={18} /> : <Folder size={18} />}</span>
          <div><small>Mit dem Mailserver synchronisieren</small><h2 id="mail-folder-confirmation-title">{folderConfirmation.title}</h2></div>
          <button aria-label="Schließen" disabled={Boolean(folderBusyId)} onClick={() => setFolderConfirmation(undefined)}><X size={17} /></button>
        </header>
        <p id="mail-folder-confirmation-description">{folderConfirmation.description}</p>
        <div className="app-confirmation-detail">{folderConfirmation.detail}</div>
        <footer>
          <button className="secondary-button" disabled={Boolean(folderBusyId)} onClick={() => setFolderConfirmation(undefined)}>Abbrechen</button>
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
  return ({ inbox: "Posteingang", drafts: "Entwürfe", sent: "Gesendet", archive: "Archiv", all: "Alle E-Mails", junk: "Spam", spam: "Spam", trash: "Gelöscht" } as Record<string, string>)[folder.role] ?? folder.name;
}

function mailFolderIcon(role: string): typeof Folder {
  return ({ inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, all: Mail, junk: AlertCircle, spam: AlertCircle, trash: Trash2 } as Record<string, typeof Folder>)[role] ?? Folder;
}

function useVisualViewportLayout() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;

    const syncViewport = () => {
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      root.style.setProperty("--visual-viewport-height", `${Math.round(height)}px`);
      root.style.setProperty("--visual-viewport-offset-top", `${Math.round(offsetTop)}px`);
      const keyboardOpen = window.innerWidth <= 760 && height < window.innerHeight * 0.82;
      document.body.classList.toggle("software-keyboard-open", keyboardOpen);
    };

    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    document.addEventListener("focusin", syncViewport);
    document.addEventListener("focusout", syncViewport);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      document.removeEventListener("focusin", syncViewport);
      document.removeEventListener("focusout", syncViewport);
      document.body.classList.remove("software-keyboard-open");
      root.style.removeProperty("--visual-viewport-height");
      root.style.removeProperty("--visual-viewport-offset-top");
    };
  }, []);
}

function MobileBottomNav({ section, unreadCount }: { readonly section: WorkspaceSection; readonly unreadCount: number }) {
  const items = navigation.filter((item) => item.section !== "ai");
  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile End Master Navigation">
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
  if (latest === undefined) return "Noch nicht synchronisiert";
  const minutes = Math.max(0, Math.round((Date.now() - latest) / 60_000));
  if (minutes < 1) return "nur synchronisiert";
  if (minutes < 60) return `${minutes} Vor Minuten synchronisieren`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} Vor Stunde synchronisieren` : `${Math.round(hours / 24)} Vor dem Tag synchronisieren`;
}

function sidebarCalendarSourceLabel(calendar: SidebarCalendarSource): string {
  const provider = calendar.providerData?.providerId;
  const source = provider === "local-calendar"
    ? "Ort"
    : provider === "caldav"
      ? "CalDAV"
      : provider === "exchange"
        ? "Exchange"
        : provider === "ics"
          ? "ICS"
          : "Kalender";
  return `${source}${calendar.readOnly ? " · Nur lesen" : ""}`;
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
    const areaName = project.areaName?.trim() || "Nicht kategorisiert";
    const entries = groups.get(areaName) ?? [];
    entries.push(project);
    groups.set(areaName, entries);
  }
  return Array.from(groups, ([areaName, entries]) => ({
    areaName,
    projects: entries.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "de-DE")),
  })).sort((left, right) => {
    if (left.areaName === "Nicht kategorisiert") return 1;
    if (right.areaName === "Nicht kategorisiert") return -1;
    return left.areaName.localeCompare(right.areaName, "de-DE");
  });
}

function SidebarListHeading({
  title,
  collapsed,
  onToggle,
  onContextMenu,
}: {
  readonly title: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onContextMenu: (x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  return <div className="sidebar-context-heading sidebar-list-heading">
    <button
      type="button"
      className="sidebar-list-toggle"
      aria-expanded={!collapsed}
      onClick={onToggle}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY, event.currentTarget);
      }}
    ><ChevronRight size={12} /><span>{title}</span></button>
  </div>;
}

function SidebarProjectGroups({
  collapsedAreas,
  groups,
  draggedProjectId,
  dropTarget,
  selectedProjectId,
  counts,
  countLabel = "eine herausragende Aufgabe",
  projectHref = (project) => `/projects?project=${encodeURIComponent(project.id)}`,
  onNavigate,
  onAreaContextMenu,
  onToggleArea,
  onProjectContextMenu,
  onProjectDragStart,
  onProjectDragEnd,
  onProjectDragOver,
  onProjectDrop,
}: {
  readonly collapsedAreas: ReadonlySet<string>;
  readonly groups: readonly SidebarProjectGroup[];
  readonly draggedProjectId?: string;
  readonly dropTarget?: SidebarProjectDropTarget;
  readonly selectedProjectId?: string;
  readonly counts?: ReadonlyMap<string, number>;
  readonly countLabel?: string;
  readonly projectHref?: (project: SidebarProjectSummary) => string;
  readonly onNavigate: () => void;
  readonly onAreaContextMenu?: (areaName: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
  readonly onToggleArea: (areaName: string) => void;
  readonly onProjectContextMenu?: (projectId: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
  readonly onProjectDragStart?: (projectId: string) => void;
  readonly onProjectDragEnd?: () => void;
  readonly onProjectDragOver?: (target: SidebarProjectDropTarget | undefined) => void;
  readonly onProjectDrop?: (projectId: string, target: SidebarProjectDropTarget) => void;
}) {
  return <div className="sidebar-project-groups">
    {groups.map((group) => {
      const collapsed = collapsedAreas.has(group.areaName);
      const areaTargeted = dropTarget?.areaName === group.areaName && !dropTarget.projectId;
      return <section className={`sidebar-project-group ${collapsed ? "collapsed" : ""} ${areaTargeted ? "drop-target" : ""}`} key={group.areaName}>
      <h3 onContextMenu={(event) => {
        if (!onAreaContextMenu) return;
        event.preventDefault();
        onAreaContextMenu(group.areaName, event.clientX, event.clientY, event.currentTarget.querySelector("button"));
      }}
      onDragOver={(event) => {
        const projectId = Array.from(event.dataTransfer.types).includes(PROJECT_DRAG_TYPE)
          ? event.dataTransfer.getData(PROJECT_DRAG_TYPE) || draggedProjectId
          : draggedProjectId;
        if (!projectId || !onProjectDrop) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onProjectDragOver?.({ areaName: group.areaName });
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onProjectDragOver?.(undefined);
      }}
      onDrop={(event) => {
        const projectId = event.dataTransfer.getData(PROJECT_DRAG_TYPE) || draggedProjectId;
        if (!projectId || !onProjectDrop) return;
        event.preventDefault();
        onProjectDrop(projectId, { areaName: group.areaName });
      }}><button type="button" aria-expanded={!collapsed} onClick={() => onToggleArea(group.areaName)}><ChevronRight size={11} />{group.areaName}</button><span>{group.projects.length}</span></h3>
      {!collapsed && <nav className="sidebar-project-list" aria-label={`${group.areaName}Projekt`}>
        {group.projects.map((project) => <SidebarProjectLink
          active={selectedProjectId === project.id}
          dragging={draggedProjectId === project.id}
          dropZone={dropTarget?.projectId === project.id ? dropTarget.zone : undefined}
          key={project.id}
          project={project}
          count={counts?.get(project.id) ?? 0}
          countLabel={countLabel}
          href={projectHref(project)}
          onNavigate={onNavigate}
          onContextMenu={onProjectContextMenu}
          onDragStart={onProjectDragStart}
          onDragEnd={onProjectDragEnd}
          onDragOver={(targetProjectId, zone) => onProjectDragOver?.({ areaName: group.areaName, projectId: targetProjectId, zone })}
          onDrop={(projectId, targetProjectId, zone) => onProjectDrop?.(projectId, { areaName: group.areaName, projectId: targetProjectId, zone })}
        />)}
      </nav>}
    </section>;
    })}
  </div>;
}

function SidebarProjectLink({
  active,
  dragging,
  dropZone,
  project,
  count,
  countLabel,
  href,
  onNavigate,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  readonly active: boolean;
  readonly dragging?: boolean;
  readonly dropZone?: SidebarProjectDropZone;
  readonly project: SidebarProjectSummary;
  readonly count: number;
  readonly countLabel: string;
  readonly href: string;
  readonly onNavigate: () => void;
  readonly onContextMenu?: (projectId: string, x: number, y: number, returnFocus?: HTMLElement | null) => void;
  readonly onDragStart?: (projectId: string) => void;
  readonly onDragEnd?: () => void;
  readonly onDragOver?: (projectId: string, zone: SidebarProjectDropZone) => void;
  readonly onDrop?: (sourceProjectId: string, targetProjectId: string, zone: SidebarProjectDropZone) => void;
}) {
  return <Link
    className={`${active ? "active" : ""} ${dragging ? "dragging" : ""} ${dropZone ? `drop-${dropZone}` : ""}`}
    draggable={Boolean(onDragStart)}
    href={href}
    onClick={onNavigate}
    onDragStart={(event) => {
      if (!onDragStart) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
      onDragStart(project.id);
    }}
    onDragEnd={onDragEnd}
    onDragOver={(event) => {
      if (!onDragOver || dragging) return;
      const projectId = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
      if (!projectId && !Array.from(event.dataTransfer.types).includes(PROJECT_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      onDragOver(project.id, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
    }}
    onDrop={(event) => {
      if (!onDrop) return;
      const sourceProjectId = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
      if (!sourceProjectId || sourceProjectId === project.id) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onDrop(sourceProjectId, project.id, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
    }}
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
  desktopAvailable,
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
  readonly desktopAvailable: boolean;
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
    case "settings": return <SettingsPage currentUser={currentUser} desktopAvailable={desktopAvailable} />;
  }
}

type WorkspaceUser = {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: AppRole;
};

function SettingsPage({ currentUser, desktopAvailable }: { readonly currentUser: WorkspaceUser; readonly desktopAvailable: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = normalizeSettingsTab(searchParams.get("tab"), currentUser.role, desktopAvailable);
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
        {activeTab === "desktop" && <DesktopReminderSettingsPanel />}
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
    title: "global",
    shortcuts: [
      { keys: ["Ctrl/Cmd", "K"], action: "Globale Suche öffnen" },
      { keys: ["Esc"], action: "Das Such-, Menü- oder aktuelle Bestätigungsfenster Weniger anzeigen" },
    ],
  },
  {
    title: "Suchen",
    shortcuts: [
      { keys: ["Enter"], action: "Öffnet das aktuelle Suchergebnis" },
      { keys: ["Esc"], action: "Suchfeld Weniger anzeigen" },
      { keys: ["Menütasten"], action: "Suchergebnismenü öffnen" },
      { keys: ["Shift", "F10"], action: "Suchergebnismenü öffnen" },
    ],
  },
  {
    title: "Kontextmenü",
    shortcuts: [
      { keys: ["↑↓"], action: "Fokus zwischen Menüpunkten verschieben" },
      { keys: ["Home"], action: "Zum ersten Menüeintrag springen" },
      { keys: ["End"], action: "Zum letzten Menüeintrag springen" },
      { keys: ["Esc"], action: "Menü Weniger anzeigen und Fokus wiederherstellen" },
    ],
  },
  {
    title: "Links-Navigator",
    shortcuts: [
      { keys: ["←"], action: "schmale linke Navigation" },
      { keys: ["→"], action: "nach links einzoomen" },
      { keys: ["Shift", "←/→"], action: "Navigationsbreite in größeren Schritten ändern" },
      { keys: ["Home"], action: "auf Mindestbreite eingestellt" },
      { keys: ["End"], action: "auf maximale Breite eingestellt" },
    ],
  },
  {
    title: "E-Mail",
    shortcuts: [
      { keys: ["↑↓"], action: "Vorherige oder Nächste E-Mail auswählen" },
      { keys: ["Shift", "↑↓"], action: "Auswahl mehrerer Mails auf kontinuierlicher Basis" },
      { keys: ["Ctrl/Cmd", "klicken"], action: "Erhöhung oder Abnahme der Auswahl von einzelnen E-Mail" },
      { keys: ["Shift", "klicken"], action: "kontinuierlich aus dem letzten Standort ausgewählt" },
      { keys: ["Ctrl/Cmd", "A"], action: "Alle aktuellen Filterergebnisse auswählen" },
      { keys: ["Esc"], action: "Multi-Select-Mail löschen" },
      { keys: ["Enter"], action: "Öffnet die aktuell ausgewählte E-Mail" },
      { keys: ["Delete/Entf"], action: "aktuelle oder mehrere E-Mails löschen" },
      { keys: ["Menütasten"], action: "Öffnen Sie das Menü Mail-Bedienung" },
      { keys: ["Shift", "F10"], action: "Öffnen Sie das Menü Mail-Bedienung" },
      { keys: ["Enter"], action: "ein aktiver oder fokussierter Mail-Thread" },
      { keys: ["Space"], action: "ein aktiver oder fokussierter Mail-Thread" },
    ],
  },
  {
    title: "Kalender",
    shortcuts: [
      { keys: ["Menütasten"], action: "Öffnen Sie das Kalender-Veranstaltungsmenü" },
      { keys: ["Shift", "F10"], action: "Öffnen Sie das Kalender-Veranstaltungsmenü" },
      { keys: ["Shift", "Rechter Schlüssel"], action: "Speichern Sie das originale rechte Knopfmenü für Browser" },
    ],
  },
  {
    title: "Projektplan",
    shortcuts: [
      { keys: ["Ctrl", "Räder"], action: "Skalierung Projekt Gantt Diagramm Zeitachse" },
      { keys: ["Enter"], action: "Fokussierte geplante Aufgaben bearbeiten" },
      { keys: ["Space"], action: "Fokussierte geplante Aufgaben bearbeiten" },
      { keys: ["Menütasten"], action: "Öffnen Sie das Menü Planbetrieb" },
      { keys: ["Shift", "F10"], action: "Öffnen Sie das Menü Planbetrieb" },
    ],
  },
  {
    title: "Notiz",
    shortcuts: [
      { keys: ["Menütasten"], action: "Hinweis öffnen Menü für die Operation öffnen" },
      { keys: ["Shift", "F10"], action: "Hinweis öffnen Menü für die Operation öffnen" },
      { keys: ["Ctrl/Cmd", "B"], action: "dicker" },
      { keys: ["Ctrl/Cmd", "I"], action: "kursiv" },
      { keys: ["Ctrl/Cmd", "U"], action: "unterstrichen" },
      { keys: ["Ctrl/Cmd", "E"], action: "Zeilencode" },
      { keys: ["Ctrl/Cmd", "Shift", "X"], action: "Streik" },
      { keys: ["Ctrl/Cmd", ","], action: "Subskript" },
      { keys: ["Ctrl/Cmd", "."], action: "Superskript" },
      { keys: ["Ctrl/Cmd", "Shift", "H"], action: "Hervorhebung" },
      { keys: ["Ctrl/Cmd", "Shift", "M"], action: "Entwurf von Kommentaren hinzufügen" },
    ],
  },
  {
    title: "Einstellungen und Verdrahtung",
    shortcuts: [
      { keys: ["Menütasten"], action: "Öffnet das aktuelle Task- oder Backup-Menü" },
      { keys: ["Shift", "F10"], action: "Öffnet das aktuelle Task- oder Backup-Menü" },
      { keys: ["Esc"], action: "Benutzermenü oder schwebendes Fenster schließen" },
    ],
  },
  {
    title: "Formatierung auf Blockebene des Editors",
    shortcuts: [
      { keys: ["Ctrl/Cmd", "Alt", "1-6"], action: "Umschalten auf Level 1 bis 6" },
      { keys: ["Ctrl/Cmd", "Alt", "8"], action: "Code-Blocks umschalten" },
      { keys: ["Ctrl/Cmd", "Shift", "."], action: "Referenzblöcke umschalten" },
      { keys: ["Ctrl/Cmd", "Enter"], action: "Exit Break nach dem aktuellen Block einfügen" },
      { keys: ["Ctrl/Cmd", "Shift", "Enter"], action: "Exit Break vor dem aktuellen Block einfügen" },
    ],
  },
  {
    title: "Editor AI und Werkzeugschicht",
    shortcuts: [
      { keys: ["Tab"], action: "Akzeptieren Sie den vollständigen Wortlaut der KI" },
      { keys: ["Ctrl/Cmd", "→"], action: "Akzeptieren Sie das nächste Wort für KI-Vervollständigung" },
      { keys: ["Ctrl", "Space"], action: "Empfehlungen zur KI-Vervollständigung auslösen" },
      { keys: ["Esc"], action: "KI-Vervollständigung verweigern oder den Editor KI-Ausgabe stoppen" },
      { keys: ["Enter"], action: "KI-Eingang des Editors abschicken" },
      { keys: ["Backspace"], action: "KI-Menü bei leerer Eingabe schließen" },
      { keys: ["↓"], action: "Zusätzliches Menü zum Öffnen von Medien-Upload-Schaltflächen" },
      { keys: ["Enter"], action: "Medien-URL oder Zeicheneingabe bestätigen" },
      { keys: ["Enter"], action: "Übermittlung von Stellungnahmen" },
      { keys: ["Shift", "Enter"], action: "Zeilenbruch in Kommentaren" },
    ],
  },
  {
    title: "AI Command",
    shortcuts: [
      { keys: ["Enter"], action: "Senden Sie die aktuelle Nachricht" },
      { keys: ["Shift", "Enter"], action: "Zeilenbruch in der Nachricht" },
    ],
  },
] as const;

function ShortcutsSettings() {
  return (
    <section className="shortcuts-settings panel">
      <div className="settings-section-heading">
        <h2>Tastenkürzel</h2>
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
      if (!response.ok || !payload.ok || !payload.jobs) throw new Error(payload.message || "Aufgabe kann nicht gelesen werden");
      setJobs(filter === "active" ? payload.jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "failed") : payload.jobs);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Aufgabe kann nicht gelesen werden" });
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
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Aufgabenoperation fehlgeschlagen");
      setFeedback({ kind: "success", message: action === "retry" ? "Aufgabe wieder in die in Warteschlange gestellt" : "Annullierung der Aufgabe" });
      await loadJobs();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Aufgabenoperation fehlgeschlagen" });
    } finally {
      setBusyJobId(undefined);
    }
  };

  const deleteJobRecord = async (job: AppJobPayload) => {
    if (!await appConfirm({
      title: `Aufgabenprotokoll „${job.title}“ löschen?`,
      description: "Es werden nur der Aufgabenverlauf und die Protokolle gelöscht, nicht die von der Aufgabe erstellten Sicherungen oder sonstigen Daten.",
      confirmLabel: "Protokoll löschen",
      tone: "danger",
    })) return;
    setBusyJobId(job.id);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Aufgabenprotokoll kann nicht gelöscht werden");
      setFeedback({ kind: "success", message: "Aufgabenprotokoll gelöscht" });
      await loadJobs();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Aufgabenprotokoll kann nicht gelöscht werden" });
    } finally {
      setBusyJobId(undefined);
    }
  };

  const menuJob = menu ? jobs.find((job) => job.id === menu.id) : undefined;
  const menuJobFinished = menuJob ? !["queued", "running"].includes(menuJob.status) : false;
  const jobCommands: readonly ResolvedContextCommand[] = menuJob ? [
    { id: "job.copy-id", label: "Aufgaben-ID kopieren", group: "primary", risk: "read", icon: "copy" },
    { id: "job.copy-logs", label: "Protokoll kopieren", group: "primary", risk: "read", icon: "info", disabledReason: menuJob.logLines.length ? undefined : "kein Protokoll verfügbar" },
    { id: "job.retry", label: "Re-queuierung", group: "state", risk: "local-write", icon: "restore", disabledReason: menuJob.status === "failed" || menuJob.status === "cancelled" ? undefined : "nur fehlgeschlagene oder stornierte Aufgaben können erneut getestet werden" },
    { id: "job.cancel", label: "Aufgabe abbrechen", group: "danger", risk: "local-write", icon: "trash", disabledReason: menuJob.status === "queued" ? undefined : "Nur Aufgaben löschen" },
    { id: "job.delete", label: "Task-Aufzeichnungen löschen", group: "danger", risk: "destructive", icon: "trash", disabledReason: menuJobFinished ? undefined : "Aufgaben in in Warteschlange oder Ausführung können nicht gelöscht werden" },
  ] : [];

  const openJobMenu = (event: ReactMouseEvent<HTMLElement>, job: AppJobPayload) => {
    event.preventDefault();
    setMenu({ id: job.id, x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
  };

  const selectJobCommand = (commandId: ContextCommandId) => {
    if (!menuJob) return;
    if (commandId === "job.copy-id") void copyText(menuJob.id, "Aufgaben-ID kopiert", setFeedback);
    if (commandId === "job.copy-logs") void copyText(menuJob.logLines.join("\n"), "Aufgabenprotokoll kopiert", setFeedback);
    if (commandId === "job.retry") void updateJob(menuJob, "retry");
    if (commandId === "job.cancel") void updateJob(menuJob, "cancel");
    if (commandId === "job.delete") void deleteJobRecord(menuJob);
  };

  return (
    <section className="job-center-settings panel">
      <div className="settings-section-heading">
        <h2>Hintergrundaufgaben</h2>
        <span className="step-badge">{loading ? "Lesen" : `${jobs.length} eine Aufgabe`}</span>
      </div>
      <div className="job-toolbar">
        {["active", "queued", "running", "failed", "succeeded", "cancelled"].map((item) => (
          <button key={item} className={filter === item ? "active" : ""} onClick={() => { setLoading(true); setFilter(item); }}>{jobFilterLabel(item)}</button>
        ))}
        <button className="secondary-button" disabled={loading} onClick={() => { setLoading(true); void loadJobs(); }}><RefreshCw size={14} />Aktualisieren</button>
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
            {job.logLines.length > 0 && <details><summary>Protokoll</summary>{job.logLines.slice(0, 8).map((line, index) => <code key={`${job.id}-${index}`}>{line}</code>)}</details>}
            <footer>
              {job.status === "queued" && <button className="ghost-button" disabled={busyJobId === job.id} onClick={() => void updateJob(job, "cancel")}><X size={13} />Abbrechen</button>}
              {(job.status === "failed" || job.status === "cancelled") && <button className="secondary-button" disabled={busyJobId === job.id} onClick={() => void updateJob(job, "retry")}><RefreshCw size={13} />Erneut versuchen</button>}
              {!["queued", "running"].includes(job.status) && <button className="ghost-button danger-button" disabled={busyJobId === job.id} onClick={() => void deleteJobRecord(job)}><Trash2 size={13} />Datensätze löschen</button>}
            </footer>
          </article>
        )) : <div className="accounts-empty">{loading ? "Aufgaben werden geladen…" : "Derzeit keine Aufgaben"}</div>}
      </div>
      {feedback && <div className={`user-settings-feedback ${feedback.kind}`}>{feedback.message}</div>}
      {menu && menuJob && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          ariaLabel={`Aufgabe: ${menuJob.title}`}
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
      if (!response.ok || !payload.ok || !payload.operations) throw new Error(payload.message || "Systemstatus konnte nicht gelesen werden");
      setOperations(payload.operations);
      setFeedback(undefined);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Systemstatus konnte nicht gelesen werden");
    }
  }, []);

  useEffect(() => { void loadOperations(); }, [loadOperations]);

  return (
    <section className="operations-settings panel">
      <div className="settings-section-heading">
        <h2>Systemstatus</h2>
        <button className="secondary-button" onClick={() => void loadOperations()}><RefreshCw size={14} />Aktualisieren</button>
      </div>
      {operations ? (
        <>
          <div className="operations-grid">
            <article><span><DatabaseBackup size={17} /></span><small>Datenbank</small><strong>{operations.database.connected ? "Verbunden" : "Fehler"}</strong><p>v{operations.database.currentVersion} / v{operations.database.latestVersion}{operations.database.pendingVersions.length ? ` · Ausstehende Migrationen: ${operations.database.pendingVersions.join(", ")}` : ""}</p></article>
            <article><span><Clock3 size={17} /></span><small>Task-Warteschlange</small><strong>{operations.jobs.running} aktiv · {operations.jobs.queued} in Warteschlange</strong><p>{operations.jobs.failed} fehlgeschlagen</p></article>
            <article><span><HardDrive size={17} /></span><small>Datenverzeichnis</small><strong>{operations.dataDirectory.writable ? "schreibbar" : "nicht schreibbar"}</strong><p>{operations.dataDirectory.path}</p></article>
            <article><span><ShieldCheck size={17} /></span><small>Hauptschlüssel</small><strong>{operations.masterKey.configured ? "Umgebungsvariable" : "nicht konfiguriert"}</strong><p>KALENDER_MASTER_KEY</p></article>
            <article><span><DatabaseBackup size={17} /></span><small>Sicherungswerkzeuge</small><strong>{operations.backup.strategy?.tools.pgDump && operations.backup.strategy.tools.pgRestore ? "pg_dump/restore verfügbar" : "Werkzeuge fehlen"}</strong><p>{operations.backup.strategy?.backupDirectory}</p></article>
            <article><span><Paperclip size={17} /></span><small>Anhänge</small><strong>{operations.backup.attachmentFiles} Dateien</strong><p>{formatFileSize(operations.backup.attachmentBytes)}</p></article>
          </div>
          <div className="operations-detail-grid">
            <section>
              <h3>Funktionskonfiguration</h3>
              <div className="operations-check-list">
                <span className={operations.environment.aiAutoExecutionEnabled ? "ready" : "optional"}><Check size={13} />Automatische AI-Ausführung: {operations.environment.aiAutoExecutionEnabled ? "Aktiv" : "Inaktiv"}</span>
                <span className={operations.environment.backupPasswordConfigured ? "ready" : "optional"}>{operations.environment.backupPasswordConfigured ? <Check size={13} /> : <Circle size={13} />}Passwort für automatische Sicherungen: {operations.environment.backupPasswordConfigured ? "konfiguriert" : "nach Bedarf konfiguriert"}</span>
                <span className={operations.environment.healthcheckTokenConfigured ? "ready" : "optional"}><ShieldCheck size={13} />Statusprüfung: {operations.environment.healthcheckTokenConfigured ? "geschützt durch Token" : "Öffentlich erreichbar"}</span>
              </div>
            </section>
            <section>
              <h3>Speicherverzeichnis</h3>
              <div className="operations-storage-list">
                {operations.storage.layout.map((item) => (
                  <article key={item.id}>
                    <div><strong>{item.label}</strong><small>{item.path}</small></div>
                    <span>{item.exists ? "vorhanden" : "nicht erstellt"} · {item.writable ? "schreibbar" : "nicht schreibbar"} · {formatFileSize(item.bytes)} · {item.files} Dateien</span>
                  </article>
                ))}
              </div>
            </section>
            <section>
              <h3>Letzte Fehler</h3>
              <div className="operations-error-list">
                {operations.recentErrors.length ? operations.recentErrors.map((item) => (
                  <article key={item.id}><strong>{item.title}</strong><small>{formatAccountTime(item.createdAt)}</small><p>{item.message}</p></article>
                )) : <div className="accounts-empty">Keine kürzlich fehlgeschlagenen Aufgaben</div>}
              </div>
            </section>
          </div>
        </>
      ) : <div className="accounts-empty">{feedback ?? "Systemstatus wird geladen…"}</div>}
      {feedback && <div className="user-settings-feedback error">{feedback}</div>}
    </section>
  );
}

const backgroundSyncIntervals = [
  { value: 60_000, label: "1 Minute" },
  { value: 3 * 60_000, label: "3 Minuten" },
  { value: 5 * 60_000, label: "5 Minuten" },
  { value: 10 * 60_000, label: "10 Minuten" },
  { value: 15 * 60_000, label: "15 Minuten" },
  { value: 30 * 60_000, label: "30 Minuten" },
] as const;

const clientRefreshIntervals = [
  { value: 15_000, label: "15 Sekunden" },
  { value: 30_000, label: "30 Sekunden" },
  { value: 60_000, label: "1 Minute" },
  { value: 2 * 60_000, label: "2 Minuten" },
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
      setFeedback({ kind: "success", message: "Synchronisierungseinstellungen gespeichert. Hintergrundintervalle und Seitenaktualisierung wurden sofort übernommen." });
    } catch (saveError) {
      setFeedback({ kind: "error", message: saveError instanceof Error ? saveError.message : "Sync-Einstellungen können nicht gespeichert werden" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sync-settings panel" aria-labelledby="sync-settings-title">
      <div className="settings-section-heading">
        <h2 id="sync-settings-title">Synchronisierung</h2>
        <span className="step-badge">{loading ? "Lesen" : `${activeServices} Dienste aktiv`}</span>
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
              ? "Änderungen an E-Mails, Kalendern, Aufgaben und Sicherungen werden in Echtzeit auf dieser Seite angezeigt."
              : fallbackActive
                ? `zur Zeit in Gebrauch ${formatRealtimeFallbackInterval(draft.clientRefreshIntervalMs)} Fallback-Aktualisierung.`
                : realtimeStatus.description}
          </small>
        </div>
        <dl className="sync-realtime-metrics">
          <div><dt>Letztes Ereignis</dt><dd>{realtime.lastEvent ? `${realtimeTopicLabel(realtime.lastEvent.topic)} · ${formatAccountTime(realtime.lastEvent.occurredAt)}` : "nicht verfügbar"}</dd></div>
          <div><dt>Aktuelle Verbindung</dt><dd>{realtime.connectedAt ? formatAccountTime(realtime.connectedAt) : "nicht Verbunden"}</dd></div>
          <div><dt>Automatische Wiederverbindungen</dt><dd>{realtime.reconnectCount}-mal</dd></div>
        </dl>
        <button
          type="button"
          className="secondary-button"
          disabled={realtime.status === "connecting"}
          title="Echtzeitverbindung neu herstellen"
          onClick={realtime.reconnect}
        >
          <RefreshCw size={14} />
          Wiederverbinden
        </button>
      </div>

      <div className="sync-settings-group">
        <header>
          <div><h3>Hintergrundsynchronisierung</h3></div>
          <span>{activeServices ? "Aktiv" : "Pausiert"}</span>
        </header>
        <SyncSettingsRow
          icon={<Mail size={17} />}
          title="E-Mails automatisch synchronisieren"
          description="Ordner, Lesestatus und E-Mail-Index automatisch aktualisieren."
          enabled={draft.mailSyncEnabled}
          intervalMs={draft.mailSyncIntervalMs}
          intervals={backgroundSyncIntervals}
          disabled={loading || saving || !canEdit}
          onEnabledChange={(mailSyncEnabled) => setDraft((current) => ({ ...current, mailSyncEnabled }))}
          onIntervalChange={(mailSyncIntervalMs) => setDraft((current) => ({ ...current, mailSyncIntervalMs }))}
        />
        <SyncSettingsRow
          icon={<CalendarDays size={17} />}
          title="Kalender automatisch synchronisieren"
          description="Remote-Kalender, Terminänderungen und Teilnehmerinformationen aktualisieren."
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
          <div><h3>Fallback-Aktualisierung</h3></div>
          <span>{draft.clientRefreshEnabled ? "Aktiv" : "Deaktiviert"}</span>
        </header>
        <SyncSettingsRow
          icon={<Monitor size={17} />}
          title="Sichtbare Seite regelmäßig aktualisieren"
          description="Nur bei getrennter Echtzeitverbindung und sichtbarer Seite; beim Zurückkehren zum Fenster wird einmal aktualisiert."
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
        <span>{canEdit ? changed ? "Nicht gespeicherte Änderungen" : "Einstellungen sind aktuell" : "Nur Administratoren können diese Einstellungen ändern"}</span>
        <button
          type="button"
          className="primary-button"
          disabled={!canEdit || loading || saving || !changed}
          onClick={() => void saveSettings()}
        >
          {saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          Einstellungen speichern
        </button>
      </footer>
    </section>
  );
}

function realtimeConnectionCopy(status: ReturnType<typeof useRealtimeConnection>["status"]): {
  readonly title: string;
  readonly description: string;
} {
  if (status === "connected") return { title: "WebSocket verbunden", description: "Echtzeitübertragung ist aktiv." };
  if (status === "connecting") return { title: "Verbindung zum Echtzeitdienst wird hergestellt", description: "Die Sitzung stellt die Verbindung her." };
  if (status === "offline") return { title: "Browser derzeit offline", description: "Die Verbindung wird automatisch wiederhergestellt, sobald das Netzwerk verfügbar ist." };
  return { title: "Echtzeitverbindung getrennt", description: "Das System versucht automatisch, die Verbindung wiederherzustellen." };
}

function realtimeTopicLabel(topic: RealtimeTopic): string {
  return ({
    system: "Verbindung",
    mail: "E-Mail",
    calendar: "Kalender",
    task: "Aufgabe",
    project: "Projekt",
    note: "Notiz",
    relation: "Verknüpfung",
    job: "Hintergrundaufgaben",
    backup: "Datensicherung",
    settings: "Einstellungen",
  } as Record<RealtimeTopic, string>)[topic];
}

function formatRealtimeFallbackInterval(intervalMs: number): string {
  if (intervalMs < 60_000) return `${Math.round(intervalMs / 1_000)} Sekunden`;
  return `${Math.round(intervalMs / 60_000)} Minuten`;
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
        <span>Häufigkeit</span>
        <AppSelect
          ariaLabel={`${title} – Synchronisierungsintervall`}
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
        <em>{enabled ? "Aktiv" : "Inaktiv"}</em>
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
      setFeedback("Darstellungseinstellungen konnten nicht gespeichert werden");
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
        <h2>Erscheinungsbild</h2>
      </div>
      <div className="appearance-layout">
        <section>
          <h3>Modus</h3>
          <div className="appearance-choice-grid mode">
            <button className={preference.mode === "system" ? "active" : ""} onClick={() => setMode("system")}><Monitor size={17} /><strong>System</strong><small>Automatisch an den Systemmodus anpassen</small></button>
            <button className={preference.mode === "light" ? "active" : ""} onClick={() => setMode("light")}><Sun size={17} /><strong>Hell</strong><small>Helle Oberfläche für den täglichen Gebrauch</small></button>
            <button className={preference.mode === "dark" ? "active" : ""} onClick={() => setMode("dark")}><Moon size={17} /><strong>Dunkel</strong><small>Geeignet für die Nacht und Umgebungen mit wenig Licht</small></button>
          </div>
        </section>
        <section>
          <h3>Helles Farbschema</h3>
          <div className="appearance-choice-grid tone">
            {[
              { id: "light-fog" as const, title: "Nebelgrau", text: "Modern und professionell; empfohlen", swatches: ["#f5f7f8", "#ffffff", "#4f8fcf", "#4f9d69"] },
              { id: "light-warm" as const, title: "Warmweiß", text: "Weich und angenehm für längeres Lesen", swatches: ["#fbfaf7", "#ffffff", "#5e8fb8", "#8f7659"] },
              { id: "light-blue" as const, title: "Blaugrau", text: "Sachlich und ruhig mit klarer Tiefenwirkung", swatches: ["#eef3f6", "#ffffff", "#2d78b8", "#27a3a3"] },
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
          <h3>Dunkel Hue</h3>
          <div className="appearance-choice-grid tone single">
            <button className={preference.darkTone === "dark-pro" ? "active" : ""} onClick={() => setDarkTone("dark-pro")}>
              <span className="appearance-swatches">{["#151817", "#222725", "#76b7f2", "#d8a24e"].map((color) => <i key={color} style={{ background: color }} />)}</span>
              <strong>Professionell dunkel</strong>
              <small>Vertraute dunkle Oberfläche mit verbessertem Kontrast</small>
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
      setFeedback({ kind: "error", message: "Die neuen Passwörter stimmen nicht überein" });
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
      if (!response.ok) throw new Error(payload?.message || "Profil konnte nicht aktualisiert werden");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setFeedback({ kind: "success", message: "Profil aktualisiert" });
      router.refresh();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Profil konnte nicht aktualisiert werden" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="profile-settings panel" aria-labelledby="profile-settings-title">
      <div className="settings-section-heading">
        <h2 id="profile-settings-title">Konten</h2>
        <span className="step-badge">{roleLabel(currentUser.role)}</span>
      </div>
      <div className="account-form profile-form">
        <label><span>Anzeigename</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" /></label>
        <label><span>E-Mail-Adresse für die Anmeldung</span><input value={currentUser.email} disabled /></label>
        <label><span>Aktuelles Passwort</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" placeholder="Für eine Passwortänderung erforderlich" /></label>
        <label><span>Neues Passwort</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" placeholder="mindestens 8 Zeichen" /></label>
        <label><span>Neues Passwort bestätigen</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label>
      </div>
      {feedback && <div className={`user-settings-feedback ${feedback.kind}`} role="status">{feedback.message}</div>}
      <footer className="settings-actions">
        <button className="primary-button" disabled={busy || displayName.trim().length < 2 || Boolean(newPassword) !== Boolean(currentPassword)} onClick={() => void saveProfile()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{busy ? "Speichern..." : "Profil speichern"}
        </button>
      </footer>
    </section>
  );
}

function UserManagementSettings({ currentUser }: { readonly currentUser: WorkspaceUser }) {
  const [users, setUsers] = useState<readonly ManagedUser[]>([]);
  const [invitations, setInvitations] = useState<readonly ManagedInvitation[]>([]);
  const [inviteSenderAccounts, setInviteSenderAccounts] = useState<readonly SavedMailAccount[]>([]);
  const [inviteSenderAccountId, setInviteSenderAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly message: string }>();
  const [draft, setDraft] = useState({ displayName: "", email: "", password: "", role: "user" as AppRole, mustChangePassword: true });
  const [inviteDraft, setInviteDraft] = useState({ displayName: "", email: "", role: "user" as AppRole });
  const [editing, setEditing] = useState<Record<string, { displayName: string; email: string; role: AppRole; password: string; mustChangePassword: boolean }>>({});
  const inviteSenderInitialized = useRef(false);

  const loadUsers = useCallback(async () => {
    try {
      const [usersResponse, invitationsResponse, accountsResponse] = await Promise.all([
        fetch("/api/users", { cache: "no-store" }),
        fetch("/api/invitations", { cache: "no-store" }),
        fetch("/api/mail-accounts", { cache: "no-store" }),
      ]);
      const usersPayload = await usersResponse.json().catch(() => null) as { readonly users?: readonly ManagedUser[]; readonly message?: string } | null;
      const invitationsPayload = await invitationsResponse.json().catch(() => null) as { readonly invitations?: readonly ManagedInvitation[]; readonly message?: string } | null;
      const accountsPayload = await accountsResponse.json().catch(() => null) as { readonly accounts?: readonly SavedMailAccount[]; readonly message?: string } | null;
      if (!usersResponse.ok) throw new Error(usersPayload?.message || "Benutzer kann nicht gelesen werden");
      if (!invitationsResponse.ok) throw new Error(invitationsPayload?.message || "die Einladung kann nicht gelesen werden");
      if (!accountsResponse.ok) throw new Error(accountsPayload?.message || "es ist nicht möglich, das Absenderkonto zu lesen");
      setUsers(usersPayload?.users ?? []);
      setInvitations(invitationsPayload?.invitations ?? []);
      const senders = (accountsPayload?.accounts ?? []).filter((account) => account.syncStatus !== "paused");
      setInviteSenderAccounts(senders);
      setInviteSenderAccountId((current) => {
        if (inviteSenderInitialized.current && (current === "" || senders.some((account) => account.id === current))) return current;
        inviteSenderInitialized.current = true;
        return senders[0]?.id ?? "";
      });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Benutzer kann nicht gelesen werden" });
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
      if (!response.ok) throw new Error(payload?.message || "Benutzer kann nicht erstellt werden");
      setDraft({ displayName: "", email: "", password: "", role: "user", mustChangePassword: true });
      await loadUsers();
      setFeedback({ kind: "success", message: "Benutzer erstellt" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Benutzer kann nicht erstellt werden" });
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
      if (!response.ok) throw new Error(payload?.message || "Benutzer kann nicht aktualisiert werden");
      await loadUsers();
      setFeedback({ kind: "success", message: "Benutzer aktualisiert" });
      if ("displayName" in changes || "email" in changes || "role" in changes || "password" in changes) {
        setEditing((current) => {
          const next = { ...current };
          delete next[user.id];
          return next;
        });
      }
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Benutzer kann nicht aktualisiert werden" });
    } finally {
      setBusyId(undefined);
    }
  }

  async function deleteUser(user: ManagedUser) {
    if (user.id === currentUser.id || busyId) return;
    if (!await appConfirm({
      title: `Benutzer „${user.displayName}“ dauerhaft löschen?`,
      description: "Die Mailboxverbindung, synchronisierte E-Mail, Kalender, Projekte, Notizen, Aufgaben und KI-Konfiguration des Benutzers werden gelöscht. Diese Operation kann nicht widerrufen werden.",
      confirmLabel: "Dauerhaft löschen",
      tone: "danger",
    })) return;
    setBusyId(user.id);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "Benutzer kann nicht entfernt werden");
      setEditing((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      await loadUsers();
      setFeedback({ kind: "success", message: `Benutzer „${user.displayName}“ dauerhaft gelöscht` });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Benutzer kann nicht entfernt werden" });
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
        body: JSON.stringify({ ...inviteDraft, senderAccountId: inviteSenderAccountId || undefined }),
      });
      const payload = await response.json().catch(() => null) as {
        readonly invitation?: ManagedInvitation;
        readonly delivery?: {
          readonly status?: "not-requested" | "sent" | "failed";
          readonly senderAddress?: string;
          readonly message?: string;
        };
        readonly message?: string;
      } | null;
      if (!response.ok || !payload?.invitation) throw new Error(payload?.message || "Einladung konnte nicht erstellt werden");
      setInviteDraft({ displayName: "", email: "", role: "user" });
      const deliveryStatus = payload.delivery?.status ?? "not-requested";
      if (deliveryStatus !== "sent" && payload.invitation.inviteUrl) {
        await navigator.clipboard?.writeText(payload.invitation.inviteUrl).catch(() => undefined);
      }
      await loadUsers();
      if (deliveryStatus === "sent") {
        setFeedback({ kind: "success", message: `Einladung wurde über ${payload.delivery?.senderAddress ?? "das ausgewählte Mailkonto"} gesendet` });
      } else if (deliveryStatus === "failed") {
        setFeedback({ kind: "error", message: `Einladung erstellt, aber E-Mail gesendet fehlgeschlagen:${payload.delivery?.message ?? "Prüfen Sie das Absenderkonto."}Der Einladungslink wurde kopiert` });
      } else {
        setFeedback({ kind: "success", message: payload.invitation.inviteUrl ? "Einladungslink erstellt und kopiert" : "Einladung erstellt" });
      }
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Einladung konnte nicht erstellt werden" });
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
      if (!response.ok) throw new Error(payload?.message || "Einladung konnte nicht widerrufen werden");
      await loadUsers();
      setFeedback({ kind: "success", message: "Einladung widerrufen" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Einladung konnte nicht widerrufen werden" });
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="user-management-settings panel" aria-labelledby="user-management-title">
      <div className="settings-section-heading">
        <h2 id="user-management-title">Benutzerverwaltung</h2>
        <span className="step-badge">{users.filter((user) => !user.disabledAt).length} aktive Benutzer</span>
      </div>

      <div className="account-form user-create-form">
        <label><span>Anzeigename</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label><span>E-Mail-Adresse</span><input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
        <label><span>Initiales Passwort</span><input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} autoComplete="new-password" /></label>
        <label><span>Rolle</span><AppSelect ariaLabel="Benutzerrollen" value={draft.role} onValueChange={(role) => setDraft({ ...draft, role: role as AppRole })} options={roleOptions()} /></label>
        <label className="secure-toggle"><input type="checkbox" checked={draft.mustChangePassword} onChange={(event) => setDraft({ ...draft, mustChangePassword: event.target.checked })} /><span>Passwortänderung bei der ersten Anmeldung verlangen</span></label>
      </div>
      <footer className="settings-actions">
        <button className="primary-button" disabled={busyId === "create" || draft.displayName.trim().length < 2 || !draft.email.includes("@") || draft.password.length < 8} onClick={() => void createUser()}>
          {busyId === "create" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{busyId === "create" ? "Erstellen..." : "Benutzer erstellen"}
        </button>
      </footer>

      <div className="account-form user-create-form">
        <label><span>Anzeigename der eingeladenen Person</span><input value={inviteDraft.displayName} onChange={(event) => setInviteDraft({ ...inviteDraft, displayName: event.target.value })} /></label>
        <label><span>Einladungs-E-Mail-Adresse</span><input type="email" value={inviteDraft.email} onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })} /></label>
        <label><span>Einladungsrolle</span><AppSelect ariaLabel="Einladungsrolle" value={inviteDraft.role} onValueChange={(role) => setInviteDraft({ ...inviteDraft, role: role as AppRole })} options={roleOptions()} /></label>
        <label>
          <span>Versandart</span>
          <AppSelect
            ariaLabel="Versandart der Einladung"
            value={inviteSenderAccountId}
            onValueChange={setInviteSenderAccountId}
            options={[
              { value: "", label: "Nur Links erstellen und kopieren" },
              ...inviteSenderAccounts.map((account) => ({ value: account.id, label: `${account.displayName} <${account.emailAddress}>` })),
            ]}
          />
        </label>
        <div className="settings-actions inline">
          <button className="secondary-button" disabled={busyId === "invite" || !inviteDraft.email.includes("@")} onClick={() => void createInvitation()}>
            {busyId === "invite" ? <LoaderCircle className="spin" size={15} /> : inviteSenderAccountId ? <Send size={15} /> : <Link2 size={15} />}
            {busyId === "invite" ? inviteSenderAccountId ? "Senden..." : "Erstellen..." : inviteSenderAccountId ? "Einladung senden" : "Einladungslink erstellen"}
          </button>
        </div>
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
              <div className="saved-account-meta"><span>Läuft ab: {formatAccountTime(invitation.expiresAt)}</span><span>Erstellt: {formatAccountTime(invitation.createdAt)}</span></div>
              <div className="saved-account-actions">
                {invitation.inviteUrl && <button className="ghost-button" onClick={() => void navigator.clipboard?.writeText(invitation.inviteUrl!)}><Link2 size={14} />Link kopieren</button>}
                <button className="ghost-button danger-button" disabled={busyId === invitation.id} onClick={() => void revokeInvitation(invitation)}>{busyId === invitation.id ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}Widerrufen</button>
              </div>
            </div>
          </article>
        ))}
      </div>}

      <div className="user-list">
        {loading ? <div className="accounts-empty"><LoaderCircle className="spin" size={18} />Benutzer werden geladen…</div> : users.map((user) => {
          const edit = editing[user.id];
          const disabled = Boolean(user.disabledAt);
          const busy = busyId === user.id;
          return (
            <article className={`saved-account-card user-card ${disabled ? "disabled" : ""}`} key={user.id}>
              <div className="saved-account-color" />
              <div className="saved-account-main">
                <div className="saved-account-title">
                  <div><strong>{user.displayName}</strong><span>{user.email}</span></div>
                  <span className={`sync-status ${disabled ? "sync-status-paused" : "sync-status-ready"}`}>{disabled ? "Deaktiviert" : roleLabel(user.role)}</span>
                </div>
                <div className="saved-account-meta">
                  <span>Erstellt: {formatAccountTime(user.createdAt)}</span>
                  <span>Aktualisiert: {formatAccountTime(user.updatedAt)}</span>
                  <span>Letzte Anmeldung: {user.lastLoginAt ? formatAccountTime(user.lastLoginAt) : "Nie"}</span>
                  <span>Session v{user.sessionVersion}</span>
                  {user.mustChangePassword && <span>Passwortänderung erforderlich</span>}
                  {user.id === currentUser.id && <span>Aktuelles Konto</span>}
                </div>
                {edit && (
                  <div className="account-form user-edit-form">
                    <label><span>Anzeigename</span><input value={edit.displayName} onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, displayName: event.target.value } })} /></label>
                    <label><span>E-Mail-Adresse</span><input type="email" value={edit.email} onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, email: event.target.value } })} /></label>
                    <label><span>Passwort zurücksetzen</span><input type="password" value={edit.password} placeholder="Leer lassen, um das Passwort beizubehalten" onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, password: event.target.value } })} /></label>
                    <label><span>Rolle</span><AppSelect ariaLabel={`${user.displayName}Rolle`} value={edit.role} onValueChange={(role) => setEditing({ ...editing, [user.id]: { ...edit, role: role as AppRole } })} options={roleOptions()} /></label>
                    <label className="secure-toggle"><input type="checkbox" checked={edit.mustChangePassword} onChange={(event) => setEditing({ ...editing, [user.id]: { ...edit, mustChangePassword: event.target.checked } })} /><span>Passwortänderung bei der nächsten Anmeldung verlangen</span></label>
                  </div>
                )}
                <div className="saved-account-actions">
                  {edit ? <>
                    <button className="primary-button" disabled={busy || edit.displayName.trim().length < 2 || !edit.email.includes("@") || (edit.password.length > 0 && edit.password.length < 8)} onClick={() => void patchUser(user, { displayName: edit.displayName, email: edit.email, role: edit.role, password: edit.password || undefined, mustChangePassword: edit.mustChangePassword })}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Speichern</button>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditing((current) => { const next = { ...current }; delete next[user.id]; return next; })}>Abbrechen</button>
                  </> : <>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditing({ ...editing, [user.id]: { displayName: user.displayName, email: user.email, role: user.role, password: "", mustChangePassword: user.mustChangePassword } })}><Pencil size={14} />Bearbeiten</button>
                    <button className={`ghost-button ${disabled ? "" : "danger-button"}`} disabled={busy || user.id === currentUser.id} onClick={() => void patchUser(user, { disabled: !disabled })}>
                      {busy ? <LoaderCircle className="spin" size={14} /> : disabled ? <Play size={14} /> : <Pause size={14} />}{disabled ? "Aktivieren" : "Deaktiviert"}
                    </button>
                    <button
                      className="ghost-button danger-button"
                      disabled={busy || user.id === currentUser.id}
                      title={user.id === currentUser.id ? "Das aktuell angemeldete Konto kann nicht gelöscht werden" : "Benutzer dauerhaft löschen"}
                      onClick={() => void deleteUser(user)}
                    >
                      {busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Löschen
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
      if (!response.ok || !payload?.diagnostic) throw new Error(payload?.message || "Diagnosedaten können nicht gelesen werden");
      setDiagnostic(payload.diagnostic);
      setAuditEvents(payload.auditEvents ?? []);
      setTargetUserId((current) => current || payload.diagnostic?.users.find((user) => !user.disabledAt)?.userId || "");
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Diagnosedaten können nicht gelesen werden" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDiagnostics(); }, [loadDiagnostics]);

  async function assignUnownedData() {
    if (!targetUserId || assigning) return;
    const target = diagnostic?.users.find((user) => user.userId === targetUserId);
    if (!await appConfirm({
      title: "Nicht zugeordnete historische Daten zuweisen?",
      description: `Diese Daten werden „${target?.displayName ?? "dem ausgewählten Benutzer"}“ zugewiesen.`,
      confirmLabel: "Zuweisung bestätigen",
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
      if (!response.ok || !payload?.diagnostic) throw new Error(payload?.message || "Historische Daten konnten nicht zugewiesen werden");
      setDiagnostic(payload.diagnostic);
      setFeedback({ kind: "success", message: "Historische Daten wurden zugewiesen" });
      await loadDiagnostics();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Historische Daten konnten nicht zugewiesen werden" });
    } finally {
      setAssigning(false);
    }
  }

  const unownedEntries = Object.entries(diagnostic?.unownedCounts ?? {}).filter(([, count]) => count > 0);
  const visibleAuditEvents = showAllAuditEvents ? auditEvents : auditEvents.slice(0, 10);
  return (
    <section className="workspace-diagnostics-settings panel" aria-labelledby="workspace-diagnostics-title">
      <div className="settings-section-heading">
        <h2 id="workspace-diagnostics-title">Datendiagnose</h2>
        <button className="secondary-button" disabled={loading} onClick={() => { setLoading(true); void loadDiagnostics(); }}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Aktualisieren
        </button>
      </div>

      <div className="diagnostic-summary">
        <article><span><Users size={17} /></span><div><small>Benutzer</small><strong>{loading ? "…" : diagnostic?.users.length ?? 0}</strong></div></article>
        <article><span><ShieldCheck size={17} /></span><div><small>Nicht zugeordnete Daten</small><strong>{loading ? "…" : diagnostic?.totalUnowned ?? 0}</strong></div></article>
        <article><span><DatabaseBackup size={17} /></span><div><small>Audit-Ereignisse</small><strong>{loading ? "…" : auditEvents.length}</strong></div></article>
      </div>

      {unownedEntries.length > 0 && <div className="diagnostic-unowned">
        <div>
          <strong>Nicht zugeordnete historische Daten</strong>
          <p>{unownedEntries.map(([key, count]) => `${diagnosticLabel(key)} ${count}`).join(" · ")}</p>
        </div>
        <div>
          <AppSelect ariaLabel="Zielbenutzer für historische Daten auswählen" size="compact" value={targetUserId} onValueChange={setTargetUserId} options={[{ value: "", label: "Benutzer auswählen" }, ...(diagnostic?.users ?? []).filter((user) => !user.disabledAt).map((user) => ({ value: user.userId, label: `${user.displayName} · ${user.email}` }))]} />
          <button className="primary-button" disabled={assigning || !targetUserId} onClick={() => void assignUnownedData()}>
            {assigning ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{assigning ? "Zuweisen..." : "Zuweisen"}
          </button>
        </div>
      </div>}

      <div className="diagnostic-user-grid">
        {loading ? <div className="accounts-empty"><LoaderCircle className="spin" size={18} />Diagnosedaten lesen...</div> : (diagnostic?.users ?? []).map((user) => (
          <article className={`diagnostic-user-card ${user.disabledAt ? "disabled" : ""}`} key={user.userId}>
            <header>
              <div><strong>{user.displayName}</strong><span>{user.email}</span></div>
              <em>{user.disabledAt ? "Deaktiviert" : roleLabel(user.role)}</em>
            </header>
            <div className="diagnostic-counts">
              {diagnosticCoreCounts(user.counts).map(([key, count]) => <span key={key}><small>{diagnosticLabel(key)}</small><strong>{count}</strong></span>)}
            </div>
          </article>
        ))}
      </div>

      <div className="diagnostic-audit">
        <div className="diagnostic-audit-heading">
          <h3>Letzte Audit-Ereignisse</h3>
          {auditEvents.length > 10 && <button className="quiet-button" onClick={() => setShowAllAuditEvents((current) => !current)}>
            {showAllAuditEvents ? "Weniger anzeigen" : `Alle anzeigen ${auditEvents.length} Einträge`}
          </button>}
        </div>
        {visibleAuditEvents.length ? visibleAuditEvents.map((event) => (
          <article key={event.id}>
            <span>{auditActionLabel(event.action)}</span>
            <strong>{event.actorDisplayName ?? event.actorEmail ?? "System"}</strong>
            <small>{event.targetDisplayName || event.targetEmail ? `Ziel: ${event.targetDisplayName ?? event.targetEmail}` : "Kein Ziel"} · {formatAccountTime(event.createdAt)}</small>
          </article>
        )) : <div className="accounts-empty">kein Audit-Ereignisse zur Zeit</div>}
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
      if (!response.ok || !payload.ok || !payload.settings) throw new Error(payload.message || "Einstellungen für die automatische AI-Ausführung konnten nicht gelesen werden");
      setSettings(payload.settings);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Einstellungen für die automatische AI-Ausführung konnten nicht gelesen werden" });
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
      if (!response.ok || !payload.ok || !payload.settings) throw new Error(payload.message || "Einstellungen für die automatische AI-Ausführung konnten nicht gespeichert werden");
      setSettings(payload.settings);
      setFeedback({ kind: "success", message: "Einstellungen für die automatische AI-Ausführung gespeichert" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Einstellungen für die automatische AI-Ausführung konnten nicht gespeichert werden" });
    } finally {
      setSaving(false);
    }
  };

  const current = settings ?? { autoExecutionEnabled: false, highRiskAutoEnabled: false };
  return (
    <section className="ai-automation-settings panel">
      <div className="settings-section-heading">
        <h2>Automatische AI-Ausführung</h2>
      </div>
      <div className="ai-automation-grid">
        <label><input type="checkbox" checked={current.autoExecutionEnabled} disabled={saving} onChange={(event) => void save({ ...current, autoExecutionEnabled: event.target.checked, highRiskAutoEnabled: event.target.checked ? current.highRiskAutoEnabled : false })} /><span><strong>Automatische Schreibaktionen erlauben</strong><small>Erstellen Sie Aufgaben, Notizen, Kalenderereignisse und E-Mail-Entwurf.</small></span></label>
        <label><input type="checkbox" checked={current.highRiskAutoEnabled} disabled={saving || !current.autoExecutionEnabled} onChange={(event) => void save({ ...current, highRiskAutoEnabled: event.target.checked })} /><span><strong>Riskante externe Aktionen erlauben</strong><small>Aktionen wie E-Mails senden, archivieren, löschen oder verschieben.</small></span></label>
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
      if (!response.ok || !payload.ok || !payload.status) throw new Error(payload.message || "Sicherungsstatus kann nicht gelesen werden");
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
        setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Sicherungsstatus kann nicht gelesen werden" });
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
      setFeedback({ kind: "success", message: "Backup erstellt und Geschichte aktualisiert" });
      void refreshBackupStatus();
    } else if (event.status === "failed" || event.status === "cancelled") {
      setActiveBackupJobId(undefined);
      setFeedback({ kind: "error", message: event.status === "failed" ? "Backup-Erstellung fehlgeschlagen. Bitte sehen Sie sich das Protokoll im Taskcenter an" : "Sicherungsaufgabe abgebrochen" });
      void refreshBackupStatus();
    }
  });

  const createBackup = async () => {
    if (encryptBackup && backupPassword.length < 8) {
      setFeedback({ kind: "error", message: "Verschlüsselungs-Backup-Passwort erfordert mindestens 8 Zeichen" });
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
      if (!response.ok || !payload.ok || !payload.job) throw new Error(payload.message || "Sicherungsaufgabe kann nicht erstellt werden");
      setActiveBackupJobId(payload.job.id);
      setFeedback({ kind: "info", message: "Erstellen von Backups und automatische Aktualisierung des Verlaufs nach Abschluss" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Sicherungsaufgabe kann nicht erstellt werden" });
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
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Backup kann nicht hochgeladen werden");
      setFeedback({ kind: "success", message: "Backup-Datei hochgeladen und zum Verlauf hinzugefügt" });
      await loadStatus();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Backup kann nicht hochgeladen werden" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const restoreArtifact = async (artifact: BackupArtifactPayload) => {
    if (!await appConfirm({
      title: `Sicherung „${artifact.filename}“ wiederherstellen?`,
      description: "Das System erstellt zunächst ein sicheres Pre-Restoration-Backup und ersetzt dann die aktuelle Datenbank und Anhänge.",
      confirmLabel: "Sicherung wiederherstellen",
      tone: "danger",
    })) return;
    if (artifact.encrypted && backupPassword.length < 8) {
      setFeedback({ kind: "error", message: "das Backup-Passwort wird benötigt, um das Verschlüsselungs-Backup wiederherzustellen" });
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
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Wiederherstellungsaufgabe kann nicht erstellt werden");
      setFeedback({ kind: "success", message: "Wiederherstellungsauftrag erstellt. Den Fortschritt finden Sie im Aufgabencenter." });
      await loadStatus();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Wiederherstellungsaufgabe kann nicht erstellt werden" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const deleteArtifact = async (artifact: BackupArtifactPayload) => {
    if (!await appConfirm({
      title: `Sicherung „${artifact.filename}“ dauerhaft löschen?`,
      description: `Die Sicherungsdatei und der zugehörige Verlauf werden vom Server gelöscht. Dadurch werden ${formatFileSize(artifact.sizeBytes)} Speicherplatz freigegeben. Diese Aktion kann nicht rückgängig gemacht werden.`,
      confirmLabel: "Sicherung löschen",
      tone: "danger",
    })) return;
    setBusyBackupId(artifact.id);
    try {
      const response = await fetch(`/api/backups/${encodeURIComponent(artifact.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Backup kann nicht gelöscht werden");
      setFeedback({ kind: "success", message: "Backup-Dateien und historische Datensätze gelöscht" });
      await loadStatus();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Backup kann nicht gelöscht werden" });
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
      if (!response.ok || !payload.ok || !payload.settings) throw new Error(payload.message || "Autoback-Einstellungen können nicht gespeichert werden");
      setAutomaticDraft(payload.settings);
      setStatus((current) => current ? { ...current, automatic: payload.settings! } : current);
      setFeedback({ kind: "success", message: "Autoback-Einstellungen gespeichert" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Autoback-Einstellungen können nicht gespeichert werden" });
    } finally {
      setBusyBackupId(undefined);
    }
  };

  const strategy = status?.strategy;
  const toolsReady = Boolean(strategy?.tools.pgDump && strategy.tools.pgRestore && strategy.tools.tar);
  const backupOptions = strategy?.options ?? [{
    policy: "lightweight" as const,
    label: "leichter Arbeitsraum-Snapshot",
    description: "Backup-Datenbank und Entwurf Anhang.",
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
    ? `${mailCache.cachedBodies}/${mailCache.totalMessages} kodierter Text . ${formatFileSize(mailCache.cachedBodyBytes)}`
    : "—";
  const automatic = automaticDraft ?? status?.automatic;
  const artifactMenuItem = artifactMenu ? status?.artifacts?.find((artifact) => artifact.id === artifactMenu.id) : undefined;
  const artifactCommands: readonly ResolvedContextCommand[] = artifactMenuItem ? [
    { id: "backup.download", label: "Backup-Dateien herunterladen", group: "primary", risk: "read", icon: "download" },
    { id: "backup.copy-name", label: "Dateiname kopieren", group: "primary", risk: "read", icon: "copy" },
    { id: "backup.copy-checksum", label: "Kopieren von SHA256", group: "primary", risk: "read", icon: "info" },
    { id: "backup.restore", label: "Sicherung von diesem", group: "danger", risk: "destructive", icon: "restore" },
    { id: "backup.delete", label: "Sicherung dauerhaft löschen", group: "danger", risk: "destructive", icon: "trash" },
  ] : [];

  const openArtifactMenu = (event: ReactMouseEvent<HTMLElement>, artifact: BackupArtifactPayload) => {
    event.preventDefault();
    setArtifactMenu({ id: artifact.id, x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
  };

  const selectArtifactCommand = (commandId: ContextCommandId) => {
    if (!artifactMenuItem) return;
    if (commandId === "backup.download") window.open(`/api/backups/${encodeURIComponent(artifactMenuItem.id)}/download`, "_blank", "noopener,noreferrer");
    if (commandId === "backup.restore") void restoreArtifact(artifactMenuItem);
    if (commandId === "backup.copy-name") void copyText(artifactMenuItem.filename, "Dateinamen kopieren sichern", setFeedback);
    if (commandId === "backup.copy-checksum") void copyText(artifactMenuItem.checksumSha256, "SHA256 kopiert", setFeedback);
    if (commandId === "backup.delete") void deleteArtifact(artifactMenuItem);
  };

  return (
    <section className="backup-settings panel" aria-labelledby="backup-settings-title">
      <div className="settings-section-heading">
        <h2 id="backup-settings-title">Datensicherung</h2>
        <span className="step-badge">{loading ? "Überprüfung" : toolsReady ? "ausführbar" : "zu installierende Werkzeuge"}</span>
      </div>

      <div className="backup-summary" aria-label="aktuelles Datenprofil">
        <article><span><HardDrive size={17} /></span><div><small>Datenbankbelegung</small><strong>{loading ? "Berechnung..." : formatFileSize(status?.databaseBytes ?? 0)}</strong></div></article>
        <article title="Schätzungen basierend auf PostgreSQL komprimierten Dumps und Entwurf von Anhängen; Ergebnisse cache 5 Minuten, tatsächliche Dokumente können leicht variieren"><span><DatabaseBackup size={17} /></span><div><small>Erwartete Lichtunterstützung</small><strong>{loading ? "Schätzung..." : `Angleichung ${formatFileSize(status?.estimatedLightweightBytes ?? 0)}`}</strong></div></article>
        <article><span><Mail size={17} /></span><div><small>Mail-Cache (keine Sicherung)</small><strong>{loading ? "—" : mailCacheLabel}</strong></div></article>
        <article><span><Paperclip size={17} /></span><div><small>Anlageentwurf</small><strong>{loading ? "—" : `${status?.attachmentFiles ?? 0} Eins... ${formatFileSize(status?.attachmentBytes ?? 0)}`}</strong></div></article>
      </div>

      {availableBackupOptions.length > 1 && (
        <section className="backup-type-picker" aria-label="Art der Sicherung">
          <header><h3>Art der Sicherung</h3></header>
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
            <div><h3>Erstellen{selectedBackupOption ? backupPolicyLabel(selectedBackupOption.policy) : "Datensicherung"}</h3><p>speichert Workspace-Daten und Entwurf von Anhängen, re-records je nach Bedarf, nachdem der Mail-Körper wiederhergestellt wurde.</p></div>
          </header>
          <div className="backup-scope-summary" aria-label="Backup-Bereich">
            {compactCoverage.map((item) => {
              const included = item.id === "master-key" ? encryptBackup : item.included;
              return (
                <span key={item.id} className={included ? "included" : "excluded"}>
                  {included ? <Check size={12} /> : <Circle size={12} />}{item.label}
                </span>
              );
            })}
          </div>
          <div className="backup-create-controls">
            <label className="secure-toggle"><input type="checkbox" checked={encryptBackup} onChange={(event) => setEncryptBackup(event.target.checked)} /><span>Verschlüsselungssicherung</span></label>
            {encryptBackup && <input value={backupPassword} type="password" placeholder="Backup-Passwort eingeben (mindestens 8 Bit)" onChange={(event) => setBackupPassword(event.target.value)} />}
            <button className="primary-button" disabled={Boolean(busyBackupId) || !selectedPolicyAvailable || !toolsReady} onClick={() => void createBackup()}>{busyBackupId === "create" ? <LoaderCircle className="spin" size={14} /> : <DatabaseBackup size={14} />}Backup erstellen</button>
          </div>
          {!selectedPolicyAvailable && selectedBackupOption?.disabledReason && <small className="backup-risk">{selectedBackupOption.disabledReason}</small>}
          {!toolsReady && <small className="backup-risk">Dem Server fehlen Backup-Tools. Bitte füllen Sie zuerst die Konfiguration der Betriebsumgebung aus.</small>}
          {encryptBackup
            ? <small>UI-Text: Dieses Backup-Passwort ist alles, was Sie zur Wiederherstellung benötigen, und die Kontoverbindung ändert sich automatisch am Hauptschlüssel des Zielservers.</small>
            : <small className="backup-risk">Unverschlüsselte Backups führen keine migrationsfähigen Links; ein erneuter Eintrag von Kontopasswörtern ist erforderlich, nachdem der Server wiederhergestellt wurde.</small>}
        </article>
      </div>

      {automatic && (
        <div className="automatic-backup-card">
          <header>
            <div><h3>Automatisches Zurück</h3><p>Back-Office-Aufgaben erstellen serverhistorische Backups in Abständen und reinigen alte automatische Backups in reservierten Mengen.</p></div>
            <span className={automatic.enabled ? "ready" : ""}>{automatic.enabled ? "Aktiviert" : "ungeöffnet"}</span>
          </header>
          <div className="automatic-backup-controls">
            <label><input type="checkbox" checked={automatic.enabled} onChange={(event) => setAutomaticDraft({ ...automatic, enabled: event.target.checked })} /><span>automatische Sicherung Aktivieren</span></label>
            <label><span>Intervallstunden</span><input type="number" min={1} max={720} value={automatic.intervalHours} onChange={(event) => setAutomaticDraft({ ...automatic, intervalHours: Number(event.target.value) })} /></label>
            <label><span>Anzahl der aufbewahrten Exemplare</span><input type="number" min={1} max={365} value={automatic.retentionCount} onChange={(event) => setAutomaticDraft({ ...automatic, retentionCount: Number(event.target.value) })} /></label>
            <label><input type="checkbox" checked={automatic.encryptAutomatic} onChange={(event) => setAutomaticDraft({ ...automatic, encryptAutomatic: event.target.checked })} /><span>Autoback-Verschlüsselung</span></label>
            <button className="secondary-button" disabled={busyBackupId === "automatic"} onClick={() => void saveAutomaticSettings()}>{busyBackupId === "automatic" ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}Richtlinie speichern</button>
          </div>
          <footer>
            <small>nächste Umsetzung:{automatic.enabled && automatic.nextRunAt ? formatAccountTime(automatic.nextRunAt) : "nicht geplant"}</small>
            <small>vor kurzem abgeschlossen:{automatic.lastCompletedAt ? formatAccountTime(automatic.lastCompletedAt) : "nicht verfügbar"}</small>
            {automatic.encryptAutomatic && !automatic.encryptionPasswordConfigured && <small className="backup-risk">Die automatische Verschlüsselung erfordert Servereinstellungen für KARENDER_BANKUP_PASSWORD.</small>}
            {!automatic.encryptAutomatic && <small>Eine automatische Sicherung erfordert kein Backup-Passwort, wenn die Verschlüsselung nicht aktiviert ist.</small>}
          </footer>
        </div>
      )}

      <div className="backup-history">
        <div className="backup-history-heading">
          <h3>Sicherungshistorie</h3>
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
            {busyBackupId === "upload" ? <LoaderCircle className="spin" size={13} /> : <Upload size={13} />}Backup hochladen
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
            <div><strong>{artifact.filename}</strong><small>{backupPolicyLabel(artifact.mailPolicy ?? "lightweight")} · {artifact.source === "safety" ? "Sichere Sicherung vor der Wiederherstellung" : artifact.source === "upload" ? "Dateien hochladen" : "Server-Erstellung"} · {artifact.encrypted ? "verschlüsselt" : "unverschlüsselt"} · {formatAccountTime(artifact.createdAt)}</small></div>
            <span>{formatFileSize(artifact.sizeBytes)}</span>
            <a className="secondary-button" href={`/api/backups/${encodeURIComponent(artifact.id)}/download`}><Download size={13} />herunterladen</a>
            <button className="danger-confirm-button" disabled={Boolean(busyBackupId)} onClick={() => void restoreArtifact(artifact)}>{busyBackupId === artifact.id ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Wiederherstellung</button>
            <button className="ghost-button danger-button" disabled={Boolean(busyBackupId)} onClick={() => void deleteArtifact(artifact)}><Trash2 size={13} />Löschen</button>
          </article>
        )) : <div className="accounts-empty">Keine Sicherungshistorie</div>}
      </div>

      {feedback && <div className={`backup-feedback ${feedback.kind}`} role="status"><span>{feedback.message}</span><button aria-label="Schalten Sie den Hinweis aus" onClick={() => setFeedback(undefined)}><X size={13} /></button></div>}
      {artifactMenu && artifactMenuItem && (
        <ContextMenu
          anchor={{ x: artifactMenu.x, y: artifactMenu.y }}
          ariaLabel={`Sicherungsoperationen:${artifactMenuItem.filename}`}
          commands={artifactCommands}
          heading={artifactMenuItem.filename}
          returnFocus={artifactMenu.returnFocus}
          testId="backup-context-menu"
          onClose={() => setArtifactMenu(undefined)}
          onSelect={selectArtifactCommand}
        />
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
  if (policy === "configuration-only") return "Nur Sicherungskonfiguration";
  if (policy === "full-archive") return "vollständiges Archiv";
  return "Lichtunterstützung";
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
    setFeedback({ kind: "error", message: "Kopieren fehlgeschlagen, bitte Text manuell auswählen" });
  }
}

function jobFilterLabel(value: string): string {
  return { active: "aktiv", queued: "Warteschlange", running: "Aktiv", failed: "fehlgeschlagen", succeeded: "Erfolg", cancelled: "Abbrechen" }[value] ?? value;
}

function jobStatusLabel(value: string): string {
  return { queued: "Warteschlange", running: "Aktiv", succeeded: "Erfolg", failed: "fehlgeschlagen", cancelled: "Annulliert" }[value] ?? value;
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
    "backup.create": "Backup erstellen",
    "backup.restore": "Sicherung wiederherstellen",
    "mail.sync": "E-Mail synchronisieren",
    "calendar.sync": "Kalender synchronisieren",
    "ai.action": "KI-Maßnahmen",
    maintenance: "Wartung",
  }[value] ?? value;
}

function roleLabel(role: AppRole): string {
  return role === "admin" ? "Administrator" : role === "viewer" ? "Nur lesende Benutzer" : "Allgemeiner Benutzer";
}

function roleOptions() {
  return [
    { value: "user", label: "Allgemeiner Benutzer" },
    { value: "viewer", label: "Nur lesende Benutzer" },
    { value: "admin", label: "Administrator" },
  ];
}

function diagnosticLabel(key: string): string {
  return ({
    accounts: "E-Mail-Konten",
    calendar_accounts: "Kalenderkonten",
    exchange_connections: "Exchange",
    calendars: "Kalender",
    calendar_events: "Termin",
    projects: "Projekt",
    notes: "Notiz",
    tasks: "Aufgabe",
    entity_links: "Verknüpfung",
    mail_drafts: "Entwürfe",
    mail_signatures: "E-Mail-Signatur",
    mail_draft_attachments: "Anlageentwurf",
    mail_messages: "E-Mail",
    ai_providers: "AI Provider",
    ai_conversations: "KI-Dialog",
    ai_feature_bindings: "KI-Bindung",
    ai_messages: "KI-Nachrichten",
  } as Record<string, string>)[key] ?? key;
}

function diagnosticCoreCounts(counts: Readonly<Record<string, number>>): readonly [string, number][] {
  return ["accounts", "calendar_events", "projects", "tasks", "notes", "mail_messages", "ai_conversations"]
    .map((key) => [key, counts[key] ?? 0] as [string, number]);
}

function auditActionLabel(action: string): string {
  return ({
    "auth.login": "Anmelden",
    "user.create": "Benutzer erstellen",
    "user.update": "Benutzer aktualisieren",
    "user.profile.update": "Änderung der persönlichen Kontonummer",
    "workspace.assign-unowned": "Verteile historische Daten",
    "sync.settings.update": "Synchronisierungseinstellungen ändern",
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
  const [displayName, setDisplayName] = useState("Persönliches Mailkonto");
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
      if (!response.ok) throw new Error("Mailkonten konnten nicht geladen werden");
      setAccounts(result.accounts ?? []);
      if (typeof result.scheduler?.enabled === "boolean") setSyncEnabled(result.scheduler.enabled);
      if (result.scheduler?.intervalMs) setSyncIntervalMs(result.scheduler.intervalMs);
    } catch (error) {
      setAccountFeedback(error instanceof Error ? error.message : "Mailkonten konnten nicht geladen werden");
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
        ? `E-Mail-Verbindung „${account.displayName}“ entfernen?`
        : `Mailkonto „${account.displayName}“ löschen?`,
      description: account.providerId === "exchange-ews"
        ? "Der lokale Mail-Index wird gelöscht und die Kalenderverbindung und freigegebene Verschlüsselungsdateien werden beibehalten."
        : "Verschlüsselung, E-Mail-Index und Synchronisation des Kontos werden vom Server entfernt.",
      confirmLabel: account.providerId === "exchange-ews" ? "Verbindungen entfernen" : "Konto löschen",
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
      if (!response.ok || !result.ok) throw new Error(result.message ?? "Kontooperation fehlgeschlagen");
      await loadAccounts();
      setAccountFeedback(
        kind === "delete" ? `gestrichen ${account.displayName}`
          : kind === "pause" ? `Pausiert ${account.displayName}`
            : kind === "resume" ? `aktiviert ${account.displayName}`
              : `${account.displayName} Synchronisiert: Hinzugefügt/erfüllt ${result.sync?.messagesProcessed ?? 0} Versiegelung, korrigierter Zustand ${result.sync?.messagesReconciled ?? 0} Siegel, ungültigen Index entfernen ${result.sync?.messagesRemoved ?? 0} Versiegelung${(result.sync?.deepAuditRanges ?? 0) > 0 ? `eingehende Prüfung ${result.sync?.deepAuditRanges}ein alter E-Mail-Bereich` : ""}`,
      );
    } catch (error) {
      await loadAccounts();
      setAccountFeedback(error instanceof Error ? error.message : "Kontooperation fehlgeschlagen");
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
      if (!response.ok || !result.ok || !result.settings) throw new Error(result.message ?? "Kontokonfiguration kann nicht gelesen werden");
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
      setAccountFeedback("Die Konfiguration wird geladen. Das Passwort wird weiterhin mit dem ursprünglichen Passwort, das verschlüsselt wurde, leer sein; das neue Passwort wird als Ersatz eingegeben.");
      document.getElementById("add-mail-account")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setAccountFeedback(error instanceof Error ? error.message : "Kontokonfiguration kann nicht gelesen werden");
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
        throw new Error(result.message ?? "Verbindungstest fehlgeschlagen");
      }
      setState({
        kind: "success",
        message: result.message ?? "Erfolgreich Verbunden",
        latencyMs: result.latencyMs ?? 0,
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Verbindungstest fehlgeschlagen",
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
      if (!response.ok || !result.ok) throw new Error(result.message ?? "Konto konnte nicht gespeichert werden");
      setPassword("");
      setState({
        kind: "success",
        message: `Konto gespeichert, ${result.sync?.messagesProcessed ?? 0} E-Mails synchronisiert`,
        latencyMs: 0,
      });
      window.location.assign("/inbox");
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Konto konnte nicht gespeichert werden" });
      setSaving(false);
    }
  }

  return (<div className="account-settings-stack">
    <section className="saved-accounts panel" aria-labelledby="saved-accounts-title">
      <div className="settings-section-heading">
        <h2 id="saved-accounts-title">E-Mail-Konten</h2>
        <span className="step-badge">{accounts.length} {accounts.length === 1 ? "Konto" : "Konten"}</span>
      </div>
      {!online && (
        <div className="account-network-status" role="status">
          <WifiOff size={16} />
          <div><strong>Derzeit offline</strong><span>Gespeicherte E-Mails bleiben lesbar. Nach Wiederherstellung der Verbindung werden Status und Hintergrundsynchronisierung automatisch fortgesetzt.</span></div>
        </div>
      )}
      {accountsLoading ? (
        <div className="accounts-empty"><LoaderCircle className="spin" size={18} />Konten werden geladen…</div>
      ) : accounts.length === 0 ? (
        <div className="accounts-empty"><Mail size={20} /><div><strong>Noch kein Postfach verbunden</strong><span>Nach einem erfolgreichen Verbindungstest und dem Speichern wird das Konto hier angezeigt.</span></div></div>
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
                      Letzte Synchronisierung: {account.lastSyncAt ? formatAccountTime(account.lastSyncAt) : "Noch Noch nicht synchronisiert"}
                    </span>
                    <span>Automatisch: {syncEnabled ? `alle ${formatSyncInterval(syncIntervalMs)}` : "Deaktiviert"}</span>
                  </div>
                  {account.syncStatus === "syncing" && account.latestSyncRun?.status === "running" && (
                    <p className="account-sync-progress" aria-live="polite">
                      Hintergrundsynchronisierung… {account.latestSyncRun.foldersProcessed} Ordner · {account.latestSyncRun.messagesProcessed} E-Mails
                    </p>
                  )}
                  {account.syncError && <p className="account-sync-error">{account.syncError}</p>}
                  <div className="saved-account-actions">
                    <button className="secondary-button" disabled={!online || busy || account.syncStatus === "paused" || syncing} onClick={() => void performAccountAction(account, "sync")}>
                      {busy && accountAction?.kind === "sync" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Jetzt synchronisieren
                    </button>
                    <button className="ghost-button" disabled={busy || syncing} onClick={() => void editAccount(account)}><Pencil size={14} />{account.providerId === "exchange-ews" ? "Exchange verwalten" : "Rekonfigurieren"}</button>
                    <button className="ghost-button" disabled={busy || syncing} onClick={() => void performAccountAction(account, account.syncStatus === "paused" ? "resume" : "pause")}>
                      {account.syncStatus === "paused" ? <Play size={14} /> : <Pause size={14} />}{account.syncStatus === "paused" ? "Fortsetzen" : "Pausieren"}
                    </button>
                    <button className="ghost-button danger-button" disabled={busy || syncing} onClick={() => void performAccountAction(account, "delete")}><Trash2 size={14} />Löschen</button>
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
        <span><strong>{editingAccountId ? "Postfach neu konfigurieren" : "Postfach hinzufügen"}</strong><small>IMAP / SMTP</small></span>
        <ChevronDown size={16} />
      </summary>
      <div className="account-settings-body">
        {editingAccountId && <p className="settings-inline-note">Lassen Sie das Passwort leer, um das bisherige Passwort beizubehalten.</p>}
        <div className="account-form">
        <label><span>Kontoname</span><input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setState({ kind: "idle" }); }} placeholder="z.B. Arbeitspostfach" /></label>
        <label><span>E-Mail-Adresse</span><input type="email" value={emailAddress} onChange={(event) => { setEmailAddress(event.target.value); setState({ kind: "idle" }); }} placeholder="name@example.com" /></label>
        <label><span>IMAP-Server</span><input value={imapHost} onChange={(event) => { setImapHost(event.target.value); setState({ kind: "idle" }); }} placeholder="imap.example.com" /></label>
        <label><span>Port</span><input inputMode="numeric" value={imapPort} onChange={(event) => { setImapPort(event.target.value); setState({ kind: "idle" }); }} /></label>
        <label><span>SMTP-Server</span><input value={smtpHost} onChange={(event) => { setSmtpHost(event.target.value); setState({ kind: "idle" }); }} placeholder="smtp.example.com" /></label>
        <label><span>Port</span><input inputMode="numeric" value={smtpPort} onChange={(event) => { setSmtpPort(event.target.value); setState({ kind: "idle" }); }} /></label>
        <label><span>Benutzername</span><input value={username} onChange={(event) => { setUsername(event.target.value); setState({ kind: "idle" }); }} autoComplete="username" /></label>
        <label><span>Passwort oder App-Passwort</span><input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setState({ kind: "idle" }); }} autoComplete="new-password" placeholder={editingAccountId ? "Leer lassen, um das bisherige Passwort beizubehalten" : undefined} /></label>
        <label className="secure-toggle"><input type="checkbox" checked={imapSecure} onChange={(event) => { setImapSecure(event.target.checked); setState({ kind: "idle" }); }} /><span>IMAP verwendet direktes TLS (normalerweise Port 993)</span></label>
        <label className="secure-toggle"><input type="checkbox" checked={smtpSecure} onChange={(event) => { setSmtpSecure(event.target.checked); setState({ kind: "idle" }); }} /><span>SMTP verwendet direktes TLS (normalerweise Port 465; für Port 587 deaktivieren)</span></label>
        </div>
        <div className="sync-mode-picker">
        <span>{editingAccountId ? "Synchronisierungszeitraum" : "Erster Synchronisierungszeitraum"}</span>
        <div>
          {([
            ["quick", "Schnell", "Letzte 30 Tage"],
            ["recommended", "empfohlen", "Letzte 90 Tage"],
            ["full", "vollständig", "Gesamten Verlauf im Hintergrund nachladen"],
          ] as const).map(([id, label, detail]) => (
            <button className={syncMode === id ? "active" : ""} key={id} onClick={() => { setSyncMode(id); setState({ kind: "idle" }); }}>
              <strong>{label}</strong><small>{detail}</small>
            </button>
          ))}
        </div>
        </div>
        <div className={`connection-result result-${state.kind}`} aria-live="polite">
        {state.kind === "idle" && <><Circle size={17} /><span>Noch nicht getestet. Das Konto kann erst nach einem erfolgreichen Test gespeichert werden.</span></>}
        {state.kind === "testing" && <><LoaderCircle className="spin" size={17} /><span>Anmeldedaten und Leseberechtigungen werden geprüft…</span></>}
        {state.kind === "success" && <><CheckCircle2 size={17} /><span>{state.message} · {state.latencyMs} ms</span></>}
        {state.kind === "error" && <><X size={17} /><span>{state.message}</span></>}
        </div>
        <footer className="settings-actions">
        <button className="secondary-button test-button" disabled={!online || !canTest || state.kind === "testing"} onClick={testConnection}>
          {state.kind === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}Verbindung testen
        </button>
        <button className="primary-button" disabled={!online || state.kind !== "success" || saving} onClick={saveAccount}>
          {saving && <LoaderCircle className="spin" size={16} />}{saving ? "Wird gespeichert und synchronisiert…" : "Speichern und synchronisieren"}
        </button>
        </footer>
        <p className="settings-footnote">Die Zugangsdaten werden verschlüsselt gespeichert. Exchange/RWTH wird zentral unter „Kalenderkonten“ verbunden.</p>
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
  const [displayName, setDisplayName] = useState("Persönlicher Kalender");
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
      if (!response.ok) throw new Error(payload.message || "Kalenderkonto kann nicht gelesen werden");
      setAccounts(payload.accounts ?? []);
      if (typeof payload.scheduler?.enabled === "boolean") setSyncEnabled(payload.scheduler.enabled);
      if (payload.scheduler?.intervalMs) setSyncIntervalMs(payload.scheduler.intervalMs);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Kalenderkonto kann nicht gelesen werden");
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
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Kalenderverbindungstest fehlgeschlagen");
      setState({ kind: "success", message: payload.message || "Kalender erfolgreich verbunden", latencyMs: payload.latencyMs ?? 0 });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Kalenderverbindungstest fehlgeschlagen" });
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
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Kalenderkonto kann nicht gespeichert werden");
      setPassword("");
      if (providerId === "ics") setFeedUrl("");
      setState({
        kind: "success",
        message: providerId === "exchange"
          ? `Exchange-Konto gespeichert: ${payload.sync?.eventsProcessed ?? 0} Termine · ${payload.mailSync?.messagesProcessed ?? 0} E-Mails`
          : `Konto gespeichert: ${payload.sync?.calendarsProcessed ?? 0} Kalender · ${payload.sync?.eventsProcessed ?? 0} Termine`,
        latencyMs: 0,
      });
      await loadAccounts();
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Kalenderkonto kann nicht gespeichert werden" });
    } finally {
      setSaving(false);
    }
  };

  const performAction = async (account: SavedCalendarAccount, kind: "sync" | "delete") => {
    if (kind === "delete" && !await appConfirm({
      title: `Kalenderkonto „${account.displayName}“ löschen?`,
      description: "Verschlüsselte Zugangsdaten und der lokale Kalenderindex werden von diesem Gerät entfernt. Der entfernte Kalender bleibt unverändert.",
      confirmLabel: "Konto löschen",
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
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Kalenderkonto-Aktion fehlgeschlagen");
      await loadAccounts();
      setFeedback(kind === "delete"
        ? `Lokale Verbindung zu „${account.displayName}“ gelöscht; entfernte Daten bleiben unverändert`
        : `${account.displayName} synchronisiert: ${payload.sync?.calendarsProcessed ?? 0} Kalender · ${payload.sync?.eventsProcessed ?? 0} Termine`);
    } catch (error) {
      await loadAccounts();
      setFeedback(error instanceof Error ? error.message : "Kalenderkonto-Aktion fehlgeschlagen");
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
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Kalender-Kontoeinstellungen können nicht gespeichert werden");
      const savedName = editingAccount.displayName.trim();
      setEditingAccount(undefined);
      await loadAccounts();
      setFeedback(`Name und Kalenderfarbe von „${savedName}“ aktualisiert`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Kalender-Kontoeinstellungen können nicht gespeichert werden");
    } finally {
      setAccountAction(undefined);
    }
  };

  return (
    <section className="calendar-account-settings panel" aria-labelledby="calendar-accounts-title">
      <div className="settings-section-heading">
        <h2 id="calendar-accounts-title">Kalenderkonten</h2>
      </div>
      <div className="calendar-account-layout">
        <div className="calendar-provider-options" role="radiogroup" aria-label="Kalender-Verbindungstyp">
          <button className={providerId === "caldav" ? "active" : ""} role="radio" aria-checked={providerId === "caldav"} onClick={() => { setProviderId("caldav"); resetTest(); }}>
            <strong>CalDAV-Konto</strong><span>Server, Benutzername und Passwort</span>
          </button>
          <button className={providerId === "exchange" ? "active" : ""} role="radio" aria-checked={providerId === "exchange"} onClick={() => { setProviderId("exchange"); setServerUrl("https://mail.rwth-aachen.de/EWS/Exchange.asmx"); resetTest(); }}>
            <strong>Exchange / RWTH</strong><span>Ein Konto verbindet E-Mail und Kalender</span>
          </button>
          <button className={providerId === "ics" ? "active" : ""} role="radio" aria-checked={providerId === "ics"} onClick={() => { setProviderId("ics"); resetTest(); }}>
            <strong>ICS-Link abonnieren</strong><span>Outlook, Hochschule oder öffentlicher Kalender</span>
          </button>
        </div>
        <div className="calendar-account-form">
          <label><span>Kontoname</span><input value={displayName} onChange={(event) => { setDisplayName(event.target.value); resetTest(); }} placeholder="z.B. Arbeitskalender" /></label>
          {providerId === "ics" ? (
            <label><span>ICS-Abonnementlink</span><input type="url" value={feedUrl} onChange={(event) => { setFeedUrl(event.target.value); resetTest(); }} placeholder="https://example.com/calendar.ics" autoComplete="off" /></label>
          ) : <>
            <label><span>{providerId === "exchange" ? "Exchange-EWS-Dienstadresse" : "CalDAV-Serveradresse"}</span><input type="url" value={serverUrl} onChange={(event) => { setServerUrl(event.target.value); resetTest(); }} placeholder={providerId === "exchange" ? "https://mail.rwth-aachen.de/EWS/Exchange.asmx" : "https://calendar.example.com/dav/"} /></label>
            <label><span>{providerId === "exchange" ? "RWTH-E-Mail-Benutzername" : "Benutzername"}</span><input value={username} onChange={(event) => { setUsername(event.target.value); resetTest(); }} placeholder={providerId === "exchange" ? "ab123456@rwth-aachen.de" : undefined} autoComplete="username" /></label>
            {providerId === "exchange" && <label><span>Offizielle E-Mail-Adresse (Senden/Empfangen)</span><input type="email" value={exchangeEmailAddress} onChange={(event) => { setExchangeEmailAddress(event.target.value); resetTest(); }} placeholder="name@institute.rwth-aachen.de" autoComplete="email" /></label>}
            <label><span>{providerId === "exchange" ? "RWTH-E-Mail-Passwort" : "Passwort oder App-Passwort"}</span><input type="password" value={password} onChange={(event) => { setPassword(event.target.value); resetTest(); }} autoComplete="current-password" /></label>
          </>}
        </div>
        <div className={`connection-result result-${state.kind}`} aria-live="polite">
          {state.kind === "idle" && <><Circle size={17} /><span>Noch nicht getestet. Der Test liest nur Kontofunktionen und verändert keine entfernten Inhalte.</span></>}
          {state.kind === "testing" && <><LoaderCircle className="spin" size={17} /><span>{providerId === "ics" ? "ICS-Kalender wird heruntergeladen und geprüft…" : providerId === "exchange" ? "Exchange-Postfach und Standardkalender werden geprüft…" : "CalDAV-Anmeldedaten und Kalender-Leseberechtigungen werden geprüft…"}</span></>}
          {state.kind === "success" && <><CheckCircle2 size={17} /><span>{state.message}{state.latencyMs ? ` · ${state.latencyMs} ms` : ""}</span></>}
          {state.kind === "error" && <><X size={17} /><span>{state.message}</span></>}
        </div>
        <div className="settings-actions">
          <button className="secondary-button test-button" disabled={!canTest || state.kind === "testing"} onClick={() => void testConnection()}>
            {state.kind === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}Verbindung testen
          </button>
          <button className="primary-button" disabled={state.kind !== "success" || saving} onClick={() => void saveAccount()}>
            {saving && <LoaderCircle className="spin" size={16} />}{saving ? "Wird gespeichert und synchronisiert…" : "Speichern und synchronisieren"}
          </button>
        </div>
      </div>

      <div className="calendar-account-list">
        <div className="calendar-account-list-heading"><strong>Verbundene Kalenderkonten</strong><span>{accounts.length} Konten</span></div>
        {loading ? (
          <div className="accounts-empty"><LoaderCircle className="spin" size={18} />Kalenderkonten werden geladen…</div>
        ) : accounts.length === 0 ? (
          <div className="accounts-empty"><CalendarDays size={20} /><div><strong>Noch kein entfernter Kalender verbunden</strong><span>Nach erfolgreichem Test und Speichern erscheint der entfernte Kalender in der Wochen- und Monatsansicht.</span></div></div>
        ) : accounts.map((account) => {
          const busy = accountAction?.id === account.id;
          const isEditing = editingAccount?.id === account.id;
          return (
            <article className="saved-account-card" key={account.id}>
              <div className="saved-account-color" style={{ background: isEditing ? editingAccount.color : account.color }} />
              <div className="saved-account-main">
                <div className="saved-account-title">
                  <div><strong>{account.displayName}</strong><span>{account.providerId === "ics" ? "Link-Abonnement" : account.providerId === "exchange" ? `${account.emailAddress || account.username} · Anmeldung: ${account.username}` : account.username}</span></div>
                  <span className={`sync-status sync-status-${account.syncStatus}`}>{account.syncStatus === "syncing" && <LoaderCircle className="spin" size={12} />}{accountStatusLabel(account.syncStatus)}</span>
                </div>
                <div className="saved-account-meta"><span>{account.providerId === "ics" ? "ICS-Abonnement · Schreibgeschützt" : account.providerId === "exchange" ? `Exchange / RWTH · ${[account.mailEnabled && "E-Mail", account.calendarEnabled && "Kalender"].filter(Boolean).join(" + ") || "Pausiert"}` : "CalDAV · Schreibgeschützt"}</span><span>{account.calendarsCount} Kalender</span><span>Letzte Synchronisierung: {account.lastSyncAt ? formatAccountTime(account.lastSyncAt) : "Noch nicht synchronisiert"}</span><span>Automatisch: {syncEnabled ? `alle ${formatSyncInterval(syncIntervalMs)}` : "Deaktiviert"}</span></div>
                {account.providerId === "exchange" && account.mailEnabled && (
                  <div className="saved-account-meta">
                    <span>E-Mail:{accountStatusLabel(account.mailSyncStatus ?? "idle")}</span>
                    <span>Verlauf nachgeladen: {account.mailHistoryFoldersComplete}/{account.mailHistoryFoldersTotal || 5} Ordner</span>
                    <span>E-Mail-Synchronisierung: {account.mailLastSyncAt ? formatAccountTime(account.mailLastSyncAt) : "Noch nicht synchronisiert"}</span>
                  </div>
                )}
                <small className="calendar-server-url" title={account.serverUrl}>{account.serverUrl}</small>
                {account.syncError && <p className="account-sync-error">{account.syncError}</p>}
                {isEditing && (
                  <div className="calendar-account-editor">
                    <label><span>Kontoname</span><input value={editingAccount.displayName} maxLength={80} onChange={(event) => setEditingAccount({ ...editingAccount, displayName: event.target.value })} /></label>
                    {account.providerId === "exchange" && <label><span>Offizielle E-Mail-Adresse</span><input type="email" value={editingAccount.emailAddress} onChange={(event) => setEditingAccount({ ...editingAccount, emailAddress: event.target.value })} /></label>}
                    <fieldset>
                      <legend>Kalenderfarbe</legend>
                      <div className="calendar-color-options">
                        {calendarAccountColors.map((color) => (
                          <button
                            type="button"
                            key={color}
                            className={editingAccount.color === color ? "active" : ""}
                            style={{ background: color }}
                            aria-label={`Farbe auswählen ${color}`}
                            aria-pressed={editingAccount.color === color}
                            onClick={() => setEditingAccount({ ...editingAccount, color })}
                          >{editingAccount.color === color && <Check size={13} />}</button>
                        ))}
                        <label className="calendar-custom-color" title="Benutzerdefinierte Farbe">
                          <input type="color" value={editingAccount.color} aria-label="Benutzerdefinierte Farbe auswählen" onChange={(event) => setEditingAccount({ ...editingAccount, color: event.target.value })} />
                          <span>Benutzerdefiniert</span>
                        </label>
                      </div>
                    </fieldset>
                    {account.providerId === "exchange" && <fieldset>
                      <legend>Exchange-Funktionen</legend>
                      <div className="calendar-exchange-feature-toggles">
                        <label><input type="checkbox" checked={editingAccount.mailEnabled} onChange={(event) => setEditingAccount({ ...editingAccount, mailEnabled: event.target.checked })} /><span>E-Mail synchronisieren</span></label>
                        <label><input type="checkbox" checked={editingAccount.calendarEnabled} onChange={(event) => setEditingAccount({ ...editingAccount, calendarEnabled: event.target.checked })} /><span>Kalender synchronisieren</span></label>
                      </div>
                    </fieldset>}
                  </div>
                )}
                <div className="saved-account-actions">
                  {isEditing ? <>
                    <button className="primary-button" disabled={busy || !editingAccount.displayName.trim() || (account.providerId === "exchange" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editingAccount.emailAddress))} onClick={() => void saveAccountSettings()}>{busy && accountAction?.kind === "update" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Speichern</button>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditingAccount(undefined)}>Abbrechen</button>
                  </> : <>
                    <button className="secondary-button" disabled={busy} onClick={() => void performAction(account, "sync")}>{busy && accountAction?.kind === "sync" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Jetzt synchronisieren</button>
                    <button className="ghost-button" disabled={busy} onClick={() => setEditingAccount({ id: account.id, displayName: account.displayName, color: account.color, emailAddress: account.emailAddress || account.username, mailEnabled: account.mailEnabled, calendarEnabled: account.calendarEnabled })}><Pencil size={14} />Bearbeiten</button>
                    <button className="ghost-button danger-button" disabled={busy} onClick={() => void performAction(account, "delete")}><Trash2 size={14} />Lokale Verbindung löschen</button>
                  </>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {feedback && <TransientToast message={feedback} onClose={() => setFeedback("")} />}
      <p className="settings-footnote">CalDAV und ICS sind schreibgeschützt; Exchange-Zugangsdaten werden verschlüsselt gespeichert. Besprechungseinladungen und Serientermine müssen im ursprünglichen Dienst geändert werden.</p>
    </section>
  );
}

function accountStatusLabel(status: AccountSyncStatus): string {
  return { idle: "Ausstehend", syncing: "Synchronisierung läuft", ready: "Bereit", error: "Aktion erforderlich", paused: "Pausiert" }[status];
}

function syncModeLabel(mode: AccountSyncMode): string {
  return { quick: "Letzte 30 Tage", recommended: "Letzte 90 Tage", full: "Gesamter Verlauf" }[mode];
}

function formatAccountTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unbekannte Zeit";
  return new Intl.DateTimeFormat("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSyncInterval(intervalMs: number): string {
  const minutes = Math.max(1, Math.round(intervalMs / 60_000));
  return minutes < 60 ? `${minutes} Minuten` : `${Math.round(minutes / 60)} Stunden`;
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
        <AssistantHeader title={title} subtitle="Kontext-Assistent" onClose={onClose} />
        <section className="assistant-empty-state">
          <EmptyIcon size={22} />
          <h3>die aktuelle Seite wird nicht empfohlen</h3>
          <p>Dieses Modul wurde nicht mit dem realen{section === "calendar" ? "Termin" : "Aufgabe"}context, so dass keine Operation generiert oder ausgeführt wird.</p>
        </section>
      </aside>
    );
  }

  return (
    <aside className="assistant-panel context-assistant-panel" aria-label={title}>
      <AssistantHeader title={title} subtitle="aktueller Mail-Kontext" onClose={onClose} />
      {!mailSnapshot || mailSnapshot.loading ? (
        <section className="assistant-empty-state" role="status">
          <LoaderCircle className="spin" size={21} />
          <h3>E-Mail-Kontext lesen</h3>
        </section>
      ) : !mailSnapshot.hasAccounts ? (
        <section className="assistant-empty-state">
          <Mail size={22} />
          <h3>Kein Mailkonto verbunden</h3>
          <p>Der Assistent kann E-Mail-Inhalte erst analysieren, wenn ein Mailkonto verbunden ist.</p>
          <Link className="secondary-button" href="/settings?tab=mail">Mailkonto verbinden</Link>
        </section>
      ) : !selectedMessage ? (
        <section className="assistant-empty-state">
          <Mail size={22} />
          <h3>eine E-Mail auswählen</h3>
          <p>Wählen Sie E-Mail, um eine Zusammenfassung zu generieren, extrahieren Sie einen Aktionspunkt oder bereiten Sie einen Antwortentwurf vor.</p>
        </section>
      ) : (
        <>
          <section className="assistant-context-source">
            <span>aktuelle E-Mail</span>
            <h3>{selectedMessage.subject}</h3>
            <p>{selectedMessage.sender} &lt;{selectedMessage.senderAddress}&gt;</p>
            <small>{selectedMessage.accountName} · {formatAssistantMailTime(selectedMessage.receivedAt)}</small>
          </section>

          <section className="assistant-mail-actions" aria-label="E-Mail-KI-Betrieb">
            <button disabled={Boolean(mailSnapshot.aiBusy)} onClick={() => sendCommand({ type: "mail.run-ai", action: "summarize" })}>
              {mailSnapshot.aiBusy === "summarize" ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              <span><strong>Zusammenfassung erstellen</strong><small>summarische Anfrage, Datum und Risiko</small></span>
            </button>
            <button disabled={Boolean(mailSnapshot.aiBusy)} onClick={() => sendCommand({ type: "mail.run-ai", action: "extract-actions" })}>
              {mailSnapshot.aiBusy === "extract-actions" ? <LoaderCircle className="spin" size={16} /> : <ListChecks size={16} />}
              <span><strong>Aktionspunkte extrahieren</strong><small>Identifizierung der verantwortlichen Personen und Fristen</small></span>
            </button>
            <button disabled={Boolean(mailSnapshot.aiBusy)} onClick={() => sendCommand({ type: "mail.run-ai", action: "draft-reply" })}>
              {mailSnapshot.aiBusy === "draft-reply" ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
              <span><strong>Vorbereitung des Entwurfs von Antworten</strong><small>muss nach der Generierung noch manuell überprüft und gesendet werden</small></span>
            </button>
          </section>

          {result && <section className="assistant-ai-result" aria-live="polite">
            <header>
              <div><Sparkles size={15} /><strong>{result.action === "summarize" ? "Zusammenfassung der AI" : result.action === "extract-actions" ? "KI-Aktionspunkt" : "Entwurf einer KI-Antwort"}</strong></div>
              <button type="button" aria-label="Enges AI-Ergebnis" title="Enges AI-Ergebnis" onClick={() => sendCommand({ type: "mail.clear-result" })}><X size={14} /></button>
            </header>
            <small>{result.modelName}{result.usedFallback ? " · Back-up-Modell wurde verwendet" : ""}</small>
            <div>{result.text}</div>
          </section>}

          {mailSnapshot.notice && <div className="assistant-notice" role="status">{mailSnapshot.notice}</div>}

          <section className="assistant-write-action">
            <header><CheckCircle2 size={16} /><strong>assoziiert mit der Aufgabe</strong></header>
            <p>Erstellt die Aufgabe, die mit dem E-Mail-Theme sortiert werden soll und behält den Link zurück zur ursprünglichen E-Mail.</p>
            {confirmTask ? <div className="assistant-confirm-row">
              <button className="primary-button" disabled={mailSnapshot.actionBusy} onClick={() => {
                sendCommand({ type: "mail.create-task" });
                setConfirmTask(false);
              }}>{mailSnapshot.actionBusy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Bestätigung der Gründung</button>
              <button className="ghost-button" disabled={mailSnapshot.actionBusy} onClick={() => setConfirmTask(false)}>Abbrechen</button>
            </div> : <button className="secondary-button" disabled={mailSnapshot.actionBusy} onClick={() => setConfirmTask(true)}><Plus size={14} />Assoziationsaufgaben erstellen</button>}
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
    <button className="assistant-close" type="button" aria-label="Kontext-Assistent zum Drop" title="Kontext-Assistent zum Drop" onClick={onClose}><X size={16} /></button>
  </header>;
}

function formatAssistantMailTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unbekannte Zeit";
  return new Intl.DateTimeFormat("de-DE", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
