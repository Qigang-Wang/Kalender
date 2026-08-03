"use client";

import Link from "next/link";
import {
  AlertCircle, Archive, ArrowRight, Award, CalendarClock, CalendarDays, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock3,
  FileText, Folder, FolderPlus, GripVertical, LayoutGrid, Link2, ListChecks,
  LoaderCircle, Mail, MoreHorizontal, NotebookPen, Pencil, Pin, Plus,
  RefreshCw, Star, Trash2, X,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { appConfirm } from "@/components/app-dialog-provider";
import { useRealtimeRefresh } from "@/components/realtime-context";
import { AppSelect } from "../app-select";
import { ContextMenu } from "../context-menu";
import {
  resolveContextCommands,
  type ContextCommandId,
  type ProjectGanttCommandId,
  type ResolvedContextCommand,
} from "../context-commands";
import { TransientToast } from "../workspace-shared";
import { RelatedContentPanel } from "./related-content";

const TASKS_CHANGED_EVENT = "kalender:tasks-changed";
const PROJECTS_CHANGED_EVENT = "kalender:projects-changed";
const OPEN_PROJECT_DIALOG_EVENT = "kalender:open-project-dialog";
const EDIT_PROJECT_DIALOG_EVENT = "kalender:edit-project-dialog";

type TaskStatus = "inbox" | "next" | "waiting" | "someday" | "done";
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
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly phaseId?: string;
  readonly durationWorkdays?: number;
  readonly autoSchedule: boolean;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
  readonly areaName?: string;
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
  readonly ganttTasks: readonly ClientProjectGanttTask[];
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

interface ClientProjectGanttTask extends ClientTask {
  readonly dependencyIds: readonly string[];
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
  readonly title: string;
  readonly dueOn: string;
  readonly status: ClientProjectMilestone["status"];
}

interface ProjectGanttPlanDraft {
  readonly taskId: string;
  readonly taskTitle: string;
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

interface ProjectGanttTaskDraft {
  readonly title: string;
  readonly phaseId: string;
  readonly plannedStart: string;
  readonly durationWorkdays: number;
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
  const [ganttDraft, setGanttDraft] = useState<ProjectGanttPlanDraft>();
  const [phaseDraft, setPhaseDraft] = useState<ProjectPhaseDraft>();
  const [ganttTaskDraft, setGanttTaskDraft] = useState<ProjectGanttTaskDraft>();
  const [projectView, setProjectView] = useState<"overview" | "gantt">("overview");
  const [projectMembers, setProjectMembers] = useState<readonly ClientProjectMember[]>([]);
  const [collaborators, setCollaborators] = useState<readonly ClientCollaborator[]>([]);
  const [memberDraftUserId, setMemberDraftUserId] = useState("");
  const [memberDraftAccess, setMemberDraftAccess] = useState<"viewer" | "editor">("viewer");

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

  const loadOverview = useCallback(async (projectId: string) => {
    const response = await workspaceFetch(`/api/projects/${encodeURIComponent(projectId)}`, {}, 1_000);
    const payload = await response.json() as { readonly ok?: boolean; readonly overview?: ClientProjectOverview; readonly message?: string };
    if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "无法读取项目概况");
    setOverview(payload.overview);
  }, []);

  const loadProjectMembers = useCallback(async (projectId: string) => {
    const [membersResponse, collaboratorsResponse] = await Promise.all([
      workspaceFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {}, 1_000),
      workspaceFetch("/api/collaborators", {}, 1_000),
    ]);
    const membersPayload = await membersResponse.json() as { readonly ok?: boolean; readonly members?: readonly ClientProjectMember[]; readonly message?: string };
    const collaboratorsPayload = await collaboratorsResponse.json() as { readonly ok?: boolean; readonly users?: readonly ClientCollaborator[]; readonly message?: string };
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

  useEffect(() => {
    if (!selectedProjectId) {
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

  const saveMembers = async (members: readonly ClientProjectMember[]) => {
    if (!overview || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(overview.project.id)}/members`, {
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

  const toggleMilestone = async (milestone: ClientProjectMilestone) => {
    if (!overview || busy || overview.project.status === "archived") return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(overview.project.id)}/milestones/${encodeURIComponent(milestone.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: milestone.title,
          dueOn: milestone.dueOn,
          status: milestone.status === "done" ? "active" : "done",
          sortOrder: milestone.sortOrder,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法更新里程碑");
      await loadOverview(overview.project.id);
      setFeedback(milestone.status === "done" ? "里程碑已重新打开" : "里程碑已完成");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法更新里程碑");
    } finally {
      setBusy(false);
    }
  };

  const saveGanttPlan = async () => {
    if (!overview || !ganttDraft || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(overview.project.id)}/gantt/${encodeURIComponent(ganttDraft.taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ganttDraft),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly overview?: ClientProjectOverview; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "无法保存甘特计划");
      setOverview(payload.overview);
      setGanttDraft(undefined);
      setFeedback("任务计划已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存甘特计划");
    } finally {
      setBusy(false);
    }
  };

  const saveGanttDates = async (
    task: ClientProjectGanttTask,
    plannedStart: string,
    plannedEnd: string,
  ): Promise<boolean> => {
    if (!overview || busy || overview.project.status === "archived") return false;
    const snapshot = overview;
    setBusy(true);
    setOverview({
      ...overview,
      tasks: overview.tasks.map((entry) => entry.id === task.id ? { ...entry, plannedStart, plannedEnd } : entry),
      ganttTasks: overview.ganttTasks.map((entry) => entry.id === task.id ? { ...entry, plannedStart, plannedEnd } : entry),
    });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(overview.project.id)}/gantt/${encodeURIComponent(task.id)}`, {
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
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: ClientProjectGanttTask; readonly overview?: ClientProjectOverview; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task || !payload.overview) throw new Error(payload.message ?? "无法保存甘特计划");
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
      description: "阶段中的任务会保留，并移动到“未分组”。",
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
      setFeedback("阶段已删除，任务已移到未分组");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除阶段");
    } finally {
      setBusy(false);
    }
  };

  const createGanttTask = async () => {
    if (!overview || !ganttTaskDraft?.title.trim() || busy) return;
    setBusy(true);
    try {
      const createResponse = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ganttTaskDraft.title,
          status: "next",
          important: false,
          urgencyMode: "auto",
          projectId: overview.project.id,
        }),
      });
      const createPayload = await readProjectApiResponse<{
        readonly ok?: boolean;
        readonly task?: ClientTask;
        readonly message?: string;
      }>(createResponse, "无法创建任务");
      if (!createResponse.ok || !createPayload.ok || !createPayload.task) {
        throw new Error(createPayload.message ?? "无法创建任务");
      }
      const plannedEnd = ganttTaskDraft.plannedStart
        ? addProjectDays(ganttTaskDraft.plannedStart, ganttTaskDraft.durationWorkdays - 1)
        : undefined;
      const planResponse = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/gantt/${encodeURIComponent(createPayload.task.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plannedStart: ganttTaskDraft.plannedStart || undefined,
            plannedEnd,
            dependencyIds: [],
            phaseId: ganttTaskDraft.phaseId || null,
            durationWorkdays: ganttTaskDraft.durationWorkdays,
            autoSchedule: false,
          }),
        },
      );
      const planPayload = await readProjectApiResponse<{ readonly ok?: boolean; readonly message?: string }>(
        planResponse,
        "无法设置任务计划",
      );
      if (!planResponse.ok || !planPayload.ok) throw new Error(planPayload.message ?? "无法设置任务计划");
      await loadOverview(overview.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setGanttTaskDraft(undefined);
      setFeedback("任务已添加到甘特图");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建任务");
    } finally {
      setBusy(false);
    }
  };

  const deleteGanttTask = async (task: ClientProjectGanttTask) => {
    if (!overview || busy || !await appConfirm({
      title: `永久删除任务“${task.title}”？`,
      description: "相关依赖和日历时间块也会一并移除，此操作无法撤销。",
      confirmLabel: "永久删除",
      tone: "danger",
    })) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly message?: string }>(
        response,
        "无法删除任务",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除任务");
      await loadOverview(overview.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback("任务已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除任务");
    } finally {
      setBusy(false);
    }
  };

  const openTasks = overview?.tasks.filter((task) => task.status !== "done") ?? [];
  const upcomingBlocks = overview?.scheduledBlocks.filter((block) => new Date(block.end).getTime() >= Date.now()).slice(0, 6) ?? [];

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
          <section className="project-hero panel">
            <header>
              <div className="project-identity"><i style={{ background: overview.project.color }} /><div><span>{overview.project.areaName ?? "未设置领域"} · {overview.project.status === "archived" ? "已归档" : "进行中"}</span><h1>{overview.project.name}</h1>{overview.project.description && <p>{overview.project.description}</p>}</div></div>
              <button className="secondary-button" onClick={() => { setProjectDialogError(undefined); setProjectDraft({ id: overview.project.id, name: overview.project.name, description: overview.project.description ?? "", areaName: overview.project.areaName ?? "", color: overview.project.color, status: overview.project.status }); }}><Pencil size={14} />编辑项目</button>
            </header>
            <div className="project-progress"><div><span>任务进度</span><strong>{overview.stats.completionPercent}%</strong></div><i><b style={{ width: `${overview.stats.completionPercent}%`, background: overview.project.color }} /></i></div>
          </section>

          <section className="panel project-share-panel">
            <header><div><Users size={16} /><span><strong>共享成员</strong><small>{projectMembers.length ? `${projectMembers.length} 位成员` : "仅项目所有者可见"}</small></span></div></header>
            <div className="project-share-members">
              {projectMembers.map((member) => <span key={member.userId}><strong>{member.displayName}</strong><small>{member.accessLevel === "editor" ? "可编辑" : "只读"}</small><button aria-label={`移除 ${member.displayName}`} disabled={busy} onClick={() => void saveMembers(projectMembers.filter((entry) => entry.userId !== member.userId))}><X size={12} /></button></span>)}
            </div>
            <div className="project-share-form">
              <AppSelect ariaLabel="选择项目成员" size="compact" value={memberDraftUserId} onValueChange={setMemberDraftUserId} options={[{ value: "", label: "选择用户" }, ...collaborators.filter((user) => !projectMembers.some((member) => member.userId === user.id)).map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))]} />
              <AppSelect ariaLabel="项目成员权限" size="compact" value={memberDraftAccess} onValueChange={(access) => setMemberDraftAccess(access === "editor" ? "editor" : "viewer")} options={[{ value: "viewer", label: "只读" }, { value: "editor", label: "可编辑" }]} />
              <button className="secondary-button" disabled={!memberDraftUserId || busy} onClick={() => {
                const user = collaborators.find((entry) => entry.id === memberDraftUserId);
                if (!user) return;
                setMemberDraftUserId("");
                void saveMembers([...projectMembers, { userId: user.id, displayName: user.displayName, email: user.email, accessLevel: memberDraftAccess }]);
              }}><Plus size={14} />添加成员</button>
            </div>
          </section>

          <nav className="project-view-tabs" aria-label="项目视图"><button className={projectView === "overview" ? "active" : ""} onClick={() => setProjectView("overview")}><LayoutGrid size={14} />概况</button><button className={projectView === "gantt" ? "active" : ""} onClick={() => setProjectView("gantt")}><CalendarClock size={14} />甘特图</button></nav>

          {projectView === "overview" ? <>
          <section className="project-stats" aria-label="项目统计">
            <article className="panel"><CheckCircle2 size={17} /><div><strong>{overview.stats.openTaskCount}</strong><span>待完成任务</span></div></article>
            <article className="panel"><Circle size={17} /><div><strong>{overview.stats.completedTaskCount}</strong><span>已完成任务</span></div></article>
            <article className="panel"><NotebookPen size={17} /><div><strong>{overview.stats.noteCount}</strong><span>项目笔记</span></div></article>
            <article className="panel"><Clock3 size={17} /><div><strong>{formatProjectMinutes(overview.stats.scheduledMinutes)}</strong><span>已安排时间</span></div></article>
          </section>

          <section className="panel project-milestone-timeline">
            <header><div><Award size={17} /><span><strong>里程碑</strong><small>关键节点会与任务甘特计划共同表达项目节奏</small></span></div><button disabled={overview.project.status === "archived"} onClick={() => setMilestoneDraft({ title: "", dueOn: "", status: "planned" })}><Plus size={14} />添加里程碑</button></header>
            {overview.milestones.length ? <ol>{overview.milestones.map((milestone) => <li className={milestone.status === "done" ? "done" : milestone.status === "active" ? "active" : ""} key={milestone.id}><button className="milestone-check" aria-label={milestone.status === "done" ? `重新打开里程碑：${milestone.title}` : `完成里程碑：${milestone.title}`} disabled={busy || overview.project.status === "archived"} onClick={() => void toggleMilestone(milestone)}>{milestone.status === "done" ? <Check size={13} /> : <Circle size={12} />}</button><i /><button className="milestone-body" onClick={() => setMilestoneDraft({ id: milestone.id, title: milestone.title, dueOn: milestone.dueOn ?? "", status: milestone.status })}><strong>{milestone.title}</strong><small>{milestone.dueOn ? formatProjectMilestoneDate(milestone.dueOn) : "未设置日期"} · {milestone.status === "done" ? "已完成" : milestone.status === "active" ? "进行中" : "计划中"}</small></button></li>)}</ol> : <div className="project-milestone-empty"><span>从第一个关键交付节点开始，例如“完成原型”或“提交论文初稿”。</span></div>}
          </section>

          <div className="project-content-grid">
            <section className="panel project-actions-panel">
              <header><div><ListChecks size={16} /><span><strong>下一步行动</strong><small>{openTasks.length} 项待推进</small></span></div><Link href="/tasks">查看全部</Link></header>
              {overview.project.status === "active" && <form onSubmit={(event) => { event.preventDefault(); void createQuickTask(); }}><Plus size={15} /><input value={quickTaskTitle} maxLength={240} onChange={(event) => setQuickTaskTitle(event.target.value)} placeholder="快速添加下一步行动…" /><button disabled={busy || !quickTaskTitle.trim()}>添加</button></form>}
              <div className="project-action-list">{openTasks.slice(0, 7).map((task) => <Link href={`/tasks?task=${encodeURIComponent(task.id)}`} key={task.id}><span className={`project-task-status ${task.isUrgent ? "urgent" : ""}`}><Check size={12} /></span><span><strong>{task.title}</strong><small>{task.dueAt ? formatTaskDue(task.dueAt) : task.estimatedMinutes ? formatTaskEstimate(task.estimatedMinutes) : task.status === "waiting" ? "等待中" : "未设置截止时间"}</small></span>{task.important && <Star size={13} fill="currentColor" />}</Link>)}{!openTasks.length && <div className="project-panel-empty"><CheckCircle2 size={20} /><span>当前没有待推进任务</span></div>}</div>
            </section>

            <section className="panel project-notes-panel">
              <header><div><NotebookPen size={16} /><span><strong>项目笔记</strong><small>决策、资料与过程记录</small></span></div><button disabled={busy || overview.project.status === "archived"} onClick={() => void createProjectNote()}><Plus size={14} />新建</button></header>
              <div>{overview.notes.slice(0, 6).map((note) => <Link href={`/notes?note=${encodeURIComponent(note.id)}`} key={note.id}><FileText size={15} /><span><strong>{note.title}</strong><small>{formatNoteUpdated(note.updatedAt)}</small></span>{note.pinned && <Pin size={12} fill="currentColor" />}</Link>)}{!overview.notes.length && <div className="project-panel-empty"><NotebookPen size={20} /><span>还没有项目笔记</span></div>}</div>
            </section>

            <section className="panel project-schedule-panel">
              <header><div><CalendarClock size={16} /><span><strong>时间安排</strong><small>未来的专注时间块</small></span></div><Link href="/calendar">打开日历</Link></header>
              <div>{upcomingBlocks.map((block) => <Link href={block.href} key={block.eventId}><time dateTime={block.start}>{formatProjectBlockDate(block.start)}</time><span><strong>{block.taskTitle}</strong><small>{formatTaskBlockRange(block.start, block.end)} · {block.calendarName}</small></span></Link>)}{!upcomingBlocks.length && <div className="project-panel-empty"><CalendarClock size={20} /><span>尚未安排专注时间</span></div>}</div>
            </section>

            <section className={`panel project-review-panel ${overview.review.isStalled ? "stalled" : ""}`}>
              <header><div><RefreshCw size={16} /><span><strong>本周复盘</strong><small>{overview.review.isStalled ? "项目超过 7 天没有推进" : `最近活动 ${formatNoteUpdated(overview.review.lastActivityAt)}`}</small></span></div><Link href="/tasks">整理行动</Link></header>
              <div>
                <article><strong>{overview.review.completedLast7DaysCount}</strong><span>近 7 天完成</span></article>
                <article className={overview.review.overdueTaskCount ? "attention" : ""}><strong>{overview.review.overdueTaskCount}</strong><span>已经逾期</span></article>
                <article><strong>{overview.review.dueNext7DaysCount}</strong><span>未来 7 天到期</span></article>
                <article><strong>{overview.review.unscheduledOpenTaskCount}</strong><span>尚未安排时间</span></article>
              </div>
              <p>{overview.review.isStalled ? "建议选择一个最小下一步，或重新评估项目是否需要继续。" : overview.review.overdueTaskCount ? "先处理逾期事项，再为未来一周保留专注时间。" : "项目节奏正常。复盘时确认下一里程碑和最重要的一项行动。"}</p>
            </section>
          </div>
          <section className="panel project-related-panel"><RelatedContentPanel kind="project" entityId={overview.project.id} emptyText="项目还没有关联内容。" /></section>
          </> : <ProjectGanttChart
            projectId={overview.project.id}
            tasks={overview.ganttTasks}
            phases={overview.phases}
            milestones={overview.milestones}
            projectColor={overview.project.color}
            readOnly={overview.project.status === "archived"}
            busy={busy}
            onChangeDates={saveGanttDates}
            onEdit={(task) => setGanttDraft(createProjectGanttDraft(task))}
            onEditMilestone={(milestone) => setMilestoneDraft({ id: milestone.id, title: milestone.title, dueOn: milestone.dueOn ?? "", status: milestone.status })}
            onCreateMilestone={(dueOn) => setMilestoneDraft({ title: "", dueOn: dueOn ?? "", status: "planned" })}
            onCreateTask={(phaseId, plannedStart, durationWorkdays = 1) => setGanttTaskDraft({ title: "", phaseId: phaseId ?? "", plannedStart: plannedStart ?? "", durationWorkdays })}
            onDeleteTask={(task) => void deleteGanttTask(task)}
            onCreatePhase={() => setPhaseDraft({ name: "", color: overview.project.color, sortOrder: overview.phases.length })}
            onEditPhase={(phase) => setPhaseDraft({ id: phase.id, name: phase.name, color: phase.color, sortOrder: phase.sortOrder })}
            onDeletePhase={(phase) => void deletePhase(phase)}
          />}
        </> : <section className="panel project-empty-state"><FolderPlus size={26} /><h2>建立第一个项目</h2><p>项目会把任务、笔记和专注时间组织在同一个目标下。</p><button className="primary-button" onClick={() => { setProjectDialogError(undefined); setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5", status: "active" }); }}><Plus size={14} />新建项目</button></section>}
      </main>

      {projectDraft && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setProjectDialogError(undefined); setProjectDraft(undefined); } }}>
        <section className="calendar-dialog note-project-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-management-dialog-title">
          <header><div><h2 id="project-management-dialog-title">{projectDraft.id ? "编辑项目" : "新建项目"}</h2></div><button aria-label="关闭" onClick={() => { setProjectDialogError(undefined); setProjectDraft(undefined); }} disabled={busy}><X size={18} /></button></header>
          <div className="note-project-form">
            {projectDialogError && <div className="project-dialog-error" role="alert"><AlertCircle size={15} /><span><strong>{projectDraft.id ? "保存失败" : "创建失败"}</strong><small>{projectDialogError}</small></span></div>}
            <label><span>项目名称</span><input autoFocus value={projectDraft.name} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="例如 博士论文" /></label>
            <label><span>领域</span><input value={projectDraft.areaName} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, areaName: event.target.value })} placeholder="例如 研究 / 个人" /></label>
            <label className="note-project-color"><span>颜色</span><input type="color" value={projectDraft.color} onChange={(event) => setProjectDraft({ ...projectDraft, color: event.target.value })} /></label>
            {projectDraft.id && <label><span>状态</span><AppSelect ariaLabel="项目状态" value={projectDraft.status} onValueChange={(status) => setProjectDraft({ ...projectDraft, status: status as "active" | "archived" })} options={[{ value: "active", label: "进行中" }, { value: "archived", label: "已归档" }]} /></label>}
            <label className="note-project-description"><span>项目说明</span><textarea value={projectDraft.description} maxLength={2_000} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} placeholder="这个项目要达成什么？完成标准是什么？" /></label>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => { setProjectDialogError(undefined); setProjectDraft(undefined); }}>取消</button><button className="primary-button" disabled={busy || !projectDraft.name.trim()} onClick={() => void saveProject()}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? (projectDraft.id ? "保存中" : "创建中") : (projectDraft.id ? "保存修改" : "创建项目")}</button></div></footer>
        </section>
      </div>}
      {milestoneDraft && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setMilestoneDraft(undefined); }}>
        <section className="calendar-dialog project-milestone-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-milestone-dialog-title">
          <header><div><h2 id="project-milestone-dialog-title">{milestoneDraft.id ? "编辑里程碑" : "新建里程碑"}</h2></div><button aria-label="关闭" onClick={() => setMilestoneDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-milestone-form">
            <label className="wide"><span>标题</span><input autoFocus value={milestoneDraft.title} maxLength={240} onChange={(event) => setMilestoneDraft({ ...milestoneDraft, title: event.target.value })} placeholder="例如 完成无人机飞行原型" /></label>
            <label><span>目标日期</span><input type="date" value={milestoneDraft.dueOn} onChange={(event) => setMilestoneDraft({ ...milestoneDraft, dueOn: event.target.value })} /></label>
            <label><span>状态</span><AppSelect ariaLabel="里程碑状态" value={milestoneDraft.status} onValueChange={(status) => setMilestoneDraft({ ...milestoneDraft, status: status as ClientProjectMilestone["status"] })} options={[{ value: "planned", label: "计划中" }, { value: "active", label: "进行中" }, { value: "done", label: "已完成" }]} /></label>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => setMilestoneDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !milestoneDraft.title.trim()} onClick={() => void saveMilestone()}>{busy && <LoaderCircle className="spin" size={14} />}{milestoneDraft.id ? "保存修改" : "添加里程碑"}</button></div></footer>
        </section>
      </div>}
      {ganttDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setGanttDraft(undefined); }}>
        <section className="calendar-dialog project-gantt-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-gantt-dialog-title">
          <header><div><h2 id="project-gantt-dialog-title">{ganttDraft.taskTitle}</h2></div><button aria-label="关闭" onClick={() => setGanttDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-gantt-form">
            <label><span>所属阶段</span><AppSelect ariaLabel="所属阶段" value={ganttDraft.phaseId} onValueChange={(phaseId) => setGanttDraft({ ...ganttDraft, phaseId })} options={[{ value: "", label: "未分组" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <label><span>计划开始</span><input type="date" disabled={ganttDraft.autoSchedule && ganttDraft.dependencyIds.length > 0} value={ganttDraft.plannedStart} onChange={(event) => {
              const plannedStart = event.target.value;
              setGanttDraft({ ...ganttDraft, plannedStart, plannedEnd: plannedStart ? addProjectDays(plannedStart, ganttDraft.durationWorkdays - 1) : "" });
            }} /></label>
            <label><span>工期（天）</span><input type="number" min={1} max={2600} value={ganttDraft.durationWorkdays} onChange={(event) => {
              const durationWorkdays = Math.max(1, Math.min(2600, Number(event.target.value) || 1));
              setGanttDraft({ ...ganttDraft, durationWorkdays, plannedEnd: ganttDraft.plannedStart ? addProjectDays(ganttDraft.plannedStart, durationWorkdays - 1) : "" });
            }} /></label>
            <label><span>计划结束</span><input type="date" readOnly value={ganttDraft.plannedEnd} /></label>
            <label className="project-gantt-auto-schedule"><input type="checkbox" checked={ganttDraft.autoSchedule} onChange={(event) => setGanttDraft({ ...ganttDraft, autoSchedule: event.target.checked })} /><span><strong>根据依赖自动排期</strong><small>前置任务变化时，自动顺延到次日</small></span></label>
            <fieldset><legend>前置任务</legend><div>{overview.ganttTasks.filter((task) => task.id !== ganttDraft.taskId).map((task) => <label key={task.id}><input type="checkbox" checked={ganttDraft.dependencyIds.includes(task.id)} onChange={(event) => {
              const dependencyIds = event.target.checked ? [...ganttDraft.dependencyIds, task.id] : ganttDraft.dependencyIds.filter((id) => id !== task.id);
              setGanttDraft({ ...ganttDraft, dependencyIds, autoSchedule: event.target.checked ? true : ganttDraft.autoSchedule });
            }} /><span>{task.title}</span></label>)}</div>{overview.ganttTasks.length <= 1 && <p>项目中还没有其他任务可作为依赖。</p>}</fieldset>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => setGanttDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !ganttDraft.plannedStart || !ganttDraft.plannedEnd} onClick={() => void saveGanttPlan()}>{busy && <LoaderCircle className="spin" size={14} />}保存计划</button></div></footer>
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
      {ganttTaskDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setGanttTaskDraft(undefined); }}>
        <section className="calendar-dialog project-gantt-task-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-gantt-task-dialog-title">
          <header><div><h2 id="project-gantt-task-dialog-title">新建任务</h2></div><button aria-label="关闭" onClick={() => setGanttTaskDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-gantt-task-form">
            <label className="wide"><span>任务名称</span><input autoFocus maxLength={240} value={ganttTaskDraft.title} onChange={(event) => setGanttTaskDraft({ ...ganttTaskDraft, title: event.target.value })} placeholder="需要完成什么？" /></label>
            <label><span>所属阶段</span><AppSelect ariaLabel="所属阶段" value={ganttTaskDraft.phaseId} onValueChange={(phaseId) => setGanttTaskDraft({ ...ganttTaskDraft, phaseId })} options={[{ value: "", label: "未分组" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <label><span>计划开始</span><input type="date" value={ganttTaskDraft.plannedStart} onChange={(event) => setGanttTaskDraft({ ...ganttTaskDraft, plannedStart: event.target.value })} /></label>
            <label><span>工期（天）</span><input type="number" min={1} max={2600} value={ganttTaskDraft.durationWorkdays} onChange={(event) => setGanttTaskDraft({ ...ganttTaskDraft, durationWorkdays: Math.max(1, Math.min(2600, Number(event.target.value) || 1)) })} /></label>
          </div>
          <footer><small>{ganttTaskDraft.plannedStart ? `预计结束：${formatProjectMilestoneDate(addProjectDays(ganttTaskDraft.plannedStart, ganttTaskDraft.durationWorkdays - 1))}` : "不设置开始日期时，任务会进入未排期区域。"}</small><div><button className="secondary-button" disabled={busy} onClick={() => setGanttTaskDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !ganttTaskDraft.title.trim()} onClick={() => void createGanttTask()}>{busy && <LoaderCircle className="spin" size={14} />}创建任务</button></div></footer>
        </section>
      </div>}
    </div>
  );
}

function createProjectGanttDraft(task: ClientProjectGanttTask): ProjectGanttPlanDraft {
  const start = task.plannedStart ?? toDateInput(new Date());
  const durationWorkdays = task.durationWorkdays
    ?? (task.plannedStart && task.plannedEnd ? countProjectDays(task.plannedStart, task.plannedEnd) : 1);
  const end = task.plannedEnd ?? addProjectDays(start, durationWorkdays - 1);
  return {
    taskId: task.id,
    taskTitle: task.title,
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
  readonly taskId: string;
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

interface ProjectGanttCreateSelection {
  readonly rowKey: string;
  readonly phaseId?: string;
  readonly pointerId: number;
  readonly originIndex: number;
  readonly currentIndex: number;
}

interface ProjectGanttMenuState {
  readonly kind: "canvas" | "phase" | "task";
  readonly x: number;
  readonly y: number;
  readonly date?: string;
  readonly phase?: ClientProjectPhase;
  readonly phaseId?: string;
  readonly task?: ClientProjectGanttTask;
  readonly returnFocus?: HTMLElement | null;
}

const PROJECT_GANTT_DEFAULT_DAY_WIDTH = 27;
const PROJECT_GANTT_MIN_DAY_WIDTH = 6;
const PROJECT_GANTT_MAX_DAY_WIDTH = 54;
const PROJECT_GANTT_ZOOM_STEP = 3;

function ProjectGanttChart({
  projectId,
  tasks,
  phases,
  milestones,
  projectColor,
  readOnly,
  busy,
  onChangeDates,
  onEdit,
  onEditMilestone,
  onCreateMilestone,
  onCreateTask,
  onDeleteTask,
  onCreatePhase,
  onEditPhase,
  onDeletePhase,
}: {
  readonly projectId: string;
  readonly tasks: readonly ClientProjectGanttTask[];
  readonly phases: readonly ClientProjectPhase[];
  readonly milestones: readonly ClientProjectMilestone[];
  readonly projectColor: string;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onChangeDates: (task: ClientProjectGanttTask, plannedStart: string, plannedEnd: string) => Promise<boolean>;
  readonly onEdit: (task: ClientProjectGanttTask) => void;
  readonly onEditMilestone: (milestone: ClientProjectMilestone) => void;
  readonly onCreateMilestone: (dueOn?: string) => void;
  readonly onCreateTask: (phaseId?: string, plannedStart?: string, durationWorkdays?: number) => void;
  readonly onDeleteTask: (task: ClientProjectGanttTask) => void;
  readonly onCreatePhase: () => void;
  readonly onEditPhase: (phase: ClientProjectPhase) => void;
  readonly onDeletePhase: (phase: ClientProjectPhase) => void;
}) {
  const plannedTasks = tasks.filter((task) => task.plannedStart && task.plannedEnd);
  const today = toDateInput(new Date());
  const todayTime = projectDateToUtcTime(today);
  const plannedDates = [...plannedTasks.flatMap((task) => [
    projectDateToUtcTime(task.plannedStart!),
    projectDateToUtcTime(task.plannedEnd!),
  ]), ...milestones.filter((milestone) => milestone.dueOn).map((milestone) => projectDateToUtcTime(milestone.dueOn!))];
  const rangeStartTime = Math.min(todayTime, ...(plannedDates.length ? plannedDates : [todayTime])) - 7 * 86_400_000;
  const rangeEndTime = Math.max(todayTime + 28 * 86_400_000, ...(plannedDates.length ? plannedDates : [todayTime])) + 7 * 86_400_000;
  const rangeStart = projectDateFromUtcTime(rangeStartTime);
  const [dayWidth, setDayWidth] = useState(PROJECT_GANTT_DEFAULT_DAY_WIDTH);
  const totalDays = Math.max(36, Math.round((rangeEndTime - rangeStartTime) / 86_400_000) + 1);
  const timelineWidth = totalDays * dayWidth;
  const markerIntervalDays = dayWidth >= 24 ? 7 : dayWidth >= 14 ? 14 : dayWidth >= 8 ? 28 : 56;
  const timeMarkers = Array.from({ length: Math.ceil(totalDays / markerIntervalDays) }, (_, index) => {
    const date = new Date(rangeStartTime + index * markerIntervalDays * 86_400_000);
    return { date, left: index * markerIntervalDays * dayWidth };
  });
  const weekendDays = Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(rangeStartTime + index * 86_400_000);
    return { index, day: date.getUTCDay() };
  }).filter((entry) => entry.day === 0 || entry.day === 6);
  const todayOffset = projectDayDifference(rangeStart, today) * dayWidth;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayWidthRef = useRef(dayWidth);
  const dragPreviewRef = useRef<ProjectGanttDragPreview | undefined>(undefined);
  const createSelectionRef = useRef<ProjectGanttCreateSelection | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const [dragPreview, setDragPreview] = useState<ProjectGanttDragPreview>();
  const [createSelection, setCreateSelection] = useState<ProjectGanttCreateSelection>();
  const [savingTaskId, setSavingTaskId] = useState<string>();
  const [collapsedPhaseIds, setCollapsedPhaseIds] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<ProjectGanttMenuState>();

  useEffect(() => () => {
    document.body.classList.remove("project-gantt-is-dragging");
    document.body.classList.remove("project-gantt-is-selecting");
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
    if (!scroll || next === currentDayWidth || dragPreviewRef.current || createSelectionRef.current) return;
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
      if (!event.ctrlKey || dragPreviewRef.current || createSelectionRef.current) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      const direction = event.deltaY > 0 ? -1 : 1;
      const amount = Math.max(0.5, Math.min(PROJECT_GANTT_ZOOM_STEP, Math.abs(event.deltaY) * 0.04));
      applyZoom(dayWidthRef.current + direction * amount, event.clientX);
    };
    scroll.addEventListener("wheel", handleWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", handleWheel);
  });

  const sortTasks = (entries: readonly ClientProjectGanttTask[]) => [...entries].sort((left, right) => {
    if (!left.plannedStart && !right.plannedStart) return left.title.localeCompare(right.title);
    if (!left.plannedStart) return 1;
    if (!right.plannedStart) return -1;
    return left.plannedStart.localeCompare(right.plannedStart);
  });
  const orderedPhases = [...phases].sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
  const ungroupedTasks = sortTasks(tasks.filter((task) => !task.phaseId || !phases.some((phase) => phase.id === task.phaseId)));

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
    task: ClientProjectGanttTask,
    mode: ProjectGanttDragMode,
    startIndex: number,
    durationDays: number,
  ) => {
    if (event.pointerType !== "mouse" || readOnly || busy || savingTaskId || !task.plannedStart || !task.plannedEnd) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    suppressClickRef.current = false;
    const next: ProjectGanttDragPreview = {
      taskId: task.id,
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
    const task = tasks.find((entry) => entry.id === current.taskId);
    if (!task) return;
    setSavingTaskId(task.id);
    void onChangeDates(task, current.start, current.end).finally(() => setSavingTaskId(undefined));
  };

  const openTaskAfterClick = (task: ClientProjectGanttTask) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!savingTaskId) onEdit(task);
  };

  const dateIndexFromPointer = (event: ReactPointerEvent<HTMLElement>): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(totalDays - 1, Math.floor((event.clientX - bounds.left) / dayWidthRef.current)));
  };

  const startCreateSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
    rowKey: string,
    phaseId?: string,
  ) => {
    if (event.button !== 0 || event.pointerType !== "mouse" || readOnly || busy || savingTaskId || dragPreviewRef.current) return;
    if ((event.target as Element).closest(".project-gantt-bar, .project-gantt-unscheduled, .project-gantt-milestone")) return;
    const index = dateIndexFromPointer(event);
    const next: ProjectGanttCreateSelection = {
      rowKey,
      phaseId,
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
    onCreateTask(current.phaseId, addProjectDays(rangeStart, startIndex), endIndex - startIndex + 1);
  };

  const createTrackHandlers = (rowKey: string, phaseId?: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => startCreateSelection(event, rowKey, phaseId),
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

  const openTaskMenu = (event: ReactMouseEvent<HTMLElement>, task: ClientProjectGanttTask) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ kind: "task", x: event.clientX, y: event.clientY, task, phaseId: task.phaseId, returnFocus: event.currentTarget });
  };

  const weekendBands = () => weekendDays.map((entry) => (
    <i className="project-gantt-weekend" key={entry.index} style={{ left: entry.index * dayWidth, width: dayWidth }} />
  ));

  const renderTaskRow = (task: ClientProjectGanttTask) => {
    const startIndex = task.plannedStart ? projectDayDifference(rangeStart, task.plannedStart) : 0;
    const durationDays = task.plannedStart && task.plannedEnd
      ? Math.max(1, projectDayDifference(task.plannedStart, task.plannedEnd) + 1)
      : 0;
    const dependencyTitles = task.dependencyIds.map((id) => taskById.get(id)?.title).filter((title): title is string => Boolean(title));
    const taskPreview = dragPreview?.taskId === task.id ? dragPreview : undefined;
    const previewStart = taskPreview?.start ?? task.plannedStart;
    const previewEnd = taskPreview?.end ?? task.plannedEnd;
    const previewStartIndex = previewStart ? projectDayDifference(rangeStart, previewStart) : startIndex;
    const previewDurationDays = previewStart && previewEnd ? projectDayDifference(previewStart, previewEnd) + 1 : durationDays;
    const saving = savingTaskId === task.id;
    const durationLabel = `${task.durationWorkdays ?? (task.plannedStart && task.plannedEnd ? countProjectDays(task.plannedStart, task.plannedEnd) : 1)} 天`;
    return <div className={`project-gantt-row ${task.status === "done" ? "done" : ""}`} key={task.id}>
      <button className="project-gantt-task" disabled={readOnly} onClick={() => onEdit(task)} onContextMenu={(event) => openTaskMenu(event, task)}><span><strong>{task.title}</strong><small>{task.autoSchedule ? `自动 · ${durationLabel}` : dependencyTitles.length ? `依赖：${dependencyTitles.join("、")}` : durationLabel}</small></span><Pencil size={13} /></button>
      <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event, task.phaseId)} {...createTrackHandlers(`task:${task.id}`, task.phaseId)}>
        {weekendBands()}
        {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
        {renderCreateSelection(`task:${task.id}`)}
        {durationDays ? <div
          className={`project-gantt-bar ${taskPreview ? `dragging ${taskPreview.mode}` : ""} ${saving ? "saving" : ""}`}
          role="button"
          tabIndex={readOnly ? -1 : 0}
          aria-disabled={readOnly || saving}
          aria-label={`编辑任务计划：${task.title}，${previewStart} 至 ${previewEnd}`}
          title={`${task.title}：${previewStart} – ${previewEnd}`}
          style={{ left: previewStartIndex * dayWidth, width: previewDurationDays * dayWidth, background: projectColor }}
          onContextMenu={(event) => openTaskMenu(event, task)}
          onClick={() => { if (!readOnly) openTaskAfterClick(task); }}
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
            onClick={(event) => { event.stopPropagation(); openTaskAfterClick(task); }}
            onPointerDown={(event) => startDrag(event, task, "resize-start", startIndex, durationDays)}
            onPointerMove={(event) => updateDragPreview(event.clientX)}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
          />}
          <span>{taskPreview ? formatProjectGanttDragRange(previewStart!, previewEnd!) : task.title}</span>
          {saving ? <LoaderCircle className="spin" size={12} /> : task.status === "done" ? <Check size={12} /> : null}
          {!readOnly && <button
            type="button"
            className="project-gantt-resize-handle end"
            aria-label={`调整“${task.title}”的结束日期`}
            title="拖动调整结束日期"
            onClick={(event) => { event.stopPropagation(); openTaskAfterClick(task); }}
            onPointerDown={(event) => startDrag(event, task, "resize-end", startIndex, durationDays)}
            onPointerMove={(event) => updateDragPreview(event.clientX)}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
          />}
        </div> : <button className="project-gantt-unscheduled" disabled={readOnly} onClick={() => onEdit(task)} onContextMenu={(event) => openTaskMenu(event, task)}>设置计划日期</button>}
      </div>
    </div>;
  };

  const menuCommands: readonly ResolvedContextCommand[] = menu?.kind === "task" ? [
    { id: "gantt.edit-task", label: "编辑任务计划", group: "primary", risk: "local-write", icon: "edit", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.delete-task", label: "永久删除任务", group: "danger", risk: "destructive", icon: "trash", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
  ] : menu?.kind === "phase" ? [
    { id: "gantt.add-task", label: "在阶段中添加任务", group: "primary", risk: "local-write", icon: "task", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.edit-phase", label: "重命名或更改颜色", group: "organize", risk: "local-write", icon: "edit", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.delete-phase", label: "删除阶段", group: "danger", risk: "destructive", icon: "trash", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
  ] : [
    { id: "gantt.add-task", label: menu?.date ? `在 ${formatProjectMilestoneDate(menu.date)} 添加任务` : "添加任务", group: "primary", risk: "local-write", icon: "task", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.add-milestone", label: menu?.date ? `在 ${formatProjectMilestoneDate(menu.date)} 添加里程碑` : "添加里程碑", group: "primary", risk: "local-write", icon: "calendar-plus", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
    { id: "gantt.add-phase", label: "添加阶段", group: "organize", risk: "local-write", icon: "folder", disabledReason: readOnly || busy ? "当前项目不可修改" : undefined },
  ];

  const selectMenuCommand = (commandId: ContextCommandId) => {
    const ganttCommand = commandId as ProjectGanttCommandId;
    if (ganttCommand === "gantt.add-task") onCreateTask(menu?.phase?.id ?? menu?.phaseId, menu?.date);
    else if (ganttCommand === "gantt.add-milestone") onCreateMilestone(menu?.date);
    else if (ganttCommand === "gantt.add-phase") onCreatePhase();
    else if (ganttCommand === "gantt.edit-task" && menu?.task) onEdit(menu.task);
    else if (ganttCommand === "gantt.delete-task" && menu?.task) onDeleteTask(menu.task);
    else if (ganttCommand === "gantt.edit-phase" && menu?.phase) onEditPhase(menu.phase);
    else if (ganttCommand === "gantt.delete-phase" && menu?.phase) onDeletePhase(menu.phase);
  };

  return (
    <section className="panel project-gantt">
      <header>
        <div className="project-gantt-title"><CalendarClock size={17} /><span><strong>项目甘特图</strong><small>{plannedTasks.length} / {tasks.length} 项任务已安排 · {phases.length} 个阶段</small></span></div>
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
            <div className="project-gantt-task-heading" onContextMenu={(event) => openCanvasMenu(event, undefined, false)}>阶段、任务与依赖</div>
            <div className="project-gantt-time-heading" onContextMenu={(event) => openCanvasMenu(event)}>{weekendBands()}{timeMarkers.map((marker) => <span key={marker.date.toISOString()} style={{ left: marker.left }}>{new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(marker.date)}</span>)}</div>
          </div>
          {orderedPhases.flatMap((phase) => {
            const phaseTasks = sortTasks(tasks.filter((task) => task.phaseId === phase.id));
            const collapsed = collapsedPhaseIds.has(phase.id);
            const phasePlannedTasks = phaseTasks.filter((task) => task.plannedStart && task.plannedEnd);
            const phaseStart = phasePlannedTasks.map((task) => task.plannedStart!).sort()[0];
            const phaseEnd = phasePlannedTasks.map((task) => task.plannedEnd!).sort().at(-1);
            const completed = phaseTasks.filter((task) => task.status === "done").length;
            const completionPercent = phaseTasks.length ? Math.round((completed / phaseTasks.length) * 100) : 0;
            const phaseRow = <div className="project-gantt-row project-gantt-phase-row" key={`phase:${phase.id}`}>
              <button className="project-gantt-task project-gantt-phase" disabled={readOnly} onClick={() => setCollapsedPhaseIds((current) => {
                const next = new Set(current);
                if (next.has(phase.id)) next.delete(phase.id);
                else next.add(phase.id);
                return next;
              })} onContextMenu={(event) => openPhaseMenu(event, phase)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<i style={{ background: phase.color }} /><span><strong>{phase.name}</strong><small>{phaseTasks.length} 项任务 · {completionPercent}%</small></span><MoreHorizontal size={13} /></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openPhaseMenu(event, phase)} {...createTrackHandlers(`phase:${phase.id}`, phase.id)}>
                {weekendBands()}
                {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
                {renderCreateSelection(`phase:${phase.id}`)}
                {phaseStart && phaseEnd && <div className="project-gantt-phase-bar" style={{ left: projectDayDifference(rangeStart, phaseStart) * dayWidth, width: (projectDayDifference(phaseStart, phaseEnd) + 1) * dayWidth, borderColor: phase.color }}><i style={{ width: `${completionPercent}%`, background: phase.color }} /></div>}
              </div>
            </div>;
            return collapsed ? [phaseRow] : [phaseRow, ...phaseTasks.map(renderTaskRow)];
          })}
          {(ungroupedTasks.length > 0 || (!tasks.length && !phases.length)) && <>
            {phases.length > 0 && <div className="project-gantt-row project-gantt-phase-row project-gantt-ungrouped-row">
              <button className="project-gantt-task project-gantt-phase" disabled={readOnly} onContextMenu={(event) => openCanvasMenu(event, undefined, false)}><FolderPlus size={14} /><span><strong>未分组</strong><small>{ungroupedTasks.length} 项任务</small></span></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event)} {...createTrackHandlers("ungrouped")}>{weekendBands()}{todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}{renderCreateSelection("ungrouped")}</div>
            </div>}
            {ungroupedTasks.map(renderTaskRow)}
            {!tasks.length && !phases.length && <div className="project-gantt-row project-gantt-empty-row">
              <button className="project-gantt-task" disabled={readOnly} onClick={() => onCreateTask()} onContextMenu={(event) => openCanvasMenu(event, undefined, false)}><span><strong>还没有项目任务</strong><small>点击或右键开始安排</small></span><Plus size={14} /></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event)} {...createTrackHandlers("empty")}>{weekendBands()}{todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}{renderCreateSelection("empty")}</div>
            </div>}
          </>}
          {milestones.filter((milestone) => milestone.dueOn).map((milestone) => {
            const offset = projectDayDifference(rangeStart, milestone.dueOn!) * dayWidth;
            return <div className={`project-gantt-row project-gantt-milestone-row ${milestone.status === "done" ? "done" : ""}`} key={`milestone:${milestone.id}`}>
              <button className="project-gantt-task" disabled={readOnly} onClick={() => onEditMilestone(milestone)}><span><strong>{milestone.title}</strong><small>里程碑 · {formatProjectMilestoneDate(milestone.dueOn!)}</small></span><Award size={13} /></button>
              <div className="project-gantt-track" onContextMenu={(event) => openCanvasMenu(event)}>
                {weekendBands()}
                {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
                <button className="project-gantt-milestone" disabled={readOnly} title={`${milestone.title}：${milestone.dueOn}`} style={{ left: offset, background: projectColor }} onClick={() => onEditMilestone(milestone)}><Award size={11} /></button>
              </div>
            </div>;
          })}
        </div>
      </div>
      <footer><span><i style={{ background: projectColor }} />计划任务</span><span><i className="weekend" />周末</span><span><i className="today" />今天</span><small>{readOnly ? "已归档项目为只读。" : "拖动调整日期 · 右键管理 · Ctrl + 滚轮缩放"}</small></footer>
      {menu && <ContextMenu anchor={{ x: menu.x, y: menu.y }} ariaLabel="甘特图操作" commands={menuCommands} heading={menu.task?.title ?? menu.phase?.name ?? (menu.date ? formatProjectMilestoneDate(menu.date) : "项目甘特图")} returnFocus={menu.returnFocus} testId="project-gantt-context-menu" onClose={() => setMenu(undefined)} onSelect={selectMenuCommand} />}
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

function formatProjectMinutes(minutes: number): string {
  if (!minutes) return "0 分";
  if (minutes < 60) return `${minutes} 分`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} 小时` : `${hours.toFixed(1)} 小时`;
}

function formatProjectBlockDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatProjectMilestoneDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`));
}
