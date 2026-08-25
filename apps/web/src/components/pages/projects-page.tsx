"use client";

import Link from "next/link";
import {
  AlertCircle, Archive, ArrowRight, Award, CalendarClock, CalendarDays, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock3,
  FileText, Folder, FolderPlus, GripVertical, Link2, ListChecks,
  LoaderCircle, Mail, MoreHorizontal, NotebookPen, Pencil, Pin, Plus,
  RefreshCw, Star, Trash2, X,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

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
import { DateTimeField } from "../ui/date-time-field";
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
  readonly ganttSortOrder: number;
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
  const day = new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time.format(start)}–${sameDay ? time.format(end) : new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}

function formatTaskDue(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat("de-DE", sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatTaskEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} Minuten`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} Stunden ${remainder} Minuten` : `${hours} Stunden`;
}

function formatNoteUpdated(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
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

interface ProjectGanttReorderInput {
  readonly kind: "task" | "milestone";
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
  general: "normale Noten",
  meeting: "Sitzungsprotokolle",
  email: "Briefbriefe",
  project: "Projektdokument",
  daily: "Tagesnoten",
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
    const status = response.status ? `HTTP ${response.status}` : "Unbekannter Zustand";
    throw new Error(`${fallbackMessage}Der Server lieferte eine unerkennbare Antwort (${status}）`);
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
  const [projectMembers, setProjectMembers] = useState<readonly ClientProjectMember[]>([]);
  const [collaborators, setCollaborators] = useState<readonly ClientCollaborator[]>([]);
  const [memberDraftUserId, setMemberDraftUserId] = useState("");
  const [memberDraftAccess, setMemberDraftAccess] = useState<"viewer" | "editor">("viewer");
  const memberLoadSequenceRef = useRef(0);

  const loadProjects = useCallback(async () => {
    const response = await workspaceFetch("/api/projects?includeArchived=true");
    const payload = await response.json() as { readonly ok?: boolean; readonly projects?: readonly ClientProject[]; readonly message?: string };
    if (!response.ok || !payload.ok || !payload.projects) throw new Error(payload.message ?? "Projekt kann nicht gelesen werden");
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
    if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "Projektprofil kann nicht gelesen werden");
    setOverview(payload.overview);
  }, []);

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
      .catch((error: unknown) => { if (!cancelled) setFeedback(error instanceof Error ? error.message : "Projekt kann nicht gelesen werden"); })
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
      .catch((error: unknown) => { if (!cancelled) setFeedback(error instanceof Error ? error.message : "Projektprofil kann nicht gelesen werden"); })
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
      if (!response.ok || !payload.ok || !payload.members) throw new Error(payload.message ?? "Projektmitglied kann nicht gespeichert werden");
      setProjectMembers(payload.members);
      setFeedback("Projektfreigabe aktualisiert");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Projektmitglied kann nicht gespeichert werden");
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
        "Projekt kann nicht gespeichert werden",
      );
      if (!response.ok || !payload.ok || !payload.project) throw new Error(payload.message ?? "Projekt kann nicht gespeichert werden");
      await loadProjects();
      setSelectedProjectId(payload.project.id);
      await loadOverview(payload.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setProjectDraft(undefined);
      setFeedback(projectDraft.id ? "Projekt aktualisiert" : "Projekt erstellt");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Projekt kann nicht gespeichert werden";
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
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Aufgabe kann nicht erstellt werden");
      setQuickTaskTitle("");
      await loadOverview(overview.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback("Nächste Aktion hinzugefügt");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht erstellt werden");
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
          title: `${overview.project.name} – Notiz`,
          content: "",
          noteType: "project",
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "Noten können nicht erstellt werden");
      window.location.assign(`/notes?note=${encodeURIComponent(payload.note.id)}`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Noten können nicht erstellt werden");
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
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "keine Meilensteine konnten gespeichert werden");
      await loadOverview(overview.project.id);
      setMilestoneDraft(undefined);
      setFeedback(milestoneDraft.id ? "Meilensteine aktualisiert" : "Meilenstein hinzugefügt");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "keine Meilensteine konnten gespeichert werden");
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
          phaseId: milestone.phaseId ?? null,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "keine Meilensteine können aktualisiert werden");
      await loadOverview(overview.project.id);
      setFeedback(milestone.status === "done" ? "Meilenstein wiedereröffnet" : "Meilensteine abgeschlossen");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "keine Meilensteine können aktualisiert werden");
    } finally {
      setBusy(false);
    }
  };

  const deleteMilestone = async (draft: ProjectMilestoneDraft) => {
    if (!overview || !draft.id || busy || !await appConfirm({
      title: `Meilensteine löschen${draft.title}“?`,
      description: "Dieser Meilenstein wird aus dem Projektprofil und dem Gantt-Diagramm entfernt und diese Operation kann nicht zurückgezogen werden.",
      confirmLabel: "Meilensteine löschen",
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
        "keine Meilensteine können gelöscht werden",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "keine Meilensteine können gelöscht werden");
      await loadOverview(overview.project.id);
      setMilestoneDraft(undefined);
      setFeedback("Meilenstein gelöscht");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "keine Meilensteine können gelöscht werden");
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
      if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "konnte den Gant-Plan nicht retten");
      setOverview(payload.overview);
      setGanttDraft(undefined);
      setFeedback("Aktualisierung des Aufgabenplans");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "konnte den Gant-Plan nicht retten");
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
      if (!response.ok || !payload.ok || !payload.task || !payload.overview) throw new Error(payload.message ?? "konnte den Gant-Plan nicht retten");
      setOverview(payload.overview);
      setFeedback(`aktualisiert${task.title}Vorgesehenes Datum`);
      return true;
    } catch (error) {
      setOverview(snapshot);
      setFeedback(error instanceof Error ? error.message : "konnte den Gant-Plan nicht retten");
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
      }>(response, "Meilenstein-Datum konnte nicht gespeichert werden");
      if (!response.ok || !payload.ok || !payload.milestone) throw new Error(payload.message ?? "Meilenstein-Datum konnte nicht gespeichert werden");
      setOverview((current) => current ? {
        ...current,
        milestones: current.milestones.map((entry) => entry.id === milestone.id ? payload.milestone! : entry),
      } : current);
      setFeedback(`aktualisiert${milestone.title}"Zieldatum"`);
      return true;
    } catch (error) {
      setOverview(snapshot);
      setFeedback(error instanceof Error ? error.message : "Meilenstein-Datum konnte nicht gespeichert werden");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reorderGanttItem = async (input: ProjectGanttReorderInput): Promise<boolean> => {
    if (!overview || busy || overview.project.status === "archived") return false;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(overview.project.id)}/gantt/reorder`,
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
      }>(response, "Gant-Ordnung kann nicht gespeichert werden");
      if (!response.ok || !payload.ok || !payload.overview) throw new Error(payload.message ?? "Gant-Ordnung kann nicht gespeichert werden");
      setOverview(payload.overview);
      setFeedback(input.kind === "milestone" ? "Meilenstein-Position aktualisiert" : "Aufgaben-Aufgabe aktualisiert");
      return true;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Gant-Ordnung kann nicht gespeichert werden");
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
        "Phase kann nicht gespeichert werden",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Phase kann nicht gespeichert werden");
      await loadOverview(overview.project.id);
      setPhaseDraft(undefined);
      setFeedback(phaseDraft.id ? "Stufe aktualisiert" : "Phase hinzugefügt");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Phase kann nicht gespeichert werden");
    } finally {
      setBusy(false);
    }
  };

  const deletePhase = async (phase: ClientProjectPhase) => {
    if (!overview || busy || !await appConfirm({
      title: `Phase löschen "${phase.name}“?`,
      description: "Aufgaben in der Phase beibehalten und in \" Keine Gruppierung \" verschoben werden .",
      confirmLabel: "Phase löschen",
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
        "Phase kann nicht gelöscht werden",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Phase kann nicht gelöscht werden");
      await loadOverview(overview.project.id);
      setFeedback("Phase gelöscht und Aufgabe auf ungruppiert verschoben");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Phase kann nicht gelöscht werden");
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
      }>(createResponse, "Aufgabe kann nicht erstellt werden");
      if (!createResponse.ok || !createPayload.ok || !createPayload.task) {
        throw new Error(createPayload.message ?? "Aufgabe kann nicht erstellt werden");
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
        "Der Aufgabenplan kann nicht festgelegt werden",
      );
      if (!planResponse.ok || !planPayload.ok) throw new Error(planPayload.message ?? "Der Aufgabenplan kann nicht festgelegt werden");
      await loadOverview(overview.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setGanttTaskDraft(undefined);
      setFeedback("Aufgabe zum Gantt-Diagramm hinzugefügt");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht erstellt werden");
    } finally {
      setBusy(false);
    }
  };

  const deleteGanttTask = async (task: ClientProjectGanttTask) => {
    if (!overview || busy || !await appConfirm({
      title: `Aufgabe dauerhaft löschen '${task.title}“?`,
      description: "Verwandte Abhängigkeit und Kalenderzeitblock werden ebenfalls entfernt und diese Operation kann nicht zurückgezogen werden.",
      confirmLabel: "dauerhaft gelöscht",
      tone: "danger",
    })) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const payload = await readProjectApiResponse<{ readonly ok?: boolean; readonly message?: string }>(
        response,
        "Aufgabe kann nicht gelöscht werden",
      );
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Aufgabe kann nicht gelöscht werden");
      await loadOverview(overview.project.id);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setFeedback("Aufgabe gelöscht");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht gelöscht werden");
    } finally {
      setBusy(false);
    }
  };

  const openTasks = overview?.tasks.filter((task) => task.status !== "done") ?? [];
  const upcomingBlocks = overview?.scheduledBlocks.filter((block) => new Date(block.end).getTime() >= Date.now()).slice(0, 6) ?? [];
  const milestoneGroups = overview ? [
    ...overview.phases.map((phase) => ({
      id: phase.id,
      label: phase.name,
      color: phase.color,
      milestones: overview.milestones.filter((milestone) => milestone.phaseId === phase.id),
    })),
    {
      id: "project",
      label: "Projektebene",
      color: overview.project.color,
      milestones: overview.milestones.filter((milestone) => !milestone.phaseId),
    },
  ].filter((group) => group.milestones.length > 0) : [];

  return (
    <div className="projects-page">
      <aside className="project-switcher project-switcher-mobile panel">
        <header><div><Folder size={17} /><span><strong>Projekt</strong><small>{projects.filter((project) => project.status === "active").length} im Gange ist</small></span></div><button aria-label="Neues Projekt" title="Neues Projekt" onClick={() => { setProjectDialogError(undefined); setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5", status: "active" }); }}><Plus size={16} /></button></header>
        <div>
          {projects.map((project) => <button className={selectedProjectId === project.id ? "active" : ""} key={project.id} onClick={() => setSelectedProjectId(project.id)}><i style={{ background: project.color }} /><span><strong>{project.name}</strong><small>{project.areaName ?? (project.status === "archived" ? "Archiviert" : "kein Feld gesetzt")}</small></span>{project.status === "archived" && <Archive size={13} />}</button>)}
          {!loading && !projects.length && <div className="project-switcher-empty"><FolderPlus size={20} /><span>keine Projekte verfügbar</span></div>}
        </div>
      </aside>

      <main className="project-overview">
        {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
        {loading && !overview ? <div className="project-overview-loading"><LoaderCircle className="spin" size={18} />Projekte bündeln...</div> : overview ? <>
          <ProjectGanttChart
            projectId={overview.project.id}
            tasks={overview.ganttTasks}
            phases={overview.phases}
            milestones={overview.milestones}
            projectColor={overview.project.color}
            readOnly={overview.project.status === "archived"}
            busy={busy}
            onChangeDates={saveGanttDates}
            onChangeMilestoneDate={saveGanttMilestoneDate}
            onReorderItem={reorderGanttItem}
            onEdit={(task) => setGanttDraft(createProjectGanttDraft(task))}
            onEditMilestone={(milestone) => setMilestoneDraft({ id: milestone.id, title: milestone.title, dueOn: milestone.dueOn ?? "", status: milestone.status, phaseId: milestone.phaseId ?? "" })}
            onCreateMilestone={(dueOn, phaseId) => setMilestoneDraft({ title: "", dueOn: dueOn ?? "", status: "planned", phaseId: phaseId ?? "" })}
            onCreateTask={(phaseId, plannedStart, durationWorkdays = 1) => setGanttTaskDraft({ title: "", phaseId: phaseId ?? "", plannedStart: plannedStart ?? "", durationWorkdays })}
            onDeleteTask={(task) => void deleteGanttTask(task)}
            onCreatePhase={() => setPhaseDraft({ name: "", color: overview.project.color, sortOrder: overview.phases.length })}
            onEditPhase={(phase) => setPhaseDraft({ id: phase.id, name: phase.name, color: phase.color, sortOrder: phase.sortOrder })}
            onDeletePhase={(phase) => void deletePhase(phase)}
          />

          <section className="project-stats" aria-label="Projektstatistik">
            <article className="panel"><CheckCircle2 size={17} /><div><strong>{overview.stats.openTaskCount}</strong><span>noch auszufüllen</span></div></article>
            <article className="panel"><Circle size={17} /><div><strong>{overview.stats.completedTaskCount}</strong><span>abgeschlossen</span></div></article>
            <article className="panel"><NotebookPen size={17} /><div><strong>{overview.stats.noteCount}</strong><span>Hinweis zum Projekt</span></div></article>
            <article className="panel"><Clock3 size={17} /><div><strong>{formatProjectMinutes(overview.stats.scheduledMinutes)}</strong><span>geplant</span></div></article>
          </section>

          <section className="panel project-milestone-timeline">
            <header><div><Award size={17} /><span><strong>Meilensteine</strong><small>Schlüsselknoten werden nach Phasen gruppiert und der Projektrhythmus wird in Verbindung mit der Aufgabe Gant plan ausgedrückt</small></span></div><button disabled={overview.project.status === "archived"} onClick={() => setMilestoneDraft({ title: "", dueOn: "", status: "planned", phaseId: "" })}><Plus size={14} />Meilensteine hinzufügen</button></header>
            {milestoneGroups.length ? <div className="project-milestone-groups">{milestoneGroups.map((group) => <section className="project-milestone-group" key={group.id}><header><i style={{ background: group.color }} /><strong>{group.label}</strong><span>{group.milestones.length}</span></header><ol>{group.milestones.map((milestone) => <li className={milestone.status === "done" ? "done" : milestone.status === "active" ? "active" : ""} key={milestone.id}><button className="milestone-check" aria-label={milestone.status === "done" ? `Wiedereröffnungs-Meilenstein:${milestone.title}` : `Meilensteine erreicht:${milestone.title}`} disabled={busy || overview.project.status === "archived"} onClick={() => void toggleMilestone(milestone)}>{milestone.status === "done" ? <Check size={13} /> : <Circle size={12} />}</button><i /><button className="milestone-body" onClick={() => setMilestoneDraft({ id: milestone.id, title: milestone.title, dueOn: milestone.dueOn ?? "", status: milestone.status, phaseId: milestone.phaseId ?? "" })}><strong>{milestone.title}</strong><small>{milestone.dueOn ? formatProjectMilestoneDate(milestone.dueOn) : "kein Datum festgelegt"} · {milestone.status === "done" ? "abgeschlossen" : milestone.status === "active" ? "im Gange ist" : "geplant"}</small></button></li>)}</ol></section>)}</div> : <div className="project-milestone-empty"><span>Beginnt mit dem ersten Schlüssellieferknoten, z.B. " beenden Sie den Prototypen " oder " reichen Sie den ersten Entwurf des Papiers " .</span></div>}
          </section>

          <div className="project-content-grid">
            <section className="panel project-actions-panel">
              <header><div><ListChecks size={16} /><span><strong>Der Weg nach vorn</strong><small>{openTasks.length} Zu erweiternder Eintrag</small></span></div><Link href="/tasks">Alle anzeigen</Link></header>
              {overview.project.status === "active" && <form onSubmit={(event) => { event.preventDefault(); void createQuickTask(); }}><Plus size={15} /><input value={quickTaskTitle} maxLength={240} onChange={(event) => setQuickTaskTitle(event.target.value)} placeholder="Schnelles Hinzufügen der nächsten Aktion..." /><button disabled={busy || !quickTaskTitle.trim()}>Hinzufügen</button></form>}
              <div className="project-action-list">{openTasks.slice(0, 7).map((task) => <Link href={`/tasks?task=${encodeURIComponent(task.id)}`} key={task.id}><span className={`project-task-status ${task.isUrgent ? "urgent" : ""}`}><Check size={12} /></span><span><strong>{task.title}</strong><small>{task.dueAt ? formatTaskDue(task.dueAt) : task.estimatedMinutes ? formatTaskEstimate(task.estimatedMinutes) : task.status === "waiting" ? "warten" : "keine Frist gesetzt"}</small></span>{task.important && <Star size={13} fill="currentColor" />}</Link>)}{!openTasks.length && <div className="project-panel-empty"><CheckCircle2 size={20} /><span>es gibt keine aktuellen Aufgaben zu erweitern</span></div>}</div>
            </section>

            <section className="panel project-notes-panel">
              <header><div><NotebookPen size={16} /><span><strong>Hinweis zum Projekt</strong><small>Entscheidungsfindung, Information und Prozessdokumentation</small></span></div><button disabled={busy || overview.project.status === "archived"} onClick={() => void createProjectNote()}><Plus size={14} />Neu</button></header>
              <div>{overview.notes.slice(0, 6).map((note) => <Link href={`/notes?note=${encodeURIComponent(note.id)}`} key={note.id}><FileText size={15} /><span><strong>{note.title}</strong><small>{formatNoteUpdated(note.updatedAt)}</small></span>{note.pinned && <Pin size={12} fill="currentColor" />}</Link>)}{!overview.notes.length && <div className="project-panel-empty"><NotebookPen size={20} /><span>keine Projektnotizen verfügbar</span></div>}</div>
            </section>

            <section className="panel project-schedule-panel">
              <header><div><CalendarClock size={16} /><span><strong>Zeitplan</strong><small>Zukunfts-Fokusblock</small></span></div><Link href="/calendar">Kalender öffnen</Link></header>
              <div>{upcomingBlocks.map((block) => <Link href={block.href} key={block.eventId}><time dateTime={block.start}>{formatProjectBlockDate(block.start)}</time><span><strong>{block.taskTitle}</strong><small>{formatTaskBlockRange(block.start, block.end)} · {block.calendarName}</small></span></Link>)}{!upcomingBlocks.length && <div className="project-panel-empty"><CalendarClock size={20} /><span>keine Fokuszeit vorgesehen</span></div>}</div>
            </section>

            <section className={`panel project-review-panel ${overview.review.isStalled ? "stalled" : ""}`}>
              <header><div><RefreshCw size={16} /><span><strong>Die Woche ist wieder da.</strong><small>{overview.review.isStalled ? "Projekt, das nicht länger als 7 Tage vorangeschritten ist" : `Aktivitäten in jüngerer Zeit ${formatNoteUpdated(overview.review.lastActivityAt)}`}</small></span></div><Link href="/tasks">Maßnahmen bündeln</Link></header>
              <div>
                <article><strong>{overview.review.completedLast7DaysCount}</strong><span>fast 7 Tage abgeschlossen</span></article>
                <article className={overview.review.overdueTaskCount ? "attention" : ""}><strong>{overview.review.overdueTaskCount}</strong><span>Überfällig</span></article>
                <article><strong>{overview.review.dueNext7DaysCount}</strong><span>Ablauf in den nächsten 7 Tagen</span></article>
                <article><strong>{overview.review.unscheduledOpenTaskCount}</strong><span>keine Zeit vorgesehen</span></article>
              </div>
              <p>{overview.review.isStalled ? "Es wird empfohlen, einen minimalen nächsten Schritt zu wählen oder das Projekt neu zu bewerten, ob es fortgesetzt werden muss." : overview.review.overdueTaskCount ? "zunächst mit überfälligen Angelegenheiten umzugehen und für die kommende Woche den Fokus zu behalten." : "das Projekt ist in einem normalen Tempo. Der nächste Meilenstein und die wichtigste Aktion wird auf der Festplatte bestätigt."}</p>
            </section>
          </div>
          <section className="panel project-related-panel"><RelatedContentPanel kind="project" entityId={overview.project.id} emptyText="das Projekt hat keinen zugehörigen Inhalt." /></section>
        </> : <section className="panel project-empty-state"><FolderPlus size={26} /><h2>das erste Projekt erstellen</h2><p>Das Projekt wird Aufgaben, Notizen und Fokuszeiten unter dem gleichen Ziel organisieren.</p><button className="primary-button" onClick={() => { setProjectDialogError(undefined); setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5", status: "active" }); }}><Plus size={14} />Neues Projekt</button></section>}
      </main>

      {projectDraft && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setProjectDialogError(undefined); setProjectDraft(undefined); } }}>
        <section className="calendar-dialog note-project-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-management-dialog-title">
          <header><div><h2 id="project-management-dialog-title">{projectDraft.id ? "Projekteinstellungen" : "Neues Projekt"}</h2></div><button aria-label="Schließen" onClick={() => { setProjectDialogError(undefined); setProjectDraft(undefined); }} disabled={busy}><X size={18} /></button></header>
          <div className="note-project-form">
            {projectDialogError && <div className="project-dialog-error" role="alert"><AlertCircle size={15} /><span><strong>{projectDraft.id ? "Speichern fehlgeschlagen" : "Erstellung fehlgeschlagen"}</strong><small>{projectDialogError}</small></span></div>}
            <label><span>Projektname</span><input autoFocus value={projectDraft.name} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="z.B. Doktorarbeit" /></label>
            <label><span>Bereich</span><input value={projectDraft.areaName} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, areaName: event.target.value })} placeholder="Z.B. Studie/Einzelperson" /></label>
            <label className="note-project-color"><span>Farbe</span><input type="color" value={projectDraft.color} onChange={(event) => setProjectDraft({ ...projectDraft, color: event.target.value })} /></label>
            {projectDraft.id && <label><span>Status</span><AppSelect ariaLabel="Projektstatus" value={projectDraft.status} onValueChange={(status) => setProjectDraft({ ...projectDraft, status: status as "active" | "archived" })} options={[{ value: "active", label: "im Gange ist" }, { value: "archived", label: "Archiviert" }]} /></label>}
            <label className="note-project-description"><span>Projektbeschreibung</span><textarea value={projectDraft.description} maxLength={2_000} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} placeholder="Was wird das Projekt erreichen? Was sind die Abschlusskriterien?" /></label>
            {projectDraft.id && <section className="project-dialog-sharing" aria-labelledby="project-sharing-title">
              <header><div><Users size={16} /><span><strong id="project-sharing-title">Projektfreigabe</strong><small>{projectMembers.length ? `${projectMembers.length} ein Mitglied` : "Nur Projekteigentümer"}</small></span></div></header>
              <div className="project-share-members">
                {projectMembers.map((member) => <span key={member.userId}><strong>{member.displayName}</strong><small>{member.accessLevel === "editor" ? "editierbar" : "Schreibgeschützt"}</small><button aria-label={`entfernen ${member.displayName}`} disabled={busy} onClick={() => void saveMembers(projectDraft.id!, projectMembers.filter((entry) => entry.userId !== member.userId))}><X size={12} /></button></span>)}
              </div>
              <div className="project-share-form">
                <AppSelect ariaLabel="Auswahl der Projektmitglieder" size="compact" value={memberDraftUserId} onValueChange={setMemberDraftUserId} options={[{ value: "", label: "Auswahl des Benutzers" }, ...collaborators.filter((user) => !projectMembers.some((member) => member.userId === user.id)).map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))]} />
                <AppSelect ariaLabel="Rechte der Projektmitgliedschaft" size="compact" value={memberDraftAccess} onValueChange={(access) => setMemberDraftAccess(access === "editor" ? "editor" : "viewer")} options={[{ value: "viewer", label: "Schreibgeschützt" }, { value: "editor", label: "editierbar" }]} />
                <button className="secondary-button" disabled={!memberDraftUserId || busy} onClick={() => {
                  const user = collaborators.find((entry) => entry.id === memberDraftUserId);
                  if (!user) return;
                  setMemberDraftUserId("");
                  void saveMembers(projectDraft.id!, [...projectMembers, { userId: user.id, displayName: user.displayName, email: user.email, accessLevel: memberDraftAccess }]);
                }}><Plus size={14} />Mitglieder hinzufügen</button>
              </div>
            </section>}
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => { setProjectDialogError(undefined); setProjectDraft(undefined); }}>Abbrechen</button><button className="primary-button" disabled={busy || !projectDraft.name.trim()} onClick={() => void saveProject()}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? (projectDraft.id ? "Speichern" : "Erstellen") : (projectDraft.id ? "Änderungen speichern" : "Projekt erstellen")}</button></div></footer>
        </section>
      </div>}
      {milestoneDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setMilestoneDraft(undefined); }}>
        <section className="calendar-dialog project-milestone-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-milestone-dialog-title">
          <header><div><h2 id="project-milestone-dialog-title">{milestoneDraft.id ? "Bearbeitung von Meilensteinen" : "Neuer Meilenstein"}</h2></div><button aria-label="Schließen" onClick={() => setMilestoneDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-milestone-form">
            <label className="wide"><span>Titel</span><input autoFocus value={milestoneDraft.title} maxLength={240} onChange={(event) => setMilestoneDraft({ ...milestoneDraft, title: event.target.value })} placeholder="z.B. den Drohnenflug-Prototyp komplettieren" /></label>
            <label><span>Elternphase</span><AppSelect ariaLabel="Meilenstein-Zugehörigkeitsphase" value={milestoneDraft.phaseId} onValueChange={(phaseId) => setMilestoneDraft({ ...milestoneDraft, phaseId })} options={[{ value: "", label: "Projektebene" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <DateTimeField label="Zieldatum" mode="date" value={milestoneDraft.dueOn} onChange={(dueOn) => setMilestoneDraft({ ...milestoneDraft, dueOn })} />
            <label><span>Status</span><AppSelect ariaLabel="Meilenstein-Status" value={milestoneDraft.status} onValueChange={(status) => setMilestoneDraft({ ...milestoneDraft, status: status as ClientProjectMilestone["status"] })} options={[{ value: "planned", label: "geplant" }, { value: "active", label: "im Gange ist" }, { value: "done", label: "abgeschlossen" }]} /></label>
          </div>
          <footer>{milestoneDraft.id && <button className="secondary-button danger-button" disabled={busy} onClick={() => void deleteMilestone(milestoneDraft)}><Trash2 size={14} />Löschen</button>}<div><button className="secondary-button" disabled={busy} onClick={() => setMilestoneDraft(undefined)}>Abbrechen</button><button className="primary-button" disabled={busy || !milestoneDraft.title.trim()} onClick={() => void saveMilestone()}>{busy && <LoaderCircle className="spin" size={14} />}{milestoneDraft.id ? "Änderungen speichern" : "Meilensteine hinzufügen"}</button></div></footer>
        </section>
      </div>}
      {ganttDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setGanttDraft(undefined); }}>
        <section className="calendar-dialog project-gantt-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-gantt-dialog-title">
          <header><div><h2 id="project-gantt-dialog-title">{ganttDraft.taskTitle}</h2></div><button aria-label="Schließen" onClick={() => setGanttDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-gantt-form">
            <label><span>Elternphase</span><AppSelect ariaLabel="Elternphase" value={ganttDraft.phaseId} onValueChange={(phaseId) => setGanttDraft({ ...ganttDraft, phaseId })} options={[{ value: "", label: "Keine Gruppierung" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <DateTimeField label="planmäßiger Start" mode="date" disabled={ganttDraft.autoSchedule && ganttDraft.dependencyIds.length > 0} value={ganttDraft.plannedStart} onChange={(plannedStart) => {
              setGanttDraft({ ...ganttDraft, plannedStart, plannedEnd: plannedStart ? addProjectDays(plannedStart, ganttDraft.durationWorkdays - 1) : "" });
            }} />
            <label><span>Zeitplan (Tage)</span><input type="number" min={1} max={2600} value={ganttDraft.durationWorkdays} onChange={(event) => {
              const durationWorkdays = Math.max(1, Math.min(2600, Number(event.target.value) || 1));
              setGanttDraft({ ...ganttDraft, durationWorkdays, plannedEnd: ganttDraft.plannedStart ? addProjectDays(ganttDraft.plannedStart, durationWorkdays - 1) : "" });
            }} /></label>
            <DateTimeField label="Ende des Plans" mode="date" readOnly clearable={false} value={ganttDraft.plannedEnd} onChange={() => undefined} />
            <label className="project-gantt-auto-schedule"><input type="checkbox" checked={ganttDraft.autoSchedule} onChange={(event) => setGanttDraft({ ...ganttDraft, autoSchedule: event.target.checked })} /><span><strong>Zeitplan nach automatischer Abhängigkeit</strong><small>verschiebt sich automatisch auf den nächsten Tag, wenn sich die Voraufgabe ändert</small></span></label>
            <fieldset><legend>Voraufgabe</legend><div>{overview.ganttTasks.filter((task) => task.id !== ganttDraft.taskId).map((task) => <label key={task.id}><input type="checkbox" checked={ganttDraft.dependencyIds.includes(task.id)} onChange={(event) => {
              const dependencyIds = event.target.checked ? [...ganttDraft.dependencyIds, task.id] : ganttDraft.dependencyIds.filter((id) => id !== task.id);
              setGanttDraft({ ...ganttDraft, dependencyIds, autoSchedule: event.target.checked ? true : ganttDraft.autoSchedule });
            }} /><span>{task.title}</span></label>)}</div>{overview.ganttTasks.length <= 1 && <p>Auf keine andere Aufgabe im Projekt kann zurückgegriffen werden.</p>}</fieldset>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => setGanttDraft(undefined)}>Abbrechen</button><button className="primary-button" disabled={busy || !ganttDraft.plannedStart || !ganttDraft.plannedEnd} onClick={() => void saveGanttPlan()}>{busy && <LoaderCircle className="spin" size={14} />}Sparplan</button></div></footer>
        </section>
      </div>}
      {phaseDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPhaseDraft(undefined); }}>
        <section className="calendar-dialog project-phase-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-phase-dialog-title">
          <header><div><h2 id="project-phase-dialog-title">{phaseDraft.id ? "Bearbeitungsphase" : "Neue Phase"}</h2></div><button aria-label="Schließen" onClick={() => setPhaseDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-phase-form">
            <label><span>Name der Phase</span><input autoFocus maxLength={120} value={phaseDraft.name} onChange={(event) => setPhaseDraft({ ...phaseDraft, name: event.target.value })} placeholder="z.B. Prototypenentwicklung" /></label>
            <label className="note-project-color"><span>Farbe</span><input type="color" value={phaseDraft.color} onChange={(event) => setPhaseDraft({ ...phaseDraft, color: event.target.value })} /></label>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => setPhaseDraft(undefined)}>Abbrechen</button><button className="primary-button" disabled={busy || !phaseDraft.name.trim()} onClick={() => void savePhase()}>{busy && <LoaderCircle className="spin" size={14} />}{phaseDraft.id ? "Änderungen speichern" : "Phase hinzufügen"}</button></div></footer>
        </section>
      </div>}
      {ganttTaskDraft && overview && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setGanttTaskDraft(undefined); }}>
        <section className="calendar-dialog project-gantt-task-dialog panel" role="dialog" aria-modal="true" aria-labelledby="project-gantt-task-dialog-title">
          <header><div><h2 id="project-gantt-task-dialog-title">neue Aufgabe</h2></div><button aria-label="Schließen" onClick={() => setGanttTaskDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="project-gantt-task-form">
            <label className="wide"><span>Aufgabenname</span><input autoFocus maxLength={240} value={ganttTaskDraft.title} onChange={(event) => setGanttTaskDraft({ ...ganttTaskDraft, title: event.target.value })} placeholder="Was muss getan werden?" /></label>
            <label><span>Elternphase</span><AppSelect ariaLabel="Elternphase" value={ganttTaskDraft.phaseId} onValueChange={(phaseId) => setGanttTaskDraft({ ...ganttTaskDraft, phaseId })} options={[{ value: "", label: "Keine Gruppierung" }, ...overview.phases.map((phase) => ({ value: phase.id, label: phase.name }))]} /></label>
            <DateTimeField label="planmäßiger Start" mode="date" value={ganttTaskDraft.plannedStart} onChange={(plannedStart) => setGanttTaskDraft({ ...ganttTaskDraft, plannedStart })} />
            <label><span>Zeitplan (Tage)</span><input type="number" min={1} max={2600} value={ganttTaskDraft.durationWorkdays} onChange={(event) => setGanttTaskDraft({ ...ganttTaskDraft, durationWorkdays: Math.max(1, Math.min(2600, Number(event.target.value) || 1)) })} /></label>
          </div>
          <footer><small>{ganttTaskDraft.plannedStart ? `Erwartetes Ende:${formatProjectMilestoneDate(addProjectDays(ganttTaskDraft.plannedStart, ganttTaskDraft.durationWorkdays - 1))}` : "Wenn das Startdatum nicht festgelegt ist, tritt die Aufgabe in einen ungeplanten Bereich ein."}</small><div><button className="secondary-button" disabled={busy} onClick={() => setGanttTaskDraft(undefined)}>Abbrechen</button><button className="primary-button" disabled={busy || !ganttTaskDraft.title.trim()} onClick={() => void createGanttTask()}>{busy && <LoaderCircle className="spin" size={14} />}Aufgabe erstellen</button></div></footer>
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
  readonly kind: "task" | "milestone";
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
  onChangeMilestoneDate,
  onReorderItem,
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
  readonly onChangeMilestoneDate: (milestone: ClientProjectMilestone, dueOn: string) => Promise<boolean>;
  readonly onReorderItem: (input: ProjectGanttReorderInput) => Promise<boolean>;
  readonly onEdit: (task: ClientProjectGanttTask) => void;
  readonly onEditMilestone: (milestone: ClientProjectMilestone) => void;
  readonly onCreateMilestone: (dueOn?: string, phaseId?: string) => void;
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
  const milestoneDragPreviewRef = useRef<ProjectGanttMilestoneDragPreview | undefined>(undefined);
  const createSelectionRef = useRef<ProjectGanttCreateSelection | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const suppressMilestoneClickRef = useRef(false);
  const suppressRowClickRef = useRef(false);
  const [dragPreview, setDragPreview] = useState<ProjectGanttDragPreview>();
  const [milestoneDragPreview, setMilestoneDragPreview] = useState<ProjectGanttMilestoneDragPreview>();
  const [createSelection, setCreateSelection] = useState<ProjectGanttCreateSelection>();
  const [savingTaskId, setSavingTaskId] = useState<string>();
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

  const sortTasks = (entries: readonly ClientProjectGanttTask[]) => [...entries].sort((left, right) => {
    if (left.ganttSortOrder !== right.ganttSortOrder) return left.ganttSortOrder - right.ganttSortOrder;
    return left.createdAt.localeCompare(right.createdAt) || left.title.localeCompare(right.title);
  });
  const sortMilestones = (entries: readonly ClientProjectMilestone[]) => [...entries].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt) || left.title.localeCompare(right.title)
  ));
  const orderedPhases = [...phases].sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
  const phaseIds = new Set(phases.map((phase) => phase.id));
  const ungroupedTasks = sortTasks(tasks.filter((task) => !task.phaseId || !phaseIds.has(task.phaseId)));
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
    targetKind: "phase" | "task" | "milestone",
    targetId: string | undefined,
    targetPhaseId: string | undefined,
  ) => {
    if (!rowDrag || busy || readOnly) return false;
    if (rowDrag.kind === "task") {
      return targetKind === "task"
        && targetId !== rowDrag.itemId
        && (targetPhaseId ?? "") === (rowDrag.phaseId ?? "");
    }
    return targetKind !== "milestone" || targetId !== rowDrag.itemId;
  };

  const dragOverRow = (
    event: ReactDragEvent<HTMLElement>,
    key: string,
    targetKind: "phase" | "task" | "milestone",
    targetId: string | undefined,
    targetPhaseId: string | undefined,
  ) => {
    if (!canDropRow(targetKind, targetId, targetPhaseId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const orderedTarget = (rowDrag?.kind === "task" && targetKind === "task")
      || (rowDrag?.kind === "milestone" && targetKind === "milestone");
    const position = orderedTarget
      ? (event.clientY < bounds.top + bounds.height / 2 ? "before" : "after")
      : "inside";
    if (dropTarget?.key !== key || dropTarget.position !== position) setDropTarget({ key, position });
  };

  const dropOnRow = (
    event: ReactDragEvent<HTMLElement>,
    targetKind: "phase" | "task" | "milestone",
    targetId: string | undefined,
    targetPhaseId: string | undefined,
  ) => {
    if (!rowDrag || !canDropRow(targetKind, targetId, targetPhaseId)) return;
    event.preventDefault();
    let beforeId: string | undefined;
    const orderedTarget = (rowDrag.kind === "task" && targetKind === "task")
      || (rowDrag.kind === "milestone" && targetKind === "milestone");
    if (orderedTarget && targetId) {
      const siblings = rowDrag.kind === "task"
        ? sortTasks(tasks.filter((task) => (task.phaseId ?? "") === (targetPhaseId ?? "") && task.id !== rowDrag.itemId))
        : sortMilestones(milestones.filter((milestone) => (milestone.phaseId ?? "") === (targetPhaseId ?? "") && milestone.id !== rowDrag.itemId));
      const targetIndex = siblings.findIndex((entry) => entry.id === targetId);
      beforeId = dropTarget?.position === "after" ? siblings[targetIndex + 1]?.id : targetId;
    }
    const input: ProjectGanttReorderInput = {
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
  ) => {
    if (event.button !== 0 || event.pointerType !== "mouse" || readOnly || busy || savingTaskId || savingMilestoneId || dragPreviewRef.current || milestoneDragPreviewRef.current || rowDrag) return;
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
    ><Plus size={12} />{selectionWidth >= 60 && <span>{selectionWidth < 150 ? `${duration} Tage` : rangeLabel}</span>}</div>;
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
    const durationLabel = `${task.durationWorkdays ?? (task.plannedStart && task.plannedEnd ? countProjectDays(task.plannedStart, task.plannedEnd) : 1)} Tage`;
    const rowKey = `task:${task.id}`;
    return <div
      className={`project-gantt-row ${task.status === "done" ? "done" : ""}${rowDrag?.kind === "task" && rowDrag.itemId === task.id ? " project-gantt-row-dragging" : ""}${rowDropClass(rowKey)}`}
      key={task.id}
      onDragOver={(event) => dragOverRow(event, rowKey, "task", task.id, task.phaseId)}
      onDrop={(event) => dropOnRow(event, "task", task.id, task.phaseId)}
    >
      <button className="project-gantt-task" title="Ziehen, um die Reihenfolge anzupassen; klicken, um die Aufgabe zu bearbeiten" disabled={readOnly} draggable={!readOnly && !busy} onDragStart={(event) => startRowDrag(event, { kind: "task", itemId: task.id, phaseId: task.phaseId })} onDragEnd={finishRowDrag} onClick={() => openRowAfterClick(() => onEdit(task))} onContextMenu={(event) => openTaskMenu(event, task)}><span><strong>{task.title}</strong>{(task.autoSchedule || dependencyTitles.length > 0) && <small>{task.autoSchedule ? "Automatische Planung" : `Abhängigkeiten: ${dependencyTitles.join(", ")}`}</small>}</span><span className="project-gantt-row-actions"><small className="project-gantt-duration">{durationLabel}</small><GripVertical size={14} /><Pencil size={13} /></span></button>
      <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event, task.phaseId)} {...createTrackHandlers(`task:${task.id}`, task.phaseId)}>
        {weekendBands()}
        {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
        {renderCreateSelection(`task:${task.id}`)}
        {durationDays ? <div
          className={`project-gantt-bar ${taskPreview ? `dragging ${taskPreview.mode}` : ""} ${saving ? "saving" : ""}`}
          role="button"
          tabIndex={readOnly ? -1 : 0}
          aria-disabled={readOnly || saving}
          aria-label={`Aufgabenplan bearbeiten:${task.title}, ${previewStart} zu ${previewEnd}`}
          title={`${task.title}: ${previewStart} – ${previewEnd}`}
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
            aria-label={`Passen Sie sich an "${task.title}Datum des Beginns`}
            title="Ziehen, um das Startdatum anzupassen"
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
            aria-label={`Passen Sie sich an "${task.title}"Enddatum`}
            title="Datum der Drag-Anpassung"
            onClick={(event) => { event.stopPropagation(); openTaskAfterClick(task); }}
            onPointerDown={(event) => startDrag(event, task, "resize-end", startIndex, durationDays)}
            onPointerMove={(event) => updateDragPreview(event.clientX)}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
          />}
        </div> : <button className="project-gantt-unscheduled" disabled={readOnly} onClick={() => onEdit(task)} onContextMenu={(event) => openTaskMenu(event, task)}>das geplante Datum festlegen</button>}
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
      <button className="project-gantt-task" title="Drag-Anpassungsstufen und -Sequenzen, klicken Sie auf Bearbeitung" disabled={readOnly} draggable={!readOnly && !busy} onDragStart={(event) => startRowDrag(event, { kind: "milestone", itemId: milestone.id, phaseId: milestone.phaseId })} onDragEnd={finishRowDrag} onClick={() => openRowAfterClick(() => onEditMilestone(milestone))} onContextMenu={(event) => openCanvasMenu(event, milestone.phaseId, false)}><span><strong>{milestone.title}</strong><small>Meilensteine . . . . . . . . . . {displayDate ? formatProjectMilestoneDate(displayDate) : "kein Datum festgelegt"}</small></span><span className="project-gantt-row-actions"><GripVertical size={14} /><Award size={13} /></span></button>
      <div className="project-gantt-track" onContextMenu={(event) => openCanvasMenu(event, milestone.phaseId)}>
        {weekendBands()}
        {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
        {offset === undefined
          ? <button className="project-gantt-unscheduled" disabled={readOnly} onClick={() => onEditMilestone(milestone)}>Zieldatum festlegen</button>
          : <button
            className={`project-gantt-milestone${preview ? " dragging" : ""}${saving ? " saving" : ""}`}
            disabled={readOnly || saving}
            title={`Datum der Drag-Anpassung:${milestone.title} · ${displayDate}`}
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

  const menuCommands: readonly ResolvedContextCommand[] = menu?.kind === "task" ? [
    { id: "gantt.edit-task", label: "Aufgabenplan bearbeiten", group: "primary", risk: "local-write", icon: "edit", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
    { id: "gantt.delete-task", label: "Aufgaben dauerhaft löschen", group: "danger", risk: "destructive", icon: "trash", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
  ] : menu?.kind === "phase" ? [
    { id: "gantt.add-task", label: "Aufgaben zur Phase hinzufügen", group: "primary", risk: "local-write", icon: "task", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
    { id: "gantt.add-milestone", label: "Meilensteine in der Phase hinzufügen", group: "primary", risk: "local-write", icon: "calendar-plus", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
    { id: "gantt.edit-phase", label: "Farbe umbenennen oder ändern", group: "organize", risk: "local-write", icon: "edit", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
    { id: "gantt.delete-phase", label: "Phase löschen", group: "danger", risk: "destructive", icon: "trash", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
  ] : [
    { id: "gantt.add-task", label: menu?.date ? `in der ${formatProjectMilestoneDate(menu.date)} Aufgaben hinzufügen` : "Aufgaben hinzufügen", group: "primary", risk: "local-write", icon: "task", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
    { id: "gantt.add-milestone", label: menu?.date ? `in der ${formatProjectMilestoneDate(menu.date)} Meilensteine hinzufügen` : "Meilensteine hinzufügen", group: "primary", risk: "local-write", icon: "calendar-plus", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
    { id: "gantt.add-phase", label: "Phase hinzufügen", group: "organize", risk: "local-write", icon: "folder", disabledReason: readOnly || busy ? "das aktuelle Projekt kann nicht geändert werden" : undefined },
  ];

  const selectMenuCommand = (commandId: ContextCommandId) => {
    const ganttCommand = commandId as ProjectGanttCommandId;
    if (ganttCommand === "gantt.add-task") onCreateTask(menu?.phase?.id ?? menu?.phaseId, menu?.date);
    else if (ganttCommand === "gantt.add-milestone") onCreateMilestone(menu?.date, menu?.phase?.id ?? menu?.phaseId);
    else if (ganttCommand === "gantt.add-phase") onCreatePhase();
    else if (ganttCommand === "gantt.edit-task" && menu?.task) onEdit(menu.task);
    else if (ganttCommand === "gantt.delete-task" && menu?.task) onDeleteTask(menu.task);
    else if (ganttCommand === "gantt.edit-phase" && menu?.phase) onEditPhase(menu.phase);
    else if (ganttCommand === "gantt.delete-phase" && menu?.phase) onDeletePhase(menu.phase);
  };

  return (
    <section className="panel project-gantt">
      <header>
        <div className="project-gantt-title"><CalendarClock size={17} /><span><strong><span className="project-gantt-desktop-label">Projekt Gantt Diagramm</span><span className="project-gantt-mobile-label">Projektplan</span></strong><small>{plannedTasks.length} / {tasks.length} Geplante Aufgaben . . {phases.length} eine Phase</small></span></div>
        <div className="project-gantt-toolbar" aria-label="Gantt Diagramm Ansichtssteuerung">
          <button type="button" onClick={scrollToToday}>Heute</button>
          <button type="button" onClick={fitTimeline}>Anpassungsprojekt</button>
          <span className="project-gantt-zoom">
            <button type="button" aria-label="reduzierte Gantt-Diagramme" title="Schrumpfen" disabled={dayWidth <= PROJECT_GANTT_MIN_DAY_WIDTH} onClick={() => applyZoom(dayWidthRef.current - PROJECT_GANTT_ZOOM_STEP)}>−</button>
            <output title={`${dayWidth.toFixed(1)} Pixel/Tag`}>{Math.round(dayWidth / PROJECT_GANTT_DEFAULT_DAY_WIDTH * 100)}%</output>
            <button type="button" aria-label="Vergrößerung der Gantt-Diagramme" title="Verkleinern" disabled={dayWidth >= PROJECT_GANTT_MAX_DAY_WIDTH} onClick={() => applyZoom(dayWidthRef.current + PROJECT_GANTT_ZOOM_STEP)}>+</button>
          </span>
        </div>
      </header>
      <div className="project-gantt-scroll" ref={scrollRef}>
        <div className="project-gantt-table" style={{ "--gantt-width": `${timelineWidth}px`, "--gantt-day-width": `${dayWidth}px`, "--gantt-week-width": `${dayWidth * 7}px` } as CSSProperties}>
          <div className="project-gantt-heading">
            <div className="project-gantt-task-heading" onContextMenu={(event) => openCanvasMenu(event, undefined, false)}>Phasen, Aufgaben und Vertrauen</div>
            <div className="project-gantt-time-heading" onContextMenu={(event) => openCanvasMenu(event)}>{weekendBands()}{timeMarkers.map((marker) => <span key={marker.date.toISOString()} style={{ left: marker.left }}>{new Intl.DateTimeFormat("de-DE", { month: "short", day: "numeric" }).format(marker.date)}</span>)}</div>
          </div>
          {orderedPhases.flatMap((phase) => {
            const phaseTasks = sortTasks(tasks.filter((task) => task.phaseId === phase.id));
            const phaseMilestones = sortMilestones(milestones.filter((milestone) => milestone.phaseId === phase.id));
            const collapsed = collapsedPhaseIds.has(phase.id);
            const phasePlannedTasks = phaseTasks.filter((task) => task.plannedStart && task.plannedEnd);
            const phaseDates = [
              ...phasePlannedTasks.flatMap((task) => [task.plannedStart!, task.plannedEnd!]),
              ...phaseMilestones.flatMap((milestone) => milestone.dueOn ? [milestone.dueOn] : []),
            ].sort();
            const phaseStart = phaseDates[0];
            const phaseEnd = phaseDates.at(-1);
            const completed = phaseTasks.filter((task) => task.status === "done").length;
            const completionPercent = phaseTasks.length ? Math.round((completed / phaseTasks.length) * 100) : 0;
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
              })} onContextMenu={(event) => openPhaseMenu(event, phase)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<i style={{ background: phase.color }} /><span><strong>{phase.name}</strong><small>{phaseTasks.length} Aufgabe . . . . . . . . . . . {phaseMilestones.length} ein Meilenstein . . . . . . . . . . {completionPercent}%</small></span><MoreHorizontal size={13} /></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event, phase.id)} {...createTrackHandlers(`phase:${phase.id}`, phase.id)}>
                {weekendBands()}
                {todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}
                {renderCreateSelection(`phase:${phase.id}`)}
                {phaseStart && phaseEnd && <div className="project-gantt-phase-bar" style={{ left: projectDayDifference(rangeStart, phaseStart) * dayWidth, width: (projectDayDifference(phaseStart, phaseEnd) + 1) * dayWidth, borderColor: phase.color }}><i style={{ width: `${completionPercent}%`, background: phase.color }} /></div>}
              </div>
            </div>;
            return collapsed ? [phaseRow] : [phaseRow, ...phaseTasks.map(renderTaskRow), ...phaseMilestones.map(renderMilestoneRow)];
          })}
          {(ungroupedTasks.length > 0 || ungroupedMilestones.length > 0 || rowDrag?.kind === "milestone" || (!tasks.length && !phases.length && !milestones.length)) && <>
            {phases.length > 0 && <div
              className={`project-gantt-row project-gantt-phase-row project-gantt-ungrouped-row${rowDropClass("phase:project")}`}
              onDragOver={(event) => dragOverRow(event, "phase:project", "phase", undefined, undefined)}
              onDrop={(event) => dropOnRow(event, "phase", undefined, undefined)}
            >
              <button className="project-gantt-task project-gantt-phase" disabled={readOnly} onContextMenu={(event) => openCanvasMenu(event, undefined, false)}><FolderPlus size={14} /><span><strong>Projektebene / nicht gruppiert</strong><small>{ungroupedTasks.length} Aufgabe . . . . . . . . . . . {ungroupedMilestones.length} ein Meilenstein</small></span></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event)} {...createTrackHandlers("ungrouped")}>{weekendBands()}{todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}{renderCreateSelection("ungrouped")}</div>
            </div>}
            {ungroupedTasks.map(renderTaskRow)}
            {ungroupedMilestones.map(renderMilestoneRow)}
            {!tasks.length && !phases.length && !milestones.length && <div className="project-gantt-row project-gantt-empty-row">
              <button className="project-gantt-task" disabled={readOnly} onClick={() => onCreateTask()} onContextMenu={(event) => openCanvasMenu(event, undefined, false)}><span><strong>keine Projektaufgabe verfügbar</strong><small>Klicken Sie auf oder rechts, um die Planung zu starten</small></span><Plus size={14} /></button>
              <div className="project-gantt-track can-create" onContextMenu={(event) => openCanvasMenu(event)} {...createTrackHandlers("empty")}>{weekendBands()}{todayOffset >= 0 && todayOffset <= timelineWidth && <i className="project-gantt-today" style={{ left: todayOffset }} />}{renderCreateSelection("empty")}</div>
            </div>}
          </>}
        </div>
      </div>
      <footer><span><i style={{ background: projectColor }} />Geplante Aufgaben</span><span><i className="weekend" />Wochenende</span><span><i className="today" />Heute</span><small>{readOnly ? "Das archivierte Projekt ist schreibgeschützt." : "Ziehen Sie Datum der Anpassung . Rechte Schlüsselverwaltung . Strg + Roll Zurück"}</small></footer>
      {menu && <ContextMenu anchor={{ x: menu.x, y: menu.y }} ariaLabel="Gantt-Diagrammbetrieb" commands={menuCommands} heading={menu.task?.title ?? menu.phase?.name ?? (menu.date ? formatProjectMilestoneDate(menu.date) : "Projekt Gantt Diagramm")} returnFocus={menu.returnFocus} testId="project-gantt-context-menu" onClose={() => setMenu(undefined)} onSelect={selectMenuCommand} />}
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
  const formatter = new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric", timeZone: "UTC" });
  return `${formatter.format(new Date(projectDateToUtcTime(start)))} – ${formatter.format(new Date(projectDateToUtcTime(end)))}`;
}

function toDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatProjectMinutes(minutes: number): string {
  if (!minutes) return "0 Minuten";
  if (minutes < 60) return `${minutes} Minuten`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} Stunden` : `${hours.toFixed(1)} Stunden`;
}

function formatProjectBlockDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatProjectMilestoneDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`));
}
