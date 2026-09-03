"use client";

import Link from "next/link";
import {
  AlertCircle, Archive, ArrowRight, Award, CalendarClock, CalendarDays, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Circle, FileText, Folder, FolderPlus, GripVertical, Link2, ListChecks,
  LoaderCircle, Mail, MoreHorizontal, NotebookPen, Pencil, Pin, Plus,
  Pause, Star, Trash2, X,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { appConfirm } from "@/components/app-dialog-provider";
import { useRealtimeRefresh } from "@/components/realtime-context";
import { useVisiblePageRefresh } from "@/hooks/use-visible-page-refresh";
import { AppSelect } from "../app-select";
import { ContextMenu } from "../context-menu";
import {
  resolveContextCommands,
  type ContextCommandId,
  type ProjectTimelineCommandId,
  type ResolvedContextCommand,
} from "../context-commands";
import { DateTimeField } from "../ui/date-time-field";
import { TransientToast } from "../workspace-shared";
import { offerToCompleteLinkedPlanItem } from "./project-plan-progress";
import { TaskEditorDialog } from "./task-editor-dialog";
import { TaskScheduleDialog } from "./task-schedule-dialog";

const TASKS_CHANGED_EVENT = "kalender:tasks-changed";
const PROJECTS_CHANGED_EVENT = "kalender:projects-changed";
const OPEN_PROJECT_DIALOG_EVENT = "kalender:open-project-dialog";
const EDIT_PROJECT_DIALOG_EVENT = "kalender:edit-project-dialog";

type TaskStatus = "inbox" | "next" | "waiting" | "someday" | "done";
type ProjectPlanItemStatus = "planned" | "in_progress" | "paused" | "done" | "cancelled";
type TaskUrgencyMode = "auto" | "urgent" | "not_urgent";

interface ClientTaskSource {
  readonly id: string;
  readonly kind: "mail" | "calendar" | "note";
  readonly sourceId: string;
  readonly label: string;
  readonly href?: string;
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
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
  readonly planItemId?: string;
  readonly planItemTitle?: string;
  readonly areaName?: string;
  readonly assigneeUserId?: string;
  readonly assigneeDisplayName?: string;
  readonly assigneeEmail?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceReferences: readonly ClientTaskSource[];
  readonly scheduledBlockCount: number;
  readonly scheduledBlocks: readonly ClientTaskTimeBlock[];
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

function formatProjectPlanItemStatus(status: ProjectPlanItemStatus): string {
  switch (status) {
    case "planned": return "待开始";
    case "in_progress": return "进行中";
    case "paused": return "已暂停";
    case "done": return "已完成";
    case "cancelled": return "已取消";
  }
}

function formatTaskStatus(status: TaskStatus): string {
  switch (status) {
    case "inbox": return "收集箱";
    case "next": return "下一步";
    case "waiting": return "等待中";
    case "someday": return "将来/也许";
    case "done": return "已完成";
  }
}

function formatNoteUpdated(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
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
  readonly sortOrder: number;
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

interface ClientProjectScheduledBlock extends ClientTaskTimeBlock {
  readonly taskId: string;
  readonly taskTitle: string;
}

interface ClientProjectOverview {
  readonly project: ClientProject;
  readonly tasks: readonly ClientTask[];
  readonly planItems: readonly ClientProjectPlanItem[];
  readonly notes: readonly ClientNote[];
  readonly milestones: readonly ClientProjectMilestone[];
  readonly phases: readonly ClientProjectPhase[];
  readonly scheduledBlocks: readonly ClientProjectScheduledBlock[];
  readonly stats: {
    readonly totalTaskCount: number;
    readonly openTaskCount: number;
    readonly completedTaskCount: number;
    readonly completionPercent: number;
    readonly noteCount: number;
    readonly scheduledMinutes: number;
  };
  readonly review: {
    readonly completedLast7DaysCount: number;
    readonly overdueTaskCount: number;
    readonly dueNext7DaysCount: number;
    readonly unscheduledOpenTaskCount: number;
    readonly lastActivityAt: string;
    readonly isStalled: boolean;
  };
}

interface ClientProjectMember {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly accessLevel: "viewer" | "editor";
}

interface ClientCollaborator {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

interface ClientProjectPlanItem {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId?: string;
  readonly title: string;
  readonly status: ProjectPlanItemStatus;
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly sortOrder: number;
  readonly durationWorkdays?: number;
  readonly autoSchedule: boolean;
  readonly dependencyIds: readonly string[];
  readonly linkedTaskCount: number;
  readonly completedTaskCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ClientProjectPhase {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly color: string;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ClientProjectMilestone {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId?: string;
  readonly title: string;
  readonly dueOn?: string;
  readonly status: "planned" | "active" | "done";
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectManagementDraft extends ProjectDraft {
  readonly id?: string;
  readonly status: "active" | "archived";
}

interface ProjectMilestoneDraft {
  readonly id?: string;
  readonly phaseId: string;
  readonly title: string;
  readonly dueOn: string;
  readonly status: ClientProjectMilestone["status"];
}

interface ProjectPlanItemDraft {
  readonly planItemId: string;
  readonly title: string;
  readonly status: ProjectPlanItemStatus;
  readonly plannedStart: string;
  readonly plannedEnd: string;
  readonly dependencyIds: readonly string[];
  readonly phaseId: string;
  readonly durationWorkdays: number;
  readonly autoSchedule: boolean;
}

interface ProjectPhaseDraft {
  readonly id?: string;
  readonly name: string;
  readonly color: string;
  readonly sortOrder: number;
}

interface ProjectPlanItemCreateDraft {
  readonly title: string;
  readonly phaseId: string;
  readonly plannedStart: string;
  readonly durationWorkdays: number;
  readonly insertAfterPlanItemId?: string;
}

interface ProjectTaskEditDraft {
  readonly id: string;
  readonly sourceReferences: readonly ClientTaskSource[];
  title: string;
  notes: string;
  status: TaskStatus;
  important: boolean;
  urgencyMode: TaskUrgencyMode;
  dueAt: string;
  estimatedMinutes: string;
  projectId: string;
  planItemId: string;
  projectName: string;
  areaName: string;
  assigneeUserId: string;
}

interface ProjectTaskScheduleTarget {
  readonly task: ClientTask;
  readonly block?: ClientTaskTimeBlock;
  readonly returnTaskDraft?: ProjectTaskEditDraft;
}

interface ProjectTimelineReorderInput {
  readonly kind: "planItem" | "milestone";
  readonly itemId: string;
  readonly phaseId?: string;
  readonly beforeId?: string;
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

async function readProjectApiResponse<T extends object>(response: Response, fallbackMessage: string): Promise<T> {
  const responseText = await response.text();
  if (!responseText.trim()) {
    if (!response.ok) throw new Error(`${fallbackMessage}（HTTP ${response.status}）`);
    return {} as T;
  }
  try {
    return JSON.parse(responseText) as T;
  } catch {
    const status = response.status ? `HTTP ${response.status}` : "未知状态";
    throw new Error(`${fallbackMessage}：服务器返回了无法识别的响应（${status}）`);
  }
}

function toLocalDateTimeInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function projectTaskToEditDraft(task: ClientTask): ProjectTaskEditDraft {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes ?? "",
    status: task.status,
    important: task.important,
    urgencyMode: task.urgencyMode,
    dueAt: task.dueAt ? toLocalDateTimeInput(new Date(task.dueAt)) : "",
    estimatedMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : "",
    projectId: task.projectId ?? "",
    planItemId: task.planItemId ?? "",
    projectName: task.projectName ?? "",
    areaName: task.areaName ?? "",
    assigneeUserId: task.assigneeUserId ?? "",
    sourceReferences: task.sourceReferences,
  };
}

function projectTaskEditPayload(draft: ProjectTaskEditDraft) {
  return {
    title: draft.title,
    notes: draft.notes || undefined,
    status: draft.status,
    important: draft.important,
    urgencyMode: draft.urgencyMode,
    dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : undefined,
    estimatedMinutes: draft.estimatedMinutes ? Number(draft.estimatedMinutes) : undefined,
    projectId: draft.projectId || undefined,
    planItemId: draft.projectId && draft.planItemId ? draft.planItemId : undefined,
    projectName: draft.projectId ? undefined : draft.projectName || undefined,
    areaName: draft.areaName || undefined,
    assigneeUserId: draft.assigneeUserId || undefined,
    sourceReferences: draft.sourceReferences.map(({ kind, sourceId, label, href }) => ({ kind, sourceId, label, href })),
  };
}

export function ProjectsPage({ initialProjectId }: { readonly initialProjectId?: string }) {
  const [projects, setProjects] = useState<readonly ClientProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [overview, setOverview] = useState<ClientProjectOverview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [projectDialogError, setProjectDialogError] = useState<string>();
  const [quickTaskTitle, setQuickTaskTitle] = useState("");
  const [projectDraft, setProjectDraft] = useState<ProjectManagementDraft>();
  const [milestoneDraft, setMilestoneDraft] = useState<ProjectMilestoneDraft>();
  const [planItemDraft, setPlanItemDraft] = useState<ProjectPlanItemDraft>();
  const [phaseDraft, setPhaseDraft] = useState<ProjectPhaseDraft>();
  const [planItemCreateDraft, setPlanItemCreateDraft] = useState<ProjectPlanItemCreateDraft>();
  const [taskEditDraft, setTaskEditDraft] = useState<ProjectTaskEditDraft>();
  const [taskScheduleTarget, setTaskScheduleTarget] = useState<ProjectTaskScheduleTarget>();
  const [taskScheduleBusy, setTaskScheduleBusy] = useState(false);
  const [taskEditPlanItems, setTaskEditPlanItems] = useState<readonly ClientProjectPlanItem[]>([]);
  const [linkedActionTitle, setLinkedActionTitle] = useState("");
  const [linkActionTaskId, setLinkActionTaskId] = useState("");
  const [projectMembers, setProjectMembers] = useState<readonly ClientProjectMember[]>([]);
  const [collaborators, setCollaborators] = useState<readonly ClientCollaborator[]>([]);
  const [memberDraftUserId, setMemberDraftUserId] = useState("");
  const [memberDraftAccess, setMemberDraftAccess] = useState<"viewer" | "editor">("viewer");
  const memberLoadSequenceRef = useRef(0);

  useEffect(() => {
    setLinkedActionTitle("");
    setLinkActionTaskId("");
  }, [planItemDraft?.planItemId]);

  const loadProjects = useCallback(async () => {
    const response = await workspaceFetch("/api/projects?includeArchived=true");
    const payload = await response.json() as { readonly ok?: boolean; readonly projects?: readonly ClientProject[]; readonly message?: string };
    if (!response.ok || !payload.ok || !payload.projects) throw new Error(payload.message ?? "无法读取项目");
    setProjects(payload.projects);
    setSelectedProjectId((current) => {
      if (current && payload.projects!.some((project) => project.id === current)) return current;
      if (initialProjectId && payload.projects!.some((project) => project.id === initialProjectId)) return initialProjectId;
      return payload.projects!.find((project) => project.status === "active")?.id ?? payload.projects![0]?.id;
    });
    return payload.projects;
  }, [initialProjectId]);

  const loadOverview = useCallback(async (projectId: string, cacheTtlMs = 1_000) => {
    const response = await workspaceFetch(`/api/projects/${encodeURIComponent(projectId)}`, {}, cacheTtlMs);
    const payload = await response.json() as { readonly ok?: boolean; readonly overview?: ClientProjectOverview; readonly message?: string };
    if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "无法读取项目概况");
    setOverview(payload.overview);
  }, []);

  useEffect(() => {
    let active = true;
    const projectId = taskEditDraft?.projectId;
    if (!projectId) {
      setTaskEditPlanItems([]);
      return () => { active = false; };
    }
    if (overview?.project.id === projectId) {
      setTaskEditPlanItems(overview.planItems);
      return () => { active = false; };
    }
    void (async () => {
      try {
        const response = await workspaceFetch(`/api/projects/${encodeURIComponent(projectId)}`, {}, 0);
        const payload = await response.json() as { readonly ok?: boolean; readonly overview?: ClientProjectOverview };
        if (active) setTaskEditPlanItems(response.ok && payload.ok ? payload.overview?.planItems ?? [] : []);
      } catch {
        if (active) setTaskEditPlanItems([]);
      }
    })();
    return () => { active = false; };
  }, [overview, taskEditDraft?.projectId]);

  const loadProjectMembers = useCallback(async (projectId: string) => {
    const requestSequence = ++memberLoadSequenceRef.current;
    const [membersResponse, collaboratorsResponse] = await Promise.all([
      workspaceFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {}, 1_000),
      workspaceFetch("/api/collaborators", {}, 1_000),
    ]);
    const membersPayload = await membersResponse.json() as { readonly ok?: boolean; readonly members?: readonly ClientProjectMember[]; readonly message?: string };
    const collaboratorsPayload = await collaboratorsResponse.json() as { readonly ok?: boolean; readonly users?: readonly ClientCollaborator[]; readonly message?: string };
    if (requestSequence !== memberLoadSequenceRef.current) return;
    if (membersResponse.ok && membersPayload.ok) setProjectMembers(membersPayload.members ?? []);
    if (collaboratorsResponse.ok && collaboratorsPayload.ok) setCollaborators(collaboratorsPayload.users ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadProjects()
      .catch((error: unknown) => { if (!cancelled) setFeedback(error instanceof Error ? error.message : "无法读取项目"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadProjects]);

  useEffect(() => {
    if (initialProjectId && projects.some((project) => project.id === initialProjectId)) {
      setSelectedProjectId(initialProjectId);
    }
  }, [initialProjectId, projects]);

  useEffect(() => {
    const openProjectDialog = (event: Event) => {
      const areaName = (event as CustomEvent<{ readonly areaName?: string }>).detail?.areaName ?? "";
      setProjectDialogError(undefined);
      setProjectDraft({ name: "", description: "", areaName, color: "#86bdf5", status: "active" });
    };
    window.addEventListener(OPEN_PROJECT_DIALOG_EVENT, openProjectDialog);
    return () => window.removeEventListener(OPEN_PROJECT_DIALOG_EVENT, openProjectDialog);
  }, []);

  useEffect(() => {
    const editProjectDialog = (event: Event) => {
      const projectId = (event as CustomEvent<{ readonly projectId?: string }>).detail?.projectId;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;
      setSelectedProjectId(project.id);
      memberLoadSequenceRef.current += 1;
      setProjectMembers([]);
      setMemberDraftUserId("");
      setMemberDraftAccess("viewer");
      setProjectDialogError(undefined);
      setProjectDraft({
        id: project.id,
        name: project.name,
        description: project.description ?? "",
        areaName: project.areaName ?? "",
        color: project.color,
        status: project.status,
      });
    };
    window.addEventListener(EDIT_PROJECT_DIALOG_EVENT, editProjectDialog);
    return () => window.removeEventListener(EDIT_PROJECT_DIALOG_EVENT, editProjectDialog);
  }, [projects]);

  const refreshProjectPage = useCallback(async () => {
    await loadProjects();
    if (selectedProjectId) {
      await Promise.all([
        loadOverview(selectedProjectId),
        loadProjectMembers(selectedProjectId),
      ]);
    }
  }, [loadOverview, loadProjectMembers, loadProjects, selectedProjectId]);
  useEffect(() => {
    const refreshAfterProjectChange = () => { void refreshProjectPage(); };
    window.addEventListener(PROJECTS_CHANGED_EVENT, refreshAfterProjectChange);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, refreshAfterProjectChange);
  }, [refreshProjectPage]);
  useRealtimeRefresh(["project", "task", "note", "relation"], refreshProjectPage);
  useVisiblePageRefresh(refreshProjectPage);

  useEffect(() => {
    if (!selectedProjectId) {
      memberLoadSequenceRef.current += 1;
      setOverview(undefined);
      setProjectMembers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadOverview(selectedProjectId)
      .catch((error: unknown) => { if (!cancelled) setFeedback(error instanceof Error ? error.message : "无法读取项目概况"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    void loadProjectMembers(selectedProjectId).catch(() => undefined);
    return () => { cancelled = true; };
  }, [loadOverview, loadProjectMembers, selectedProjectId]);

  const saveMembers = async (projectId: string, members: readonly ClientProjectMember[]) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly members?: readonly ClientProjectMember[]; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.members) throw new Error(payload.message ?? "无法保存项目成员");
      setProjectMembers(payload.members);
      setFeedback("项目共享已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存项目成员");
    } finally {
      setBusy(false);
    }
  };

  const saveProject = async () => {
    if (!projectDraft?.name.trim() || busy) return;
    setProjectDialogError(undefined);
    setBusy(true);
    try {
      const response = await fetch(projectDraft.id ? `/api/projects/${encodeURIComponent(projectDraft.id)}` : "/api/projects", {
        method: projectDraft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectDraft),
      });
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly project?: ClientProject; readonly message?: string }>(
        response,
        "无法保存项目",
      );
      if (!response.ok || !payload.ok || !payload.project) throw new Error(payload.message ?? "无法保存项目");
      await loadProjects();
      setSelectedProjectId(payload.project.id);
      await loadOverview(payload.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setProjectDraft(undefined);
      setFeedback(projectDraft.id ? "项目已更新" : "项目已创建");
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法保存项目";
      setProjectDialogError(message);
      setFeedback(message);
    } finally {
      setBusy(false);
    }
  };

  const createQuickTask = async () => {
    if (!overview || !quickTaskTitle.trim() || busy || overview.project.status === "archived") return;
    setBusy(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: quickTaskTitle,
          status: "next",
          important: false,
          urgencyMode: "auto",
          projectId: overview.project.id,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法创建任务");
      setQuickTaskTitle("");
      await loadOverview(overview.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback("下一步行动已添加");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建任务");
    } finally {
      setBusy(false);
    }
  };

  const saveProjectTask = async () => {
    if (!overview || !taskEditDraft?.title.trim() || busy) return;
    const previousTask = overview.tasks.find((task) => task.id === taskEditDraft.id);
    setBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskEditDraft.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectTaskEditPayload(taskEditDraft)),
      });
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly task?: ClientTask; readonly message?: string }>(
        response,
        "无法保存任务",
      );
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法保存任务");
      let completedPlanItem = false;
      if (previousTask?.status !== "done" && payload.task.status === "done") {
        try {
          completedPlanItem = await offerToCompleteLinkedPlanItem(payload.task);
        } catch (error) {
          await loadOverview(overview.project.id, 0);
          setTaskEditDraft(undefined);
          window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
          window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
          setFeedback(`任务已完成，但${error instanceof Error ? error.message : "无法检查计划项进度"}`);
          return;
        }
      }
      await loadOverview(overview.project.id, 0);
      setTaskEditDraft(undefined);
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback(completedPlanItem ? "任务和关联计划项已完成" : "任务已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存任务");
    } finally {
      setBusy(false);
    }
  };

  const openProjectTaskSchedule = (task: ClientTask, block?: ClientTaskTimeBlock) => {
    const returnTaskDraft = taskEditDraft;
    setTaskEditDraft(undefined);
    setTaskScheduleTarget({ task, block, returnTaskDraft });
  };

  const closeProjectTaskSchedule = () => {
    if (taskScheduleTarget?.returnTaskDraft) setTaskEditDraft(taskScheduleTarget.returnTaskDraft);
    setTaskScheduleTarget(undefined);
  };

  const deleteProjectTaskTimeBlock = async (task: ClientTask, block: ClientTaskTimeBlock) => {
    if (!overview || taskScheduleBusy || !await appConfirm({
      title: "删除这个时间块？",
      description: `${formatTaskBlockRange(block.start, block.end)}\n任务本身会保留，并重新回到待安排状态。`,
      confirmLabel: "删除时间块",
      tone: "danger",
    })) return;
    setTaskScheduleBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/schedule/${encodeURIComponent(block.eventId)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: ClientTask; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法删除时间块");
      await loadOverview(overview.project.id, 0);
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback("时间块已删除，任务仍然保留");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除时间块");
    } finally {
      setTaskScheduleBusy(false);
    }
  };

  const createLinkedPlanAction = async () => {
    if (!overview || !planItemDraft || !linkedActionTitle.trim() || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: linkedActionTitle,
          status: "next",
          important: false,
          urgencyMode: "auto",
          projectId: overview.project.id,
          planItemId: planItemDraft.planItemId,
        }),
      });
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly task?: ClientTask; readonly message?: string }>(
        response,
        "无法创建关联行动",
      );
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法创建关联行动");
      await loadOverview(overview.project.id, 0);
      setLinkedActionTitle("");
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback("关联行动已创建");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建关联行动");
    } finally {
      setBusy(false);
    }
  };

  const updatePlanActionLink = async (task: ClientTask, planItemId?: string) => {
    if (!overview || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectTaskEditPayload({
          ...projectTaskToEditDraft(task),
          planItemId: planItemId ?? "",
        })),
      });
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly task?: ClientTask; readonly message?: string }>(
        response,
        planItemId ? "无法关联行动" : "无法解除关联",
      );
      if (!response.ok || !payload.ok || !payload.task) {
        throw new Error(payload.message ?? (planItemId ? "无法关联行动" : "无法解除关联"));
      }
      await loadOverview(overview.project.id, 0);
      setLinkActionTaskId("");
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback(planItemId ? "行动已关联" : "行动已解除关联");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : planItemId ? "无法关联行动" : "无法解除关联");
    } finally {
      setBusy(false);
    }
  };

  const createProjectNote = async () => {
    if (!overview || busy || overview.project.status === "archived") return;
    setBusy(true);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: overview.project.id,
          title: `${overview.project.name} 笔记`,
          content: "",
          noteType: "project",
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建笔记");
      window.location.assign(`/notes?note=${encodeURIComponent(payload.note.id)}`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建笔记");
      setBusy(false);
    }
  };

  const saveMilestone = async () => {
    if (!overview || !milestoneDraft?.title.trim() || busy) return;
    setBusy(true);
    try {
      const endpoint = milestoneDraft.id
        ? `/api/projects/${encodeURIComponent(overview.project.id)}/milestones/${encodeURIComponent(milestoneDraft.id)}`
        : `/api/projects/${encodeURIComponent(overview.project.id)}/milestones`;
      const response = await fetch(endpoint, {
        method: milestoneDraft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(milestoneDraft),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法保存里程碑");
      await loadOverview(overview.project.id);
      setMilestoneDraft(undefined);
      setFeedback(milestoneDraft.id ? "里程碑已更新" : "里程碑已添加");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存里程碑");
    } finally {
      setBusy(false);
    }
  };

  const deleteMilestone = async (draft: ProjectMilestoneDraft) => {
    if (!overview || !draft.id || busy || !await appConfirm({
      title: `删除里程碑“${draft.title}”？`,
      description: "该里程碑会从项目概况和甘特图中移除，此操作无法撤销。",
      confirmLabel: "删除里程碑",
      tone: "danger",
    })) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/milestones/${encodeURIComponent(draft.id)}`,
        { method: "DELETE" },
      );
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly message?: string }>(
        response,
        "无法删除里程碑",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除里程碑");
      await loadOverview(overview.project.id);
      setMilestoneDraft(undefined);
      setFeedback("里程碑已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除里程碑");
    } finally {
      setBusy(false);
    }
  };

  const savePlanItem = async () => {
    if (!overview || !planItemDraft || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(overview.project.id)}/plan-items/${encodeURIComponent(planItemDraft.planItemId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planItemDraft),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly overview?: ClientProjectOverview; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "无法保存甘特计划");
      setOverview(payload.overview);
      setPlanItemDraft(undefined);
      setFeedback("计划项已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存甘特计划");
    } finally {
      setBusy(false);
    }
  };

  const savePlanItemDates = async (
    task: ClientProjectPlanItem,
    plannedStart: string,
    plannedEnd: string,
  ): Promise<boolean> => {
    if (!overview || busy || overview.project.status === "archived") return false;
    const snapshot = overview;
    setBusy(true);
    setOverview({
      ...overview,
      planItems: overview.planItems.map((entry) => entry.id === task.id ? { ...entry, plannedStart, plannedEnd } : entry),
    });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(overview.project.id)}/plan-items/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plannedStart,
          plannedEnd,
          dependencyIds: task.dependencyIds,
          phaseId: task.phaseId ?? null,
          durationWorkdays: countProjectDays(plannedStart, plannedEnd),
          autoSchedule: task.autoSchedule,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly planItem?: ClientProjectPlanItem; readonly overview?: ClientProjectOverview; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.planItem || !payload.overview) throw new Error(payload.message ?? "无法保存甘特计划");
      setOverview(payload.overview);
      setFeedback(`已更新“${task.title}”的计划日期`);
      return true;
    } catch (error) {
      setOverview(snapshot);
      setFeedback(error instanceof Error ? error.message : "无法保存甘特计划");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveGanttMilestoneDate = async (
    milestone: ClientProjectMilestone,
    dueOn: string,
  ): Promise<boolean> => {
    if (!overview || busy || overview.project.status === "archived") return false;
    const snapshot = overview;
    setBusy(true);
    setOverview({
      ...overview,
      milestones: overview.milestones.map((entry) => entry.id === milestone.id ? { ...entry, dueOn } : entry),
    });
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/milestones/${encodeURIComponent(milestone.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: milestone.title,
            dueOn,
            status: milestone.status,
            sortOrder: milestone.sortOrder,
            phaseId: milestone.phaseId ?? null,
          }),
        },
      );
      const payload = await readProjectApiResponse<{
        readonly ok?: boolean;
        readonly milestone?: ClientProjectMilestone;
        readonly message?: string;
      }>(response, "无法保存里程碑日期");
      if (!response.ok || !payload.ok || !payload.milestone) throw new Error(payload.message ?? "无法保存里程碑日期");
      setOverview((current) => current ? {
        ...current,
        milestones: current.milestones.map((entry) => entry.id === milestone.id ? payload.milestone! : entry),
      } : current);
      setFeedback(`已更新“${milestone.title}”的目标日期`);
      return true;
    } catch (error) {
      setOverview(snapshot);
      setFeedback(error instanceof Error ? error.message : "无法保存里程碑日期");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reorderTimelineItem = async (input: ProjectTimelineReorderInput): Promise<boolean> => {
    if (!overview || busy || overview.project.status === "archived") return false;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/timeline/reorder`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, phaseId: input.phaseId ?? null }),
        },
      );
      const payload = await readProjectApiResponse<{
        readonly ok?: boolean;
        readonly overview?: ClientProjectOverview;
        readonly message?: string;
      }>(response, "无法保存甘特顺序");
      if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "无法保存甘特顺序");
      setOverview(payload.overview);
      setFeedback(input.kind === "milestone" ? "里程碑位置已更新" : "计划项顺序已更新");
      return true;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存甘特顺序");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const savePhase = async () => {
    if (!overview || !phaseDraft?.name.trim() || busy) return;
    setBusy(true);
    try {
      const endpoint = phaseDraft.id
        ? `/api/projects/${encodeURIComponent(overview.project.id)}/phases/${encodeURIComponent(phaseDraft.id)}`
        : `/api/projects/${encodeURIComponent(overview.project.id)}/phases`;
      const response = await fetch(endpoint, {
        method: phaseDraft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(phaseDraft),
      });
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly message?: string }>(
        response,
        "无法保存阶段",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法保存阶段");
      await loadOverview(overview.project.id);
      setPhaseDraft(undefined);
      setFeedback(phaseDraft.id ? "阶段已更新" : "阶段已添加");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存阶段");
    } finally {
      setBusy(false);
    }
  };

  const deletePhase = async (phase: ClientProjectPhase) => {
    if (!overview || busy || !await appConfirm({
      title: `删除阶段“${phase.name}”？`,
      description: "阶段中的计划项会保留，并移动到“未分组”。",
      confirmLabel: "删除阶段",
      tone: "danger",
    })) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/phases/${encodeURIComponent(phase.id)}`,
        { method: "DELETE" },
      );
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly message?: string }>(
        response,
        "无法删除阶段",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除阶段");
      await loadOverview(overview.project.id);
      setFeedback("阶段已删除，计划项已移到未分组");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除阶段");
    } finally {
      setBusy(false);
    }
  };

  const createPlanItem = async () => {
    if (!overview || !planItemCreateDraft?.title.trim() || busy) return;
    setBusy(true);
    try {
      const plannedEnd = planItemCreateDraft.plannedStart
        ? addProjectDays(planItemCreateDraft.plannedStart, planItemCreateDraft.durationWorkdays - 1)
        : undefined;
      const createResponse = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/plan-items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: planItemCreateDraft.title,
            status: "planned",
            plannedStart: planItemCreateDraft.plannedStart || undefined,
            plannedEnd,
            dependencyIds: [],
            phaseId: planItemCreateDraft.phaseId || null,
            durationWorkdays: planItemCreateDraft.durationWorkdays,
            autoSchedule: false,
          }),
        },
      );
      const createPayload = await readProjectApiResponse<{
        readonly ok?: boolean;
        readonly planItem?: ClientProjectPlanItem;
        readonly overview?: ClientProjectOverview;
        readonly message?: string;
      }>(createResponse, "无法创建计划项");
      if (!createResponse.ok || !createPayload.ok || !createPayload.planItem || !createPayload.overview) {
        throw new Error(createPayload.message ?? "无法创建计划项");
      }
      let updatedOverview = createPayload.overview;
      if (planItemCreateDraft.insertAfterPlanItemId) {
        const anchor = updatedOverview.planItems.find((task) => task.id === planItemCreateDraft.insertAfterPlanItemId);
        const phaseId = planItemCreateDraft.phaseId || undefined;
        if (anchor && (anchor.phaseId ?? "") === (phaseId ?? "")) {
          const siblings = updatedOverview.planItems
            .filter((task) => task.id !== createPayload.planItem!.id && (task.phaseId ?? "") === (phaseId ?? ""))
            .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
          const anchorIndex = siblings.findIndex((task) => task.id === anchor.id);
          const reorderResponse = await fetch(
            `/api/projects/${encodeURIComponent(overview.project.id)}/timeline/reorder`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                kind: "planItem",
                itemId: createPayload.planItem.id,
                phaseId: phaseId ?? null,
                beforeId: siblings[anchorIndex + 1]?.id,
              }),
            },
          );
          const reorderPayload = await readProjectApiResponse<{
            readonly ok?: boolean;
            readonly overview?: ClientProjectOverview;
            readonly message?: string;
          }>(reorderResponse, "无法放置新计划项");
          if (!reorderResponse.ok || !reorderPayload.ok || !reorderPayload.overview) {
            throw new Error(reorderPayload.message ?? "无法放置新计划项");
          }
          updatedOverview = reorderPayload.overview;
        }
      }
      setOverview(updatedOverview);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setPlanItemCreateDraft(undefined);
      setFeedback("计划项已添加到甘特图");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建计划项");
    } finally {
      setBusy(false);
    }
  };

  const deletePlanItem = async (task: ClientProjectPlanItem) => {
    if (!overview || busy || !await appConfirm({
      title: `删除计划项“${task.title}”？`,
      description: "计划依赖会被移除，已关联的行动任务会保留并解除关联。",
      confirmLabel: "删除计划项",
      tone: "danger",
    })) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/plan-items/${encodeURIComponent(task.id)}`,
        { method: "DELETE" },
      );
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly overview?: ClientProjectOverview; readonly message?: string }>(
        response,
        "无法删除计划项",
      );
      if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "无法删除计划项");
      setOverview(payload.overview);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback("计划项已删除，关联行动已保留");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除计划项");
    } finally {
      setBusy(false);
    }
  };

  const openTasks = overview?.tasks.filter((task) => task.status !== "done") ?? [];
  const editingProjectTask = taskEditDraft
    ? overview?.tasks.find((task) => task.id === taskEditDraft.id)
    : undefined;
  const upcomingBlocks = overview?.scheduledBlocks.filter((block) => new Date(block.end).getTime() >= Date.now()).slice(0, 6) ?? [];
  const planItemDraftBlocked = Boolean(planItemDraft && overview?.planItems.some((task) => (
    planItemDraft.dependencyIds.includes(task.id) && task.status !== "done"
  )));

  return (
    <div className="projects-page">
      <aside className="project-switcher project-switcher-mobile panel">
        <header><div><Folder size={17} /><span><strong>项目</strong><small>{projects.filter((project) => project.status === "active").length} 个进行中</small></span></div><button aria-label="新建项目" title="新建项目" onClick={() => { setProjectDialogError(undefined); setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5", status: "active" }); }}><Plus size={16} /></button></header>
        <div>
          {projects.map((project) => <button className={selectedProjectId === project.id ? "active" : ""} key={project.id} onClick={() => setSelectedProjectId(project.id)}><i style={{ background: project.color }} /><span><strong>{project.name}</strong><small>{project.areaName ?? (project.status === "archived" ? "已归档" : "未设置领域")}</small></span>{project.status === "archived" && <Archive size={13} />}</button>)}
          {!loading && !projects.length && <div className="project-switcher-empty"><FolderPlus size={20} /><span>还没有项目</span></div>}
        </div>
      </aside>

      <main className="project-overview">
        {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
        {loading && !overview ? <div className="project-overview-loading"><LoaderCircle className="spin" size={18} />正在整理项目…</div> : overview ? <>
          <ProjectGanttChart
            projectId={overview.project.id}
            planItems={overview.planItems}
            phases={overview.phases}
            milestones={overview.milestones}
            projectColor={overview.project.color}
            readOnly={overview.project.status === "archived"}
            busy={busy}
            onChangeDates={savePlanItemDates}
            onChangeMilestoneDate={saveGanttMilestoneDate}
            onReorderItem={reorderTimelineItem}
            onEdit={(task) => setPlanItemDraft(createProjectPlanItemDraft(task))}
            onEditMilestone={(milestone) => setMilestoneDraft({ id: milestone.id, title: milestone.title, dueOn: milestone.dueOn ?? "", status: milestone.status, phaseId: milestone.phaseId ?? "" })}
            onCreateMilestone={(dueOn, phaseId) => setMilestoneDraft({ title: "", dueOn: dueOn ?? "", status: "planned", phaseId: phaseId ?? "" })}
            onCreatePlanItem={(phaseId, plannedStart, durationWorkdays = 1, insertAfterPlanItemId) => setPlanItemCreateDraft({ title: "", phaseId: phaseId ?? "", plannedStart: plannedStart ?? "", durationWorkdays, insertAfterPlanItemId })}
            onDeletePlanItem={(task) => void deletePlanItem(task)}
            onCreatePhase={() => setPhaseDraft({ name: "", color: overview.project.color, sortOrder: overview.phases.length })}
            onEditPhase={(phase) => setPhaseDraft({ id: phase.id, name: phase.name, color: phase.color, sortOrder: phase.sortOrder })}
            onDeletePhase={(phase) => void deletePhase(phase)}
          />

          <div className="project-content-grid">
            <section className="panel project-actions-panel">
              <header><div><ListChecks size={16} /><span><strong>下一步行动</strong></span></div><Link href="/tasks">查看全部</Link></header>
              {overview.project.status === "active" && <form onSubmit={(event) => { event.preventDefault(); void createQuickTask(); }}><Plus size={15} /><input value={quickTaskTitle} maxLength={240} onChange={(event) => setQuickTaskTitle(event.target.value)} placeholder="快速添加下一步行动…" /><button disabled={busy || !quickTaskTitle.trim()}>添加</button></form>}
              <div className="project-action-list">{openTasks.slice(0, 7).map((task) => <button type="button" onClick={() => setTaskEditDraft(projectTaskToEditDraft(task))} key={task.id}><span className={`project-task-status ${task.isUrgent ? "urgent" : ""}`}><Check size={12} /></span><span><strong>{task.title}</strong><small>{task.dueAt ? formatTaskDue(task.dueAt) : task.estimatedMinutes ? formatTaskEstimate(task.estimatedMinutes) : task.planItemTitle ? `计划项：${task.planItemTitle}` : formatTaskStatus(task.status)}</small></span>{task.important && <Star size={13} fill="currentColor" />}</button>)}{!openTasks.length && <div className="project-panel-empty"><CheckCircle2 size={20} /><span>当前没有待推进任务</span></div>}</div>
            </section>

            <section className="panel project-notes-panel">
              <header><div><NotebookPen size={16} /><span><strong>项目笔记</strong></span></div><button disabled={busy || overview.project.status === "archived"} onClick={() => void createProjectNote()}><Plus size={14} />新建</button></header>
              <div>{overview.notes.slice(0, 6).map((note) => <Link href={`/notes?note=${encodeURIComponent(note.id)}`} key={note.id}><FileText size={15} /><span><strong>{note.title}</strong><small>{formatNoteUpdated(note.updatedAt)}</small></span>{note.pinned && <Pin size={12} fill="currentColor" />}</Link>)}{!overview.notes.length && <div className="project-panel-empty"><NotebookPen size={20} /><span>还没有项目笔记</span></div>}</div>
            </section>

            <section className="panel project-schedule-panel">
              <header><div><CalendarClock size={16} /><span><strong>时间安排</strong></span></div><Link href="/calendar">打开日历</Link></header>
              <div>{upcomingBlocks.map((block) => <Link href={block.href} key={block.eventId}><time dateTime={block.start}>{formatProjectBlockDate(block.start)}</time><span><strong>{block.taskTitle}</strong><small>{formatTaskBlockRange(block.start, block.end)} · {block.calendarName}</small></span></Link>)}{!upcomingBlocks.length && <div className="project-panel-empty"><CalendarClock size={20} /><span>尚未安排专注时间</span></div>}</div>
            </section>

          </div>
        </> : <section className="panel project-empty-state"><FolderPlus size={26} /><h2>建立第一个项目</h2><p>项目会把任务、笔记和专注时间组织在同一个目标下。</p><button className="primary-button" onClick={() => { setProjectDialogError(undefined); setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5", status: "active" }); }}><Plus size={14} />新建项目</button></section>}
      </main>

      {taskEditDraft && <TaskEditorDialog
        draft={taskEditDraft}
        projects={projects}
        planItems={taskEditPlanItems}
        collaborators={collaborators}
        editingTask={editingProjectTask}
        busy={busy}
        scheduleBusy={taskScheduleBusy}
        onDraftChange={(nextDraft) => setTaskEditDraft(nextDraft as ProjectTaskEditDraft)}
        onClose={() => setTaskEditDraft(undefined)}
        onSave={() => void saveProjectTask()}
        onSchedule={(block) => { if (editingProjectTask) openProjectTaskSchedule(editingProjectTask, block as ClientTaskTimeBlock | undefined); }}
        onDeleteTimeBlock={(block) => { if (editingProjectTask) void deleteProjectTaskTimeBlock(editingProjectTask, block as ClientTaskTimeBlock); }}
      />}

      {taskScheduleTarget && <TaskScheduleDialog
        task={taskScheduleTarget.task}
        block={taskScheduleTarget.block}
        onClose={closeProjectTaskSchedule}
        onSaved={(savedTask) => {
          if (overview) void loadOverview(overview.project.id, 0);
          window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
          window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
          setTaskScheduleTarget((current) => current ? {
            ...current,
            task: savedTask,
            returnTaskDraft: current.returnTaskDraft ? projectTaskToEditDraft(savedTask) : undefined,
          } : current);
        }}
        onFeedback={setFeedback}
      />}

      {projectDraft && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setProjectDialogError(undefined); setProjectDraft(undefined); } }}>
        <section className="calendar-dialog note-project-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-management-dialog-title">
          <header><div><h2 id="project-management-dialog-title">{projectDraft.id ? "项目设置" : "新建项目"}</h2></div><button aria-label="关闭" onClick={() => { setProjectDialogError(undefined); setProjectDraft(undefined); }} disabled={busy}><X size={18} /></button></header>
          <div className="note-project-form">
            {projectDialogError && <div className="project-dialog-error" role="alert"><AlertCircle size={15} /><span><strong>{projectDraft.id ? "保存失败" : "创建失败"}</strong><small>{projectDialogError}</small></span></div>}
            <label><span>项目名称</span><input autoFocus value={projectDraft.name} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="例如 博士论文" /></label>
            <label><span>领域</span><input value={projectDraft.areaName} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, areaName: event.target.value })} placeholder="例如 研究 / 个人" /></label>
            <label className="note-project-color"><span>颜色</span><input type="color" value={projectDraft.color} onChange={(event) => setProjectDraft({ ...projectDraft, color: event.target.value })} /></label>
            {projectDraft.id && <label><span>状态</span><AppSelect ariaLabel="项目状态" value={projectDraft.status} onValueChange={(status) => setProjectDraft({ ...projectDraft, status: status as "active" | "archived" })} options={[{ value: "active", label: "进行中" }, { value: "archived", label: "已归档" }]} /></label>}
            <label className="note-project-description"><span>项目说明</span><textarea value={projectDraft.description} maxLength={2_000} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} placeholder="这个项目要达成什么？完成标准是什么？" /></label>
            {projectDraft.id && <section className="project-dialog-sharing" aria-labelledby="project-sharing-title">
              <header><div><Users size={16} /><span><strong id="project-sharing-title">项目共享</strong><small>{projectMembers.length ? `${projectMembers.length} 位成员` : "仅项目所有者可见"}</small></span></div></header>
              <div className="project-share-members">
                {projectMembers.map((member) => <span key={member.userId}><strong>{member.displayName}</strong><small>{member.accessLevel === "editor" ? "可编辑" : "只读"}</small><button aria-label={`移除 ${member.displayName}`} disabled={busy} onClick={() => void saveMembers(projectDraft.id!, projectMembers.filter((entry) => entry.userId !== member.userId))}><X size={12} /></button></span>)}
              </div>
              <div className="project-share-form">
                <AppSelect ariaLabel="选择项目成员" size="compact" value={memberDraftUserId} onValueChange={setMemberDraftUserId} options={[{ value: "", label: "选择用户" }, ...collaborators.filter((user) => !projectMembers.some((member) => member.userId === user.id)).map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))]} />
                <AppSelect ariaLabel="项目成员权限" size="compact" value={memberDraftAccess} onValueChange={(access) => setMemberDraftAccess(access === "editor" ? "editor" : "viewer")} options={[{ value: "viewer", label: "只读" }, { value: "editor", label: "可编辑" }]} />
                <button className="secondary-button" disabled={!memberDraftUserId || busy} onClick={() => {
                  const user = collaborators.find((entry) => entry.id === memberDraftUserId);
                  if (!user) return;
                  setMemberDraftUserId("");
                  void saveMembers(projectDraft.id!, [...projectMembers, { userId: user.id, displayName: user.displayName, email: user.email, accessLevel: memberDraftAccess }]);
                }}><Plus size={14} />添加成员</button>
              </div>
            </section>}
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => { setProjectDialogError(undefined); setProjectDraft(undefined); }}>取消</button><button className="primary-button" disabled={busy || !projectDraft.name.trim()} onClick={() => void saveProject()}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? (projectDraft.id ? "保存中" : "创建中") : (projectDraft.id ? "保存修改" : "创建项目")}</button></div></footer>
        </section>
      </div>}
      {milestoneDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setMilestoneDraft(undefined); }}>
        <section className="calendar-dialog project-milestone-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-milestone-dialog-title">
          <header><div><h2 id="project-milestone-dialog-title">{milestoneDraft.id ? "编辑里程碑" : "新建里程碑"}</h2></div><button aria-label="关闭" onClick={() => setMilestoneDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-milestone-form">
            <label className="wide"><span>标题</span><input autoFocus value={milestoneDraft.title} maxLength={240} onChange={(event) => setMilestoneDraft({ ...milestoneDraft, title: event.target.value })} placeholder="例如 完成无人机飞行原型" /></label>
            <label><span>所属阶段</span><AppSelect ariaLabel="里程碑所属阶段" value={milestoneDraft.phaseId} onValueChange={(phaseId) => setMilestoneDraft({ ...milestoneDraft, phaseId })} options={[{ value: "", label: "项目级" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <DateTimeField label="目标日期" mode="date" value={milestoneDraft.dueOn} onChange={(dueOn) => setMilestoneDraft({ ...milestoneDraft, dueOn })} />
            <label><span>状态</span><AppSelect ariaLabel="里程碑状态" value={milestoneDraft.status} onValueChange={(status) => setMilestoneDraft({ ...milestoneDraft, status: status as ClientProjectMilestone["status"] })} options={[{ value: "planned", label: "计划中" }, { value: "active", label: "进行中" }, { value: "done", label: "已完成" }]} /></label>
          </div>
          <footer>{milestoneDraft.id && <button className="secondary-button danger-button" disabled={busy} onClick={() => void deleteMilestone(milestoneDraft)}><Trash2 size={14} />删除</button>}<div><button className="secondary-button" disabled={busy} onClick={() => setMilestoneDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !milestoneDraft.title.trim()} onClick={() => void saveMilestone()}>{busy && <LoaderCircle className="spin" size={14} />}{milestoneDraft.id ? "保存修改" : "添加里程碑"}</button></div></footer>
        </section>
      </div>}
      {planItemDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPlanItemDraft(undefined); }}>
        <section className="calendar-dialog project-gantt-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-gantt-dialog-title">
          <header><div><input id="project-gantt-dialog-title" className="project-gantt-title-input" aria-label="计划项名称" autoFocus maxLength={240} value={planItemDraft.title} onChange={(event) => setPlanItemDraft({ ...planItemDraft, title: event.target.value })} /></div><button aria-label="关闭" onClick={() => setPlanItemDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-gantt-form">
            <label><span>所属阶段</span><AppSelect ariaLabel="所属阶段" value={planItemDraft.phaseId} onValueChange={(phaseId) => setPlanItemDraft({ ...planItemDraft, phaseId })} options={[{ value: "", label: "未分组" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <label><span>状态</span><AppSelect ariaLabel="计划项状态" value={planItemDraft.status} onValueChange={(status) => setPlanItemDraft({ ...planItemDraft, status: status as ProjectPlanItemStatus })} options={[{ value: "planned", label: "待开始" }, { value: "in_progress", label: "进行中" }, { value: "paused", label: "已暂停" }, { value: "done", label: "已完成" }, { value: "cancelled", label: "已取消" }]} /></label>
            <div className="project-gantt-schedule-fields">
              <DateTimeField label="计划开始" mode="date" disabled={planItemDraft.autoSchedule && planItemDraft.dependencyIds.length > 0} value={planItemDraft.plannedStart} onChange={(plannedStart) => {
                setPlanItemDraft({ ...planItemDraft, plannedStart, plannedEnd: plannedStart ? addProjectDays(plannedStart, planItemDraft.durationWorkdays - 1) : "" });
              }} />
              <label><span>工期（天）</span><input type="number" min={1} max={2600} value={planItemDraft.durationWorkdays} onChange={(event) => {
                const durationWorkdays = Math.max(1, Math.min(2600, Number(event.target.value) || 1));
                setPlanItemDraft({ ...planItemDraft, durationWorkdays, plannedEnd: planItemDraft.plannedStart ? addProjectDays(planItemDraft.plannedStart, durationWorkdays - 1) : "" });
              }} /></label>
              <DateTimeField label="计划结束" mode="date" min={planItemDraft.plannedStart} clearable={false} value={planItemDraft.plannedEnd} onChange={(plannedEnd) => {
                setPlanItemDraft({ ...planItemDraft, plannedEnd, durationWorkdays: planItemDraft.plannedStart && plannedEnd ? countProjectDays(planItemDraft.plannedStart, plannedEnd) : planItemDraft.durationWorkdays });
              }} />
            </div>
            <fieldset><legend><label className="project-gantt-auto-schedule"><input type="checkbox" checked={planItemDraft.autoSchedule} onChange={(event) => setPlanItemDraft({ ...planItemDraft, autoSchedule: event.target.checked })} /><span>自动排期</span></label><span>前置计划项</span>{planItemDraftBlocked && <em className="project-gantt-blocked-status">受阻</em>}</legend><div>{overview.planItems.filter((task) => task.id !== planItemDraft.planItemId).map((task) => <label key={task.id}><input type="checkbox" checked={planItemDraft.dependencyIds.includes(task.id)} onChange={(event) => {
              const dependencyIds = event.target.checked ? [...planItemDraft.dependencyIds, task.id] : planItemDraft.dependencyIds.filter((id) => id !== task.id);
              setPlanItemDraft({ ...planItemDraft, dependencyIds, autoSchedule: event.target.checked ? true : planItemDraft.autoSchedule });
            }} /><span className="project-gantt-dependency-title">{task.title}</span><em className={`project-gantt-dependency-status ${task.status}`}>{formatProjectPlanItemStatus(task.status)}</em></label>)}</div>{overview.planItems.length <= 1 && <p>项目中还没有其他计划项可作为依赖。</p>}</fieldset>
            <section className="project-gantt-linked-actions">
              <header><strong>关联行动</strong><small>{overview.tasks.filter((task) => task.planItemId === planItemDraft.planItemId && task.status === "done").length}/{overview.tasks.filter((task) => task.planItemId === planItemDraft.planItemId).length} 已完成</small></header>
              {overview.tasks.some((task) => task.planItemId === planItemDraft.planItemId)
                ? <div className="project-gantt-linked-action-list">{overview.tasks.filter((task) => task.planItemId === planItemDraft.planItemId).map((task) => <article key={task.id}><button type="button" className="project-gantt-linked-action-open" onClick={() => { setPlanItemDraft(undefined); setTaskEditDraft(projectTaskToEditDraft(task)); }}><Check size={12} /><span>{task.title}</span><small>{formatTaskStatus(task.status)}</small></button><button type="button" className="project-gantt-linked-action-remove" aria-label={`解除关联：${task.title}`} title="解除关联" disabled={busy} onClick={() => void updatePlanActionLink(task)}><X size={13} /></button></article>)}</div>
                : <p>还没有关联行动，可以直接新建或关联现有任务。</p>}
              <form className="project-gantt-new-action" onSubmit={(event) => { event.preventDefault(); void createLinkedPlanAction(); }}><input value={linkedActionTitle} maxLength={240} onChange={(event) => setLinkedActionTitle(event.target.value)} placeholder="新建关联行动…" /><button type="submit" disabled={busy || !linkedActionTitle.trim()}><Plus size={13} />新建</button></form>
              <div className="project-gantt-link-action"><AppSelect ariaLabel="选择要关联的任务" size="compact" value={linkActionTaskId} onValueChange={setLinkActionTaskId} options={[{ value: "", label: "选择现有未关联任务" }, ...overview.tasks.filter((task) => !task.planItemId).map((task) => ({ value: task.id, label: `${task.title} · ${formatTaskStatus(task.status)}` }))]} /><button type="button" disabled={busy || !linkActionTaskId} onClick={() => { const task = overview.tasks.find((entry) => entry.id === linkActionTaskId); if (task) void updatePlanActionLink(task, planItemDraft.planItemId); }}><Link2 size={13} />关联</button></div>
            </section>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => setPlanItemDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !planItemDraft.title.trim() || !planItemDraft.plannedStart || !planItemDraft.plannedEnd} onClick={() => void savePlanItem()}>{busy && <LoaderCircle className="spin" size={14} />}保存计划</button></div></footer>
        </section>
      </div>}
      {phaseDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPhaseDraft(undefined); }}>
        <section className="calendar-dialog project-phase-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-phase-dialog-title">
          <header><div><h2 id="project-phase-dialog-title">{phaseDraft.id ? "编辑阶段" : "新建阶段"}</h2></div><button aria-label="关闭" onClick={() => setPhaseDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-phase-form">
            <label><span>阶段名称</span><input autoFocus maxLength={120} value={phaseDraft.name} onChange={(event) => setPhaseDraft({ ...phaseDraft, name: event.target.value })} placeholder="例如 原型开发" /></label>
            <label className="note-project-color"><span>颜色</span><input type="color" value={phaseDraft.color} onChange={(event) => setPhaseDraft({ ...phaseDraft, color: event.target.value })} /></label>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => setPhaseDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !phaseDraft.name.trim()} onClick={() => void savePhase()}>{busy && <LoaderCircle className="spin" size={14} />}{phaseDraft.id ? "保存修改" : "添加阶段"}</button></div></footer>
        </section>
      </div>}
      {planItemCreateDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPlanItemCreateDraft(undefined); }}>
        <section className="calendar-dialog project-gantt-task-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-gantt-task-dialog-title">
          <header><div><h2 id="project-gantt-task-dialog-title">新建计划项</h2></div><button aria-label="关闭" onClick={() => setPlanItemCreateDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-gantt-task-form">
            <label className="wide"><span>计划项名称</span><input autoFocus maxLength={240} value={planItemCreateDraft.title} onChange={(event) => setPlanItemCreateDraft({ ...planItemCreateDraft, title: event.target.value })} placeholder="例如 完成硬件原型" /></label>
            <label><span>所属阶段</span><AppSelect ariaLabel="所属阶段" value={planItemCreateDraft.phaseId} onValueChange={(phaseId) => setPlanItemCreateDraft({ ...planItemCreateDraft, phaseId })} options={[{ value: "", label: "未分组" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <DateTimeField label="计划开始" mode="date" value={planItemCreateDraft.plannedStart} onChange={(plannedStart) => setPlanItemCreateDraft({ ...planItemCreateDraft, plannedStart })} />
            <label><span>工期（天）</span><input type="number" min={1} max={2600} value={planItemCreateDraft.durationWorkdays} onChange={(event) => setPlanItemCreateDraft({ ...planItemCreateDraft, durationWorkdays: Math.max(1, Math.min(2600, Number(event.target.value) || 1)) })} /></label>
          </div>
          <footer><small>{planItemCreateDraft.plannedStart ? `预计结束：${formatProjectMilestoneDate(addProjectDays(planItemCreateDraft.plannedStart, planItemCreateDraft.durationWorkdays - 1))}` : "不设置开始日期时，计划项会进入未排期区域。"}</small><div><button className="secondary-button" disabled={busy} onClick={() => setPlanItemCreateDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !planItemCreateDraft.title.trim()} onClick={() => void createPlanItem()}>{busy && <LoaderCircle className="spin" size={14} />}创建计划项</button></div></footer>
        </section>
      </div>}
    </div>
  );
}

function createProjectPlanItemDraft(task: ClientProjectPlanItem): ProjectPlanItemDraft {
  const start = task.plannedStart ?? toDateInput(new Date());
  const durationWorkdays = task.durationWorkdays
    ?? (task.plannedStart && task.plannedEnd ? countProjectDays(task.plannedStart, task.plannedEnd) : 1);
  const end = task.plannedEnd ?? addProjectDays(start, durationWorkdays - 1);
  return {
    planItemId: task.id,
    title: task.title,
    status: task.status,
    plannedStart: start,
    plannedEnd: end,
    dependencyIds: task.dependencyIds,
    phaseId: task.phaseId ?? "",
    durationWorkdays,
    autoSchedule: task.autoSchedule,
  };
}

type ProjectGanttDragMode = "move" | "resize-start" | "resize-end";

interface ProjectGanttDragPreview {
  readonly planItemId: string;
  readonly mode: ProjectGanttDragMode;
  readonly pointerId: number;
  readonly originClientX: number;
  readonly originalStart: string;
  readonly originalEnd: string;
  readonly originalStartIndex: number;
  readonly originalEndIndex: number;
  readonly start: string;
  readonly end: string;
  readonly moved: boolean;
}

interface ProjectGanttMilestoneDragPreview {
  readonly milestoneId: string;
  readonly pointerId: number;
  readonly originClientX: number;
  readonly originalDate: string;
  readonly originalIndex: number;
  readonly date: string;
  readonly moved: boolean;
}

interface ProjectGanttRowDrag {
  readonly kind: "planItem" | "milestone";
  readonly itemId: string;
  readonly phaseId?: string;
}

interface ProjectGanttDropTarget {
  readonly key: string;
  readonly position: "before" | "after" | "inside";
}

interface ProjectGanttCreateSelection {
  readonly rowKey: string;
  readonly phaseId?: string;
  readonly insertAfterPlanItemId?: string;
  readonly pointerId: number;
  readonly originIndex: number;
  readonly currentIndex: number;
}

interface ProjectGanttMenuState {
  readonly kind: "canvas" | "phase" | "planItem";
  readonly x: number;
  readonly y: number;
  readonly date?: string;
  readonly phase?: ClientProjectPhase;
  readonly phaseId?: string;
  readonly planItem?: ClientProjectPlanItem;
  readonly returnFocus?: HTMLElement | null;
}

const PROJECT_GANTT_DEFAULT_DAY_WIDTH = 27;
const PROJECT_GANTT_MIN_DAY_WIDTH = 6;
const PROJECT_GANTT_MAX_DAY_WIDTH = 54;
const PROJECT_GANTT_ZOOM_STEP = 3;

function ProjectGanttChart({
  projectId,
  planItems,
  phases,
  milestones,
  projectColor,
  readOnly,
  busy,
  onChangeDates,
  onChangeMilestoneDate,
  onReorderItem,
  onEdit,
  onEditMilestone,
  onCreateMilestone,
  onCreatePlanItem,
  onDeletePlanItem,
  onCreatePhase,
  onEditPhase,
  onDeletePhase,
}: {
  readonly projectId: string;
  readonly planItems: readonly ClientProjectPlanItem[];
  readonly phases: readonly ClientProjectPhase[];
  readonly milestones: readonly ClientProjectMilestone[];
  readonly projectColor: string;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onChangeDates: (task: ClientProjectPlanItem, plannedStart: string, plannedEnd: string) => Promise<boolean>;
  readonly onChangeMilestoneDate: (milestone: ClientProjectMilestone, dueOn: string) => Promise<boolean>;
  readonly onReorderItem: (input: ProjectTimelineReorderInput) => Promise<boolean>;
  readonly onEdit: (task: ClientProjectPlanItem) => void;
  readonly onEditMilestone: (milestone: ClientProjectMilestone) => void;
  readonly onCreateMilestone: (dueOn?: string, phaseId?: string) => void;
  readonly onCreatePlanItem: (phaseId?: string, plannedStart?: string, durationWorkdays?: number, insertAfterPlanItemId?: string) => void;
  readonly onDeletePlanItem: (planItem: ClientProjectPlanItem) => void;
  readonly onCreatePhase: () => void;
  readonly onEditPhase: (phase: ClientProjectPhase) => void;
  readonly onDeletePhase: (phase: ClientProjectPhase) => void;
}) {
  const scheduledPlanItems = planItems.filter((planItem) => planItem.plannedStart && planItem.plannedEnd);
  const today = toDateInput(new Date());
  const todayTime = projectDateToUtcTime(today);
  const plannedDates = [...scheduledPlanItems.flatMap((planItem) => [
    projectDateToUtcTime(planItem.plannedStart!),
    projectDateToUtcTime(planItem.plannedEnd!),
  ]), ...milestones.filter((milestone) => milestone.dueOn).map((milestone) => projectDateToUtcTime(milestone.dueOn!))];
  const rangeStartTime = Math.min(todayTime, ...(plannedDates.length ? plannedDates : [todayTime])) - 7 * 86_400_000;
  const rangeEndTime = Math.max(todayTime + 28 * 86_400_000, ...(plannedDates.length ? plannedDates : [todayTime])) + 7 * 86_400_000;
  const rangeStart = projectDateFromUtcTime(rangeStartTime);
  const [dayWidth, setDayWidth] = useState(PROJECT_GANTT_DEFAULT_DAY_WIDTH);
  const totalDays = Math.max(36, Math.round((rangeEndTime - rangeStartTime) / 86_400_000) + 1);
  const timelineWidth = totalDays * dayWidth;
  const monthSegments: { readonly key: string; readonly label: string; readonly left: number; readonly width: number; readonly tone: number }[] = [];
  for (let cursor = new Date(rangeStartTime), index = 0; cursor.getTime() <= rangeEndTime; index += 1) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const nextMonthTime = Date.UTC(year, month + 1, 1);
    const segmentEndTime = Math.min(rangeEndTime + 86_400_000, nextMonthTime);
    const days = Math.max(1, Math.round((segmentEndTime - cursor.getTime()) / 86_400_000));
    monthSegments.push({
      key: `${year}-${month}`,
      label: `${month + 1}月`,
      left: Math.round((cursor.getTime() - rangeStartTime) / 86_400_000) * dayWidth,
      width: days * dayWidth,
      tone: index % 3,
    });
    cursor = new Date(nextMonthTime);
  }
  const weekendDays = Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(rangeStartTime + index * 86_400_000);
    return { index, day: date.getUTCDay() };
  }).filter((entry) => entry.day === 0 || entry.day === 6);
  const todayOffset = projectDayDifference(rangeStart, today) * dayWidth;
  const planItemById = new Map(planItems.map((planItem) => [planItem.id, planItem]));
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayWidthRef = useRef(dayWidth);
  const dragPreviewRef = useRef<ProjectGanttDragPreview | undefined>(undefined);
  const milestoneDragPreviewRef = useRef<ProjectGanttMilestoneDragPreview | undefined>(undefined);
  const createSelectionRef = useRef<ProjectGanttCreateSelection | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const suppressMilestoneClickRef = useRef(false);
  const suppressRowClickRef = useRef(false);
  const [dragPreview, setDragPreview] = useState<ProjectGanttDragPreview>();
  const [milestoneDragPreview, setMilestoneDragPreview] = useState<ProjectGanttMilestoneDragPreview>();
  const [createSelection, setCreateSelection] = useState<ProjectGanttCreateSelection>();
  const [savingPlanItemId, setSavingPlanItemId] = useState<string>();
  const [savingMilestoneId, setSavingMilestoneId] = useState<string>();
  const [rowDrag, setRowDrag] = useState<ProjectGanttRowDrag>();
  const [dropTarget, setDropTarget] = useState<ProjectGanttDropTarget>();
  const [collapsedPhaseIds, setCollapsedPhaseIds] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<ProjectGanttMenuState>();

  useEffect(() => () => {
    document.body.classList.remove("project-gantt-is-dragging");
    document.body.classList.remove("project-gantt-is-selecting");
    document.body.classList.remove("project-gantt-is-row-dragging");
  }, []);
  useEffect(() => {
    const stored = window.localStorage.getItem(`kalender.project-gantt-scale.${projectId}`);
    const parsed = stored ? Number(stored) : Number.NaN;
    const next = Number.isFinite(parsed)
      ? Math.max(PROJECT_GANTT_MIN_DAY_WIDTH, Math.min(PROJECT_GANTT_MAX_DAY_WIDTH, parsed))
      : PROJECT_GANTT_DEFAULT_DAY_WIDTH;
    dayWidthRef.current = next;
    setDayWidth(next);
  }, [projectId]);
  useEffect(() => {
    window.localStorage.setItem(`kalender.project-gantt-scale.${projectId}`, String(dayWidth));
  }, [dayWidth, projectId]);

  const taskColumnWidth = () => scrollRef.current?.querySelector<HTMLElement>(".project-gantt-task-heading")?.offsetWidth ?? 240;

  const applyZoom = (nextDayWidth: number, clientX?: number) => {
    const scroll = scrollRef.current;
    const currentDayWidth = dayWidthRef.current;
    const next = Math.max(PROJECT_GANTT_MIN_DAY_WIDTH, Math.min(PROJECT_GANTT_MAX_DAY_WIDTH, Math.round(nextDayWidth * 10) / 10));
    if (!scroll || next === currentDayWidth || dragPreviewRef.current || milestoneDragPreviewRef.current || createSelectionRef.current) return;
    const bounds = scroll.getBoundingClientRect();
    const columnWidth = taskColumnWidth();
    const anchorX = clientX ?? bounds.left + columnWidth + Math.max(0, scroll.clientWidth - columnWidth) / 2;
    const viewportX = anchorX - bounds.left;
    const anchorDay = Math.max(0, (scroll.scrollLeft + viewportX - columnWidth) / currentDayWidth);
    const nextScrollLeft = anchorDay * next - viewportX + columnWidth;
    dayWidthRef.current = next;
    setDayWidth(next);
    requestAnimationFrame(() => {
      scroll.scrollLeft = Math.max(0, nextScrollLeft);
    });
  };

  const fitTimeline = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const availableWidth = Math.max(1, scroll.clientWidth - taskColumnWidth());
    dayWidthRef.current = Math.max(PROJECT_GANTT_MIN_DAY_WIDTH, Math.min(PROJECT_GANTT_MAX_DAY_WIDTH, availableWidth / totalDays));
    setDayWidth(dayWidthRef.current);
    requestAnimationFrame(() => {
      scroll.scrollLeft = 0;
    });
  };

  const scrollToToday = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const availableWidth = Math.max(0, scroll.clientWidth - taskColumnWidth());
    scroll.scrollTo({ left: Math.max(0, todayOffset - availableWidth / 2), behavior: "smooth" });
  };

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || dragPreviewRef.current || milestoneDragPreviewRef.current || createSelectionRef.current) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      const direction = event.deltaY > 0 ? -1 : 1;
      const amount = Math.max(0.5, Math.min(PROJECT_GANTT_ZOOM_STEP, Math.abs(event.deltaY) * 0.04));
      applyZoom(dayWidthRef.current + direction * amount, event.clientX);
    };
    scroll.addEventListener("wheel", handleWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", handleWheel);
  });

  const sortPlanItems = (entries: readonly ClientProjectPlanItem[]) => [...entries].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return left.createdAt.localeCompare(right.createdAt) || left.title.localeCompare(right.title);
  });
  const sortMilestones = (entries: readonly ClientProjectMilestone[]) => [...entries].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt) || left.title.localeCompare(right.title)
  ));
  const orderedPhases = [...phases].sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
  const phaseIds = new Set(phases.map((phase) => phase.id));
  const ungroupedPlanItems = sortPlanItems(planItems.filter((planItem) => !planItem.phaseId || !phaseIds.has(planItem.phaseId)));
  const ungroupedMilestones = sortMilestones(milestones.filter((milestone) => !milestone.phaseId || !phaseIds.has(milestone.phaseId)));

  const updateDragPreview = (clientX: number) => {
    const current = dragPreviewRef.current;
    if (!current) return;
    const rawDelta = Math.round((clientX - current.originClientX) / dayWidth);
    const originalDuration = current.originalEndIndex - current.originalStartIndex + 1;
    const delta = current.mode === "move"
      ? Math.max(-current.originalStartIndex, Math.min(totalDays - 1 - current.originalEndIndex, rawDelta))
      : current.mode === "resize-start"
        ? Math.max(-current.originalStartIndex, Math.min(originalDuration - 1, rawDelta))
        : Math.max(-(originalDuration - 1), Math.min(totalDays - 1 - current.originalEndIndex, rawDelta));
    const start = current.mode === "resize-end" ? current.originalStart : addProjectDays(current.originalStart, delta);
    const end = current.mode === "resize-start" ? current.originalEnd : addProjectDays(current.originalEnd, delta);
    const next = { ...current, start, end, moved: delta !== 0 };
    dragPreviewRef.current = next;
    setDragPreview(next);
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    task: ClientProjectPlanItem,
    mode: ProjectGanttDragMode,
    startIndex: number,
    durationDays: number,
  ) => {
    if (event.pointerType !== "mouse" || readOnly || busy || savingPlanItemId || !task.plannedStart || !task.plannedEnd) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    suppressClickRef.current = false;
    const next: ProjectGanttDragPreview = {
      planItemId: task.id,
      mode,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      originalStart: task.plannedStart,
      originalEnd: task.plannedEnd,
      originalStartIndex: startIndex,
      originalEndIndex: startIndex + durationDays - 1,
      start: task.plannedStart,
      end: task.plannedEnd,
      moved: false,
    };
    dragPreviewRef.current = next;
    setDragPreview(next);
    document.body.classList.add("project-gantt-is-dragging");
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const current = dragPreviewRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragPreviewRef.current = undefined;
    setDragPreview(undefined);
    document.body.classList.remove("project-gantt-is-dragging");
    suppressClickRef.current = current.moved;
    if (cancelled || !current.moved) return;
    const task = planItems.find((entry) => entry.id === current.planItemId);
    if (!task) return;
    setSavingPlanItemId(task.id);
    void onChangeDates(task, current.start, current.end).finally(() => setSavingPlanItemId(undefined));
  };

  const openPlanItemAfterClick = (task: ClientProjectPlanItem) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!savingPlanItemId) onEdit(task);
  };

  const updateMilestoneDragPreview = (clientX: number) => {
    const current = milestoneDragPreviewRef.current;
    if (!current) return;
    const rawDelta = Math.round((clientX - current.originClientX) / dayWidth);
    const delta = Math.max(-current.originalIndex, Math.min(totalDays - 1 - current.originalIndex, rawDelta));
    const next = { ...current, date: addProjectDays(current.originalDate, delta), moved: delta !== 0 };
    milestoneDragPreviewRef.current = next;
    setMilestoneDragPreview(next);
  };

  const startMilestoneDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    milestone: ClientProjectMilestone,
  ) => {
    if (event.pointerType !== "mouse" || readOnly || busy || savingMilestoneId || !milestone.dueOn) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    suppressMilestoneClickRef.current = false;
    const next: ProjectGanttMilestoneDragPreview = {
      milestoneId: milestone.id,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      originalDate: milestone.dueOn,
      originalIndex: projectDayDifference(rangeStart, milestone.dueOn),
      date: milestone.dueOn,
      moved: false,
    };
    milestoneDragPreviewRef.current = next;
    setMilestoneDragPreview(next);
    document.body.classList.add("project-gantt-is-dragging");
  };

  const finishMilestoneDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const current = milestoneDragPreviewRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    milestoneDragPreviewRef.current = undefined;
    setMilestoneDragPreview(undefined);
    document.body.classList.remove("project-gantt-is-dragging");
    suppressMilestoneClickRef.current = current.moved;
    if (cancelled || !current.moved) return;
    const milestone = milestones.find((entry) => entry.id === current.milestoneId);
    if (!milestone) return;
    setSavingMilestoneId(milestone.id);
    void onChangeMilestoneDate(milestone, current.date).finally(() => setSavingMilestoneId(undefined));
  };

  const openMilestoneAfterClick = (milestone: ClientProjectMilestone) => {
    if (suppressMilestoneClickRef.current) {
      suppressMilestoneClickRef.current = false;
      return;
    }
    if (!savingMilestoneId) onEditMilestone(milestone);
  };

  const startRowDrag = (event: ReactDragEvent<HTMLElement>, drag: ProjectGanttRowDrag) => {
    if (readOnly || busy) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${drag.kind}:${drag.itemId}`);
    suppressRowClickRef.current = true;
    setRowDrag(drag);
    setDropTarget(undefined);
    setMenu(undefined);
    document.body.classList.add("project-gantt-is-row-dragging");
  };

  const finishRowDrag = () => {
    setRowDrag(undefined);
    setDropTarget(undefined);
    document.body.classList.remove("project-gantt-is-row-dragging");
    window.setTimeout(() => { suppressRowClickRef.current = false; }, 0);
  };

  const openRowAfterClick = (open: () => void) => {
    if (suppressRowClickRef.current) return;
    open();
  };

  const canDropRow = (
    targetKind: "phase" | "planItem" | "milestone",
    targetId: string | undefined,
    targetPhaseId: string | undefined,
  ) => {
    if (!rowDrag || busy || readOnly) return false;
    if (rowDrag.kind === "planItem") {
      return targetKind === "planItem"
        && targetId !== rowDrag.itemId
        && (targetPhaseId ?? "") === (rowDrag.phaseId ?? "");
    }
    return targetKind !== "milestone" || targetId !== rowDrag.itemId;
  };

  const dragOverRow = (
    event: ReactDragEvent<HTMLElement>,
    key: string,
    targetKind: "phase" | "planItem" | "milestone",
    targetId: string | undefined,
    targetPhaseId: string | undefined,
  ) => {
    if (!canDropRow(targetKind, targetId, targetPhaseId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const orderedTarget = (rowDrag?.kind === "planItem" && targetKind === "planItem")
      || (rowDrag?.kind === "milestone" && targetKind === "milestone");
    const position = orderedTarget
      ? (event.clientY < bounds.top + bounds.height / 2 ? "before" : "after")
      : "inside";
    if (dropTarget?.key !== key || dropTarget.position !== position) setDropTarget({ key, position });
  };

  const dropOnRow = (
    event: ReactDragEvent<HTMLElement>,
    targetKind: "phase" | "planItem" | "milestone",
    targetId: string | undefined,
    targetPhaseId: string | undefined,
  ) => {
    if (!rowDrag || !canDropRow(targetKind, targetId, targetPhaseId)) return;
    event.preventDefault();
    let beforeId: string | undefined;
    const orderedTarget = (rowDrag.kind === "planItem" && targetKind === "planItem")
      || (rowDrag.kind === "milestone" && targetKind === "milestone");
    if (orderedTarget && targetId) {
      const siblings = rowDrag.kind === "planItem"
        ? sortPlanItems(planItems.filter((planItem) => (planItem.phaseId ?? "") === (targetPhaseId ?? "") && planItem.id !== rowDrag.itemId))
        : sortMilestones(milestones.filter((milestone) => (milestone.phaseId ?? "") === (targetPhaseId ?? "") && milestone.id !== rowDrag.itemId));
      const targetIndex = siblings.findIndex((entry) => entry.id === targetId);
      beforeId = dropTarget?.position === "after" ? siblings[targetIndex + 1]?.id : targetId;
    }
    const input: ProjectTimelineReorderInput = {
      kind: rowDrag.kind,
      itemId: rowDrag.itemId,
      phaseId: targetPhaseId,
      beforeId,
    };
    finishRowDrag();
    void onReorderItem(input);
  };

  const rowDropClass = (key: string) => dropTarget?.key === key
    ? ` project-gantt-drop-${dropTarget.position}`
    : "";

  const dateIndexFromPointer = (event: ReactPointerEvent<HTMLElement>): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(totalDays - 1, Math.floor((event.clientX - bounds.left) / dayWidthRef.current)));
  };

  const startCreateSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
    rowKey: string,
    phaseId?: string,
    insertAfterPlanItemId?: string,
  ) => {
    if (event.button !== 0 || event.pointerType !== "mouse" || readOnly || busy || savingPlanItemId || savingMilestoneId || dragPreviewRef.current || milestoneDragPreviewRef.current || rowDrag) return;
    if ((event.target as Element).closest(".project-gantt-bar, .project-gantt-unscheduled, .project-gantt-milestone")) return;
    const index = dateIndexFromPointer(event);
    const next: ProjectGanttCreateSelection = {
      rowKey,
      phaseId,
      insertAfterPlanItemId,
      pointerId: event.pointerId,
      originIndex: index,
      currentIndex: index,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    createSelectionRef.current = next;
    setCreateSelection(next);
    setMenu(undefined);
    document.body.classList.add("project-gantt-is-selecting");
    event.preventDefault();
  };

  const updateCreateSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = createSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const currentIndex = dateIndexFromPointer(event);
    if (current.currentIndex === currentIndex) return;
    const next = { ...current, currentIndex };
    createSelectionRef.current = next;
    setCreateSelection(next);
  };

  const finishCreateSelection = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = createSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    createSelectionRef.current = undefined;
    setCreateSelection(undefined);
    document.body.classList.remove("project-gantt-is-selecting");
    if (cancelled) return;
    const startIndex = Math.min(current.originIndex, current.currentIndex);
    const endIndex = Math.max(current.originIndex, current.currentIndex);
    onCreatePlanItem(current.phaseId, addProjectDays(rangeStart, startIndex), endIndex - startIndex + 1, current.insertAfterPlanItemId);
  };

  const createTrackHandlers = (rowKey: string, phaseId?: string, insertAfterPlanItemId?: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => startCreateSelection(event, rowKey, phaseId, insertAfterPlanItemId),
    onPointerMove: updateCreateSelection,
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finishCreateSelection(event),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finishCreateSelection(event, true),
  });

  const renderCreateSelection = (rowKey: string) => {
    if (createSelection?.rowKey !== rowKey) return null;
    const startIndex = Math.min(createSelection.originIndex, createSelection.currentIndex);
    const endIndex = Math.max(createSelection.originIndex, createSelection.currentIndex);
    const start = addProjectDays(rangeStart, startIndex);
    const end = addProjectDays(rangeStart, endIndex);
    const duration = endIndex - startIndex + 1;
    const selectionWidth = duration * dayWidth;
    const rangeLabel = formatProjectGanttDragRange(start, end);
    return <div
      className={`project-gantt-create-selection${selectionWidth < 60 ? " compact" : ""}`}
      style={{ left: startIndex * dayWidth, width: selectionWidth }}
      title={rangeLabel}
    ><Plus size={12} />{selectionWidth >= 60 && <span>{selectionWidth < 150 ? `${duration} 天` : rangeLabel}</span>}</div>;
  };

  const dateFromContextEvent = (event: ReactMouseEvent<HTMLElement>): string => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.max(0, Math.min(totalDays - 1, Math.floor((event.clientX - bounds.left) / dayWidth)));
    return addProjectDays(rangeStart, index);
  };

  const openCanvasMenu = (event: ReactMouseEvent<HTMLElement>, phaseId?: string, includeDate = true) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      kind: "canvas",
      x: event.clientX,
      y: event.clientY,
      date: includeDate ? dateFromContextEvent(event) : undefined,
      phaseId,
      returnFocus: event.currentTarget,
    });
  };

  const openPhaseMenu = (event: ReactMouseEvent<HTMLElement>, phase: ClientProjectPhase) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ kind: "phase", x: event.clientX, y: event.clientY, phase, phaseId: phase.id, returnFocus: event.currentTarget });
  };

  const openPlanItemMenu = (event: ReactMouseEvent<HTMLElement>, task: ClientProjectPlanItem) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ kind: "planItem", x: event.clientX, y: event.clientY, planItem: task, phaseId: task.phaseId, returnFocus: event.currentTarget });
  };

  const weekendBands = () => weekendDays.map((entry) => (
    <i className="project-gantt-weekend" key={entry.index} style={{ left: entry.index * dayWidth, width: dayWidth }} />
  ));
  const monthWashes = () => monthSegments.map((segment) => (
    <i className={`project-gantt-month-wash tone-${segment.tone}`} key={segment.key} style={{ left: segment.left, width: segment.width }} />
  ));

  const renderPlanItemRow = (task: ClientProjectPlanItem) => {
    const startIndex = task.plannedStart ? projectDayDifference(rangeStart, task.plannedStart) : 0;
    const durationDays = task.plannedStart && task.plannedEnd
      ? Math.max(1, projectDayDifference(task.plannedStart, task.plannedEnd) + 1)
      : 0;
    const dependencyTitles = task.dependencyIds.map((id) => planItemById.get(id)?.title).filter((title): title is string => Boolean(title));
    const blocked = task.dependencyIds.some((id) => planItemById.get(id)?.status !== "done");
    const statusLabel = blocked ? "受阻" : formatProjectPlanItemStatus(task.status);
    const taskMeta = [
      blocked ? "受阻" : undefined,
      task.autoSchedule ? "自动排期" : dependencyTitles.length > 0 ? `依赖：${dependencyTitles.join("、")}` : undefined,
      task.linkedTaskCount > 0 ? `${task.completedTaskCount}/${task.linkedTaskCount} 个行动已完成` : undefined,
    ].filter(Boolean).join(" · ");
    const statusIcon = blocked
      ? <AlertCircle size={12} />
      : task.status === "planned" ? <Circle size={12} />
      : task.status === "in_progress" ? <ArrowRight size={12} />
      : task.status === "paused" ? <Pause size={12} />
      : task.status === "done" ? <Check size={12} />
      : <X size={12} />;
    const taskPreview = dragPreview?.planItemId === task.id ? dragPreview : undefined;
    const previewStart = taskPreview?.start ?? task.plannedStart;
    const previewEnd = taskPreview?.end ?? task.plannedEnd;
    const previewStartIndex = previewStart ? projectDayDifference(rangeStart, previewStart) : startIndex;
    const previewDurationDays = previewStart && previewEnd ? projectDayDifference(previewStart, previewEnd) + 1 : durationDays;
    const saving = savingPlanItemId === task.id;
    const durationLabel = `${task.durationWorkdays ?? (task.plannedStart && task.plannedEnd ? countProjectDays(task.plannedStart, task.plannedEnd) : 1)} 天`;
    const rowKey = `plan-item:${task.id}`;
    return <div
      className={`project-gantt-row ${task.status === "done" ? "done" : task.status === "cancelled" ? "cancelled" : ""}${rowDrag?.kind === "planItem" && rowDrag.itemId === task.id ? " project-gantt-row-dragging" : ""}${rowDropClass(rowKey)}`}
      key={task.id}
      onDragOver={(event) => dragOverRow(event, rowKey, "planItem", task.id, task.phaseId)}
      onDrop={(event) => dropOnRow(event, "planItem", task.id, task.phaseId)}
    >
      <button className="project-gantt-task" title="拖动调整顺序，点击编辑" disabled={readOnly} draggable={!readOnly && !busy} onDragStart={(event) => startRowDrag(event, { kind: "planItem", itemId: task.id, phaseId: task.phaseId })} onDragEnd={finishRowDrag} onClick={() => openRowAfterClick(() => onEdit(task))} onContextMenu={(event) => openPlanItemMenu(event, task)}><span><strong>{task.title}</strong>{taskMeta && <small className={blocked ? "blocked" : undefined}>{taskMeta}</small>}</span><span className="project-gantt-row-actions"><small className="project-gantt-duration">{durationLabel}</small><GripVertical size={14} /><Pencil size={13} /></span></button>
      <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event, task.phaseId)} {...createTrackHandlers(`plan-item:${task.id}`, task.phaseId, task.id)}>
        {monthWashes()}{weekendBands()}
        {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
        {renderCreateSelection(`plan-item:${task.id}`)}
        {durationDays ? <div
          className={`project-gantt-bar status-${task.status}${blocked ? " blocked" : ""}${taskPreview ? ` dragging ${taskPreview.mode}` : ""}${saving ? " saving" : ""}`}
          role="button"
          tabIndex={readOnly ? -1 : 0}
          aria-disabled={readOnly || saving}
          aria-label={`编辑计划项：${task.title}，${statusLabel}，${previewStart} 至 ${previewEnd}`}
          title={`${task.title} · ${statusLabel}：${previewStart} – ${previewEnd}`}
          style={{ left: previewStartIndex * dayWidth, width: previewDurationDays * dayWidth, "--project-gantt-task-color": projectColor } as CSSProperties}
          onContextMenu={(event) => openPlanItemMenu(event, task)}
          onClick={() => { if (!readOnly) openPlanItemAfterClick(task); }}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && !readOnly && !saving) {
              event.preventDefault();
              onEdit(task);
            }
          }}
          onPointerDown={(event) => startDrag(event, task, "move", startIndex, durationDays)}
          onPointerMove={(event) => updateDragPreview(event.clientX)}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
        >
          {!readOnly && <button
            type="button"
            className="project-gantt-resize-handle start"
            aria-label={`调整“${task.title}”的开始日期`}
            title="拖动调整开始日期"
            onClick={(event) => { event.stopPropagation(); openPlanItemAfterClick(task); }}
            onPointerDown={(event) => startDrag(event, task, "resize-start", startIndex, durationDays)}
            onPointerMove={(event) => updateDragPreview(event.clientX)}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
          />}
          <i className="project-gantt-bar-status" aria-hidden="true">{saving ? <LoaderCircle className="spin" size={12} /> : statusIcon}</i>
          <span>{taskPreview ? formatProjectGanttDragRange(previewStart!, previewEnd!) : task.title}</span>
          {!readOnly && <button
            type="button"
            className="project-gantt-resize-handle end"
            aria-label={`调整“${task.title}”的结束日期`}
            title="拖动调整结束日期"
            onClick={(event) => { event.stopPropagation(); openPlanItemAfterClick(task); }}
            onPointerDown={(event) => startDrag(event, task, "resize-end", startIndex, durationDays)}
            onPointerMove={(event) => updateDragPreview(event.clientX)}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
          />}
        </div> : <button className="project-gantt-unscheduled" disabled={readOnly} onClick={() => onEdit(task)} onContextMenu={(event) => openPlanItemMenu(event, task)}>设置计划日期</button>}
      </div>
    </div>;
  };

  const renderMilestoneRow = (milestone: ClientProjectMilestone) => {
    const preview = milestoneDragPreview?.milestoneId === milestone.id ? milestoneDragPreview : undefined;
    const displayDate = preview?.date ?? milestone.dueOn;
    const offset = displayDate ? projectDayDifference(rangeStart, displayDate) * dayWidth : undefined;
    const saving = savingMilestoneId === milestone.id;
    const rowKey = `milestone:${milestone.id}`;
    return <div
      className={`project-gantt-row project-gantt-milestone-row ${milestone.status === "done" ? "done" : ""}${rowDrag?.kind === "milestone" && rowDrag.itemId === milestone.id ? " project-gantt-row-dragging" : ""}${rowDropClass(rowKey)}`}
      key={rowKey}
      onDragOver={(event) => dragOverRow(event, rowKey, "milestone", milestone.id, milestone.phaseId)}
      onDrop={(event) => dropOnRow(event, "milestone", milestone.id, milestone.phaseId)}
    >
      <button className="project-gantt-task" title="拖动调整阶段和顺序，点击编辑" disabled={readOnly} draggable={!readOnly && !busy} onDragStart={(event) => startRowDrag(event, { kind: "milestone", itemId: milestone.id, phaseId: milestone.phaseId })} onDragEnd={finishRowDrag} onClick={() => openRowAfterClick(() => onEditMilestone(milestone))} onContextMenu={(event) => openCanvasMenu(event, milestone.phaseId, false)}><span><strong>{milestone.title}</strong><small>里程碑 · {displayDate ? formatProjectMilestoneDate(displayDate) : "未设置日期"}</small></span><span className="project-gantt-row-actions"><GripVertical size={14} /><Award size={13} /></span></button>
      <div className="project-gantt-track" onContextMenu={(event) => openCanvasMenu(event, milestone.phaseId)}>
        {monthWashes()}{weekendBands()}
        {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
        {offset === undefined
          ? <button className="project-gantt-unscheduled" disabled={readOnly} onClick={() => onEditMilestone(milestone)}>设置目标日期</button>
          : <button
            className={`project-gantt-milestone${preview ? " dragging" : ""}${saving ? " saving" : ""}`}
            disabled={readOnly || saving}
            title={`拖动调整日期：${milestone.title} · ${displayDate}`}
            style={{ left: offset, background: projectColor }}
            onClick={() => openMilestoneAfterClick(milestone)}
            onPointerDown={(event) => startMilestoneDrag(event, milestone)}
            onPointerMove={(event) => updateMilestoneDragPreview(event.clientX)}
            onPointerUp={(event) => finishMilestoneDrag(event)}
            onPointerCancel={(event) => finishMilestoneDrag(event, true)}
          >{saving ? <LoaderCircle className="spin" size={11} /> : <Award size={11} />}</button>}
      </div>
    </div>;
  };

  const menuCommands: readonly ResolvedContextCommand[] = menu?.kind === "planItem" ? [
    { id: "gantt.edit-plan-item", label: "编辑计划项", group: "primary", risk: "local-write", icon: "edit", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.delete-plan-item", label: "删除计划项", group: "danger", risk: "destructive", icon: "trash", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
  ] : menu?.kind === "phase" ? [
    { id: "gantt.add-plan-item", label: "在阶段中添加计划项", group: "primary", risk: "local-write", icon: "task", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.add-milestone", label: "在阶段中添加里程碑", group: "primary", risk: "local-write", icon: "calendar-plus", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.edit-phase", label: "重命名或更改颜色", group: "organize", risk: "local-write", icon: "edit", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.delete-phase", label: "删除阶段", group: "danger", risk: "destructive", icon: "trash", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
  ] : [
    { id: "gantt.add-plan-item", label: menu?.date ? `在 ${formatProjectMilestoneDate(menu.date)} 添加计划项` : "添加计划项", group: "primary", risk: "local-write", icon: "task", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.add-milestone", label: menu?.date ? `在 ${formatProjectMilestoneDate(menu.date)} 添加里程碑` : "添加里程碑", group: "primary", risk: "local-write", icon: "calendar-plus", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.add-phase", label: "添加阶段", group: "organize", risk: "local-write", icon: "folder", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
  ];

  const selectMenuCommand = (commandId: ContextCommandId) => {
    const ganttCommand = commandId as ProjectTimelineCommandId;
    if (ganttCommand === "gantt.add-plan-item") onCreatePlanItem(menu?.phase?.id ?? menu?.phaseId, menu?.date);
    else if (ganttCommand === "gantt.add-milestone") onCreateMilestone(menu?.date, menu?.phase?.id ?? menu?.phaseId);
    else if (ganttCommand === "gantt.add-phase") onCreatePhase();
    else if (ganttCommand === "gantt.edit-plan-item" && menu?.planItem) onEdit(menu.planItem);
    else if (ganttCommand === "gantt.delete-plan-item" && menu?.planItem) onDeletePlanItem(menu.planItem);
    else if (ganttCommand === "gantt.edit-phase" && menu?.phase) onEditPhase(menu.phase);
    else if (ganttCommand === "gantt.delete-phase" && menu?.phase) onDeletePhase(menu.phase);
  };

  return (
    <section className="panel project-gantt">
      <header>
        <div className="project-gantt-title"><CalendarClock size={17} /><span><strong><span className="project-gantt-desktop-label">项目甘特图</span><span className="project-gantt-mobile-label">项目计划</span></strong></span></div>
        <div className="project-gantt-toolbar" aria-label="甘特图视图控制">
          <button type="button" onClick={scrollToToday}>今天</button>
          <button type="button" onClick={fitTimeline}>适应项目</button>
          <span className="project-gantt-zoom">
            <button type="button" aria-label="缩小甘特图" title="缩小" disabled={dayWidth <= PROJECT_GANTT_MIN_DAY_WIDTH} onClick={() => applyZoom(dayWidthRef.current - PROJECT_GANTT_ZOOM_STEP)}>−</button>
            <output title={`${dayWidth.toFixed(1)} 像素/天`}>{Math.round(dayWidth / PROJECT_GANTT_DEFAULT_DAY_WIDTH * 100)}%</output>
            <button type="button" aria-label="放大甘特图" title="放大" disabled={dayWidth >= PROJECT_GANTT_MAX_DAY_WIDTH} onClick={() => applyZoom(dayWidthRef.current + PROJECT_GANTT_ZOOM_STEP)}>+</button>
          </span>
        </div>
      </header>
      <div className="project-gantt-scroll" ref={scrollRef}>
        <div className="project-gantt-table" style={{ "--gantt-width": `${timelineWidth}px`, "--gantt-day-width": `${dayWidth}px`, "--gantt-week-width": `${dayWidth * 7}px` } as CSSProperties}>
          <div className="project-gantt-heading">
            <div className="project-gantt-task-heading" onContextMenu={(event) => openCanvasMenu(event, undefined, false)}>阶段、计划项</div>
            <div className="project-gantt-time-heading" onContextMenu={(event) => openCanvasMenu(event)}>
              <div className="project-gantt-month-bands" aria-hidden="true">{monthSegments.map((segment) => <span className={`tone-${segment.tone}`} key={segment.key} style={{ left: segment.left, width: segment.width }} />)}</div>
              <div className="project-gantt-week-labels">{weekendBands()}{monthSegments.map((segment) => <span className="project-gantt-month-label" key={segment.key} style={{ left: segment.left }}>{segment.label}</span>)}</div>
            </div>
          </div>
          {orderedPhases.flatMap((phase) => {
            const phasePlanItems = sortPlanItems(planItems.filter((planItem) => planItem.phaseId === phase.id));
            const phaseMilestones = sortMilestones(milestones.filter((milestone) => milestone.phaseId === phase.id));
            const collapsed = collapsedPhaseIds.has(phase.id);
            const scheduledPhasePlanItems = phasePlanItems.filter((task) => task.plannedStart && task.plannedEnd);
            const phaseDates = [
              ...scheduledPhasePlanItems.flatMap((task) => [task.plannedStart!, task.plannedEnd!]),
              ...phaseMilestones.flatMap((milestone) => milestone.dueOn ? [milestone.dueOn] : []),
            ].sort();
            const phaseStart = phaseDates[0];
            const phaseEnd = phaseDates.at(-1);
            const completed = phasePlanItems.filter((task) => task.status === "done").length;
            const phasePlanItemCount = phasePlanItems.filter((task) => task.status !== "cancelled").length;
            const completionPercent = phasePlanItemCount ? Math.round((completed / phasePlanItemCount) * 100) : 0;
            const phaseRowKey = `phase:${phase.id}`;
            const phaseRow = <div
              className={`project-gantt-row project-gantt-phase-row${rowDropClass(phaseRowKey)}`}
              key={phaseRowKey}
              onDragOver={(event) => dragOverRow(event, phaseRowKey, "phase", phase.id, phase.id)}
              onDrop={(event) => dropOnRow(event, "phase", phase.id, phase.id)}
            >
              <button className="project-gantt-task project-gantt-phase" disabled={readOnly} onClick={() => setCollapsedPhaseIds((current) => {
                const next = new Set(current);
                if (next.has(phase.id)) next.delete(phase.id);
                else next.add(phase.id);
                return next;
              })} onContextMenu={(event) => openPhaseMenu(event, phase)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<i style={{ background: phase.color }} /><span><strong>{phase.name}</strong><small>{phasePlanItemCount} 个计划项 · {phaseMilestones.length} 个里程碑 · {completionPercent}%</small></span><MoreHorizontal size={13} /></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event, phase.id)} {...createTrackHandlers(`phase:${phase.id}`, phase.id)}>
                {monthWashes()}{weekendBands()}
                {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
                {renderCreateSelection(`phase:${phase.id}`)}
                {phaseStart && phaseEnd && <div className="project-gantt-phase-bar" style={{ left: projectDayDifference(rangeStart, phaseStart) * dayWidth, width: (projectDayDifference(phaseStart, phaseEnd) + 1) * dayWidth, borderColor: phase.color }}><i style={{ width: `${completionPercent}%`, background: phase.color }} /></div>}
              </div>
            </div>;
            return collapsed ? [phaseRow] : [phaseRow, ...phasePlanItems.map(renderPlanItemRow), ...phaseMilestones.map(renderMilestoneRow)];
          })}
          {(ungroupedPlanItems.length > 0 || ungroupedMilestones.length > 0 || rowDrag?.kind === "milestone" || (!planItems.length && !phases.length && !milestones.length)) && <>
            {phases.length > 0 && <div
              className={`project-gantt-row project-gantt-phase-row project-gantt-ungrouped-row${rowDropClass("phase:project")}`}
              onDragOver={(event) => dragOverRow(event, "phase:project", "phase", undefined, undefined)}
              onDrop={(event) => dropOnRow(event, "phase", undefined, undefined)}
            >
              <button className="project-gantt-task project-gantt-phase" disabled={readOnly} onContextMenu={(event) => openCanvasMenu(event, undefined, false)}><FolderPlus size={14} /><span><strong>项目级 / 未分组</strong><small>{ungroupedPlanItems.length} 个计划项 · {ungroupedMilestones.length} 个里程碑</small></span></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event)} {...createTrackHandlers("ungrouped")}>{monthWashes()}{weekendBands()}{todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}{renderCreateSelection("ungrouped")}</div>
            </div>}
            {ungroupedPlanItems.map(renderPlanItemRow)}
            {ungroupedMilestones.map(renderMilestoneRow)}
            {!planItems.length && !phases.length && !milestones.length && <div className="project-gantt-row project-gantt-empty-row">
              <button className="project-gantt-task" disabled={readOnly} onClick={() => onCreatePlanItem()} onContextMenu={(event) => openCanvasMenu(event, undefined, false)}><span><strong>还没有计划项</strong></span><Plus size={14} /></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event)} {...createTrackHandlers("empty")}>{monthWashes()}{weekendBands()}{todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}{renderCreateSelection("empty")}</div>
            </div>}
          </>}
        </div>
      </div>
      <footer><span><i style={{ background: projectColor }} />计划项</span><span><i className="weekend" />周末</span><span><i className="today" />今天</span><small>{readOnly ? "已归档项目为只读。" : "拖动调整日期 · 右键管理 · Ctrl + 滚轮缩放"}</small></footer>
      {menu && <ContextMenu anchor={{ x: menu.x, y: menu.y }} ariaLabel="甘特图操作" commands={menuCommands} heading={menu.planItem?.title ?? menu.phase?.name ?? (menu.date ? formatProjectMilestoneDate(menu.date) : "项目甘特图")} returnFocus={menu.returnFocus} testId="project-gantt-context-menu" onClose={() => setMenu(undefined)} onSelect={selectMenuCommand} />}
    </section>
  );
}

function projectDateToUtcTime(value: string): number {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}

function projectDateFromUtcTime(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function projectDayDifference(start: string, end: string): number {
  return Math.round((projectDateToUtcTime(end) - projectDateToUtcTime(start)) / 86_400_000);
}

function addProjectDays(value: string, days: number): string {
  return projectDateFromUtcTime(projectDateToUtcTime(value) + days * 86_400_000);
}

function countProjectDays(start: string, end: string): number {
  return Math.max(1, projectDayDifference(start, end) + 1);
}

function formatProjectGanttDragRange(start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", timeZone: "UTC" });
  return `${formatter.format(new Date(projectDateToUtcTime(start)))} – ${formatter.format(new Date(projectDateToUtcTime(end)))}`;
}

function toDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatProjectBlockDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatProjectMilestoneDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`));
}
