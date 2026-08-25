"use client";

import Link from "next/link";
import {
  AlertCircle, CalendarDays, CalendarClock, Check, CheckCircle2, ChevronDown,
  ChevronRight, Circle, Clock3, Folder, FolderPlus, GripVertical, Inbox, Link2, ListChecks,
  LayoutGrid, LoaderCircle, Mail, MoreHorizontal, Pause, Pencil, Plus, RefreshCw, Star, Trash2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { appConfirm } from "@/components/app-dialog-provider";
import { useRealtimeEvent, useRealtimeRefresh, type RealtimeEvent } from "@/components/realtime-context";
import { AppSelect } from "../app-select";
import { ContextMenu } from "../context-menu";
import { resolveContextCommands, type TaskCommandId } from "../context-commands";
import { DateTimeField } from "../ui/date-time-field";
import { TransientToast } from "../workspace-shared";
import { RelatedContentPanel } from "./related-content";
import { resolveNewTaskDefaults } from "./task-view-model";

const TASKS_CHANGED_EVENT = "kalender:tasks-changed";

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

interface CalendarListItem {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: { readonly providerId?: string };
}

function nextCalendarHour(value: Date): Date {
  const result = new Date(value);
  result.setMinutes(0, 0, 0);
  result.setHours(result.getHours() + 1);
  return result;
}

function toLocalDateTimeInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

type TaskStatus = "inbox" | "next" | "waiting" | "someday" | "done";
type TaskUrgencyMode = "auto" | "urgent" | "not_urgent";
export type TaskView = "today" | "inbox" | "upcoming" | "waiting" | "projects" | "completed" | "matrix";

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
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly phaseId?: string;
  readonly durationWorkdays?: number;
  readonly autoSchedule: boolean;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
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
  projectId: string;
  projectName: string;
  areaName: string;
  assigneeUserId: string;
}

interface ClientCollaborator {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

interface TaskContextMenuState {
  readonly taskId: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

const taskViewCopy: Record<TaskView, string> = {
  today: "Heute",
  inbox: "Sammelbox",
  upcoming: "Folgemaßnahmen",
  waiting: "Warten",
  projects: "Projekt",
  completed: "abgeschlossen",
  matrix: "vier Quadranten",
};

export function TasksPage({
  initialTaskId,
  initialTaskView,
  initialCreateTask,
  initialProjectId,
  initialScheduleTaskId,
}: {
  readonly initialTaskId?: string;
  readonly initialTaskView?: TaskView;
  readonly initialCreateTask?: boolean;
  readonly initialProjectId?: string;
  readonly initialScheduleTaskId?: string;
}) {
  const [tasks, setTasks] = useState<readonly ClientTask[]>([]);
  const [taskProjects, setTaskProjects] = useState<readonly ClientProject[]>([]);
  const [collaborators, setCollaborators] = useState<readonly ClientCollaborator[]>([]);
  const [view, setView] = useState<TaskView>(initialTaskView ?? "today");
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
  const openedProjectTask = useRef(false);

  const loadTasks = useCallback(async ({ background = false }: { readonly background?: boolean } = {}) => {
    if (!background) setLoading(true);
    try {
      const [tasksResponse, projectsResponse, collaboratorsResponse] = await Promise.all([
        workspaceFetch("/api/tasks?includeCompleted=true"),
        workspaceFetch("/api/projects?includeArchived=true"),
        workspaceFetch("/api/collaborators"),
      ]);
      const tasksPayload = await tasksResponse.json() as { ok: boolean; tasks?: readonly ClientTask[]; message?: string };
      const projectsPayload = await projectsResponse.json() as { ok: boolean; projects?: readonly ClientProject[]; message?: string };
      const collaboratorsPayload = await collaboratorsResponse.json() as { ok: boolean; users?: readonly ClientCollaborator[]; message?: string };
      if (!tasksResponse.ok || !tasksPayload.ok) throw new Error(tasksPayload.message ?? "Aufgabe kann nicht gelesen werden");
      if (!projectsResponse.ok || !projectsPayload.ok) throw new Error(projectsPayload.message ?? "Projekt kann nicht gelesen werden");
      setTasks(tasksPayload.tasks ?? []);
      setTaskProjects(projectsPayload.projects ?? []);
      if (collaboratorsResponse.ok && collaboratorsPayload.ok) setCollaborators(collaboratorsPayload.users ?? []);
      if (!background) setFeedback(undefined);
    } catch (error) {
      if (!background) setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht gelesen werden");
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);
  const applyRealtimeTask = useCallback(async (event: RealtimeEvent) => {
    if (event.entityType !== "tasks" || !event.entityId) {
      await loadTasks({ background: true });
      return;
    }
    if (event.action === "delete") {
      setTasks((current) => current.filter((task) => task.id !== event.entityId));
      setDraft((current) => current?.id === event.entityId ? undefined : current);
      return;
    }
    const response = await workspaceFetch(`/api/tasks/${encodeURIComponent(event.entityId)}`, {}, 0);
    if (response.status === 404) {
      setTasks((current) => current.filter((task) => task.id !== event.entityId));
      return;
    }
    const payload = await response.json() as {
      readonly ok?: boolean;
      readonly task?: ClientTask;
      readonly message?: string;
    };
    if (!response.ok || !payload.ok || !payload.task) {
      throw new Error(payload.message ?? "Aufgaben können nicht schrittweise aktualisiert werden");
    }
    setTasks((current) => {
      const found = current.some((task) => task.id === payload.task!.id);
      return found
        ? current.map((task) => task.id === payload.task!.id ? payload.task! : task)
        : [payload.task!, ...current];
    });
  }, [loadTasks]);
  useRealtimeEvent(["task"], (event) => {
    void applyRealtimeTask(event).catch(() => loadTasks({ background: true }));
  });
  useRealtimeRefresh(["project", "calendar", "relation"], () => loadTasks({ background: true }));
  useEffect(() => {
    if (initialTaskView) setView(initialTaskView);
  }, [initialTaskView]);
  useEffect(() => {
    if (!initialCreateTask || !initialProjectId || loading || openedProjectTask.current) return;
    openedProjectTask.current = true;
    const defaults = resolveNewTaskDefaults("projects", initialProjectId, taskProjects);
    if (!defaults.ok) {
      setFeedback(defaults.message);
      return;
    }
    setView("projects");
    setDraft({
      ...createEmptyTaskDraft(defaults.status),
      projectId: defaults.projectId ?? "",
      projectName: defaults.projectName ?? "",
      areaName: defaults.areaName ?? "",
    });
  }, [initialCreateTask, initialProjectId, loading, taskProjects]);
  useEffect(() => {
    void workspaceFetch("/api/calendars")
      .then(async (response) => {
        const payload = await response.json() as { readonly calendars?: readonly CalendarListItem[]; readonly message?: string };
        if (!response.ok || !payload.calendars) throw new Error(payload.message ?? "Kalender kann nicht gelesen werden");
        setTaskCalendars(payload.calendars.filter((calendar) => !calendar.readOnly && calendar.providerData?.providerId === "local-calendar"));
      })
      .catch((error: unknown) => setFeedback(error instanceof Error ? error.message : "Kalender kann nicht gelesen werden"));
  }, []);
  useEffect(() => {
    if (!initialTaskId || openedInitialTask.current || loading) return;
    openedInitialTask.current = true;
    const task = tasks.find((entry) => entry.id === initialTaskId);
    if (task) {
      setView(task.status === "inbox" ? "inbox" : task.status === "done" ? "completed" : task.status === "waiting" ? "waiting" : "today");
      setDraft(taskToDraft(task));
      setFeedback("Aufgaben offen für Kalender-Veranstaltungsassoziation");
    } else {
      setFeedback("Zugehörige Aufgaben gelöscht oder abgeschlossen");
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
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "Aufgabe kann nicht gespeichert werden");
      setTasks((current) => [payload.task!, ...current.filter((task) => task.id !== payload.task!.id)]);
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      setDraft(undefined);
      setFeedback(draft.id ? "Aufgabe aktualisiert" : "Aufgabe erstellt");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht gespeichert werden");
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
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "Temporärer Ordner kann nicht geschlossen werden: %s");
      setTasks((current) => current.map((entry) => entry.id === task.id ? payload.task! : entry));
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      setFeedback(changes.status === "done" ? "Erledigte Aufgabe" : "Aufgabe aktualisiert");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Temporärer Ordner kann nicht geschlossen werden: %s");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const deleteTask = async (task: ClientTask) => {
    if (!await appConfirm({
      title: `Aufgaben löschen${task.title}“?`,
      description: "Die Aufgabe und deren Kalenderblock werden dauerhaft gelöscht und diese Operation kann nicht widerrufen werden.",
      confirmLabel: "Aufgaben löschen",
      tone: "danger",
    })) return;
    setBusyTaskId(task.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const payload = await response.json() as { ok: boolean; message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Aufgabe kann nicht gelöscht werden");
      setTasks((current) => current.filter((entry) => entry.id !== task.id));
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      setFeedback("Aufgabe gelöscht");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht gelöscht werden");
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
      setFeedback("kein lokaler Kalender zum Schreiben");
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
      setFeedback("Aufgaben, die geplant werden sollen, existieren nicht oder sind bereits abgeschlossen");
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
      setFeedback("Die Endzeit muss später als die Startzeit sein.");
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
        setFeedback("die ausgewählten Zeitkonflikte mit dem bestehenden Kalenderereignis");
        return;
      }
      if (!response.ok || !payload.task) throw new Error(payload.message ?? "Aufgabe kann nicht geplant werden");
      setTasks((current) => current.map((entry) => entry.id === payload.task!.id ? payload.task! : entry));
      setScheduleDraft(undefined);
      if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft);
      setFeedback(scheduleDraft.eventId ? "Aufgaben-Zeitblock aktualisiert" : "Aufgabe für den Kalender geplant");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht geplant werden");
    } finally {
      setScheduleBusy(false);
    }
  };

  const deleteTaskTimeBlock = async (task: ClientTask, block: ClientTaskTimeBlock) => {
    if (scheduleBusy || !await appConfirm({
      title: "Diesen Zeitblock löschen?",
      description: `${formatTaskBlockRange(block.start, block.end)}Die \n-Aufgabe selbst wird beibehalten und in vorgeordneten Status zurückgegeben.`,
      confirmLabel: "Zeitblock löschen",
      tone: "danger",
    })) return;
    setScheduleBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/schedule/${encodeURIComponent(block.eventId)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: ClientTask; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "Zeitblock kann nicht gelöscht werden");
      setTasks((current) => current.map((entry) => entry.id === payload.task!.id ? payload.task! : entry));
      setFeedback("Zeitblock gelöscht und Aufgabe beibehalten");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Zeitblock kann nicht gelöscht werden");
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
  const projectTasks = matrixTasks.filter((task) => task.projectId || task.projectName);
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
    projects: new Set(projectTasks.map((task) => task.projectId ?? `legacy:${task.projectName}`)).size,
    completed: completedTasks.length,
    matrix: matrixTasks.length,
  };
  const editingTask = draft?.id ? tasks.find((task) => task.id === draft.id) : undefined;
  const openNewTask = () => {
    const defaults = resolveNewTaskDefaults(view, initialProjectId, taskProjects);
    if (!defaults.ok) {
      setFeedback(defaults.message);
      return;
    }
    setDraft({
      ...createEmptyTaskDraft(defaults.status),
      projectId: defaults.projectId ?? "",
      projectName: defaults.projectName ?? "",
      areaName: defaults.areaName ?? "",
    });
  };

  return (
    <div className="task-workspace">
      <div className="task-view-toolbar">
        <nav className="task-view-tabs" aria-label="Aufgabenansicht">
          {taskViews.map((item) => {
            const Icon = item === "today" ? CalendarClock : item === "inbox" ? Inbox : item === "upcoming" ? CalendarDays : item === "waiting" ? Pause : item === "projects" ? FolderPlus : item === "completed" ? CheckCircle2 : LayoutGrid;
            return <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}><Icon size={15} />{taskViewCopy[item]}<span>{viewCounts[item]}</span></button>;
          })}
        </nav>
        <div className="task-view-actions">
          <button className="secondary-button" onClick={openNewTask}><Plus size={15} />Aufgaben hinzufügen</button>
        </div>
      </div>

      {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
      {loading ? (
        <div className="task-loading"><LoaderCircle className="spin" size={17} />Aufgabe lesen...</div>
      ) : view === "matrix" ? (
        <TaskMatrix tasks={matrixTasks} busyTaskId={busyTaskId} onComplete={(task) => void updateTask(task, { status: "done" })} onEdit={(task) => setDraft(taskToDraft(task))} onMenu={openTaskMenu} onMove={(task, important, urgent) => void updateTask(task, { important, urgencyMode: urgent ? "urgent" : "not_urgent" })} />
      ) : view === "projects" ? (
        <TaskProjectGroups projects={taskProjects} selectedProjectId={initialProjectId} tasks={projectTasks} busyTaskId={busyTaskId} onComplete={(task) => void updateTask(task, { status: "done" })} onEdit={(task) => setDraft(taskToDraft(task))} onMenu={openTaskMenu} />
      ) : visibleTasks.length ? (
        <section className="panel task-list-panel">
          {visibleTasks.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => void updateTask(task, { status: task.status === "done" ? "next" : "done" })} onEdit={() => setDraft(taskToDraft(task))} onMenu={(x, y, returnFocus) => openTaskMenu(task, x, y, returnFocus)} />)}
        </section>
      ) : (
        <section className="panel task-empty-state">
          <div><CheckCircle2 size={22} /></div>
          <h3>{view === "inbox" ? "Task-Collection-Box ist leer" : view === "completed" ? "Noch nicht abgeschlossen" : view === "waiting" ? "Nein, warte nicht." : view === "upcoming" ? "keine Folgeabschaltungsaufgabe" : "keine Notfallaufgabe heute"}</h3>
          <p>{view === "inbox" ? "UI-Text: Schreiben Sie es schnell auf, bevor Sie Projekte, Fristen und Prioritäten zu einem späteren Zeitpunkt festlegen." : view === "completed" ? "Aufzeichnungen werden hier nach Abschluss der Aufgabe aufbewahrt und können auch wieder geöffnet werden." : view === "waiting" ? "Aufgaben, die von anderen abhängen, werden auf Eis gelegt, um zentralisierte Folgemaßnahmen zu erleichtern." : view === "upcoming" ? "Die Frist für die Festlegung der Aufgabe nach heute wird hier erscheinen." : "Ein wichtiger, aber nicht dringender Aufgabenplan kann aus einem vier Quadranten ausgewählt werden."}</p>
          <button className="primary-button" onClick={() => setDraft(createEmptyTaskDraft(view === "inbox" ? "inbox" : "next"))}><Plus size={15} />neue Aufgabe</button>
        </section>
      )}

      {draft && (
        <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyTaskId) setDraft(undefined); }}>
          <section className="calendar-dialog task-dialog panel" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
            <header><div><h2 id="task-dialog-title">{draft.id ? "Aufgaben bearbeiten" : "neue Aufgabe"}</h2></div><button aria-label="Schließen" onClick={() => setDraft(undefined)} disabled={Boolean(busyTaskId)}><X size={18} /></button></header>
            <div className="task-form">
              <label className="task-title-field"><span>Aufgabentitel</span><input autoFocus value={draft.title} maxLength={240} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Was willst du erreichen?" /></label>
              <label><span>Status</span><AppSelect ariaLabel="Status der Aufgaben" value={draft.status} onValueChange={(status) => setDraft({ ...draft, status: status as TaskStatus })} options={[{ value: "inbox", label: "Posteingang - zu vereinigen" }, { value: "next", label: "Weiter" }, { value: "waiting", label: "warten" }, { value: "someday", label: "Vielleicht später." }, { value: "done", label: "abgeschlossen" }]} /></label>
              <label><span>Dringlichkeitsgrad</span><AppSelect ariaLabel="Dringlichkeitsgrad" value={draft.urgencyMode} onValueChange={(urgencyMode) => setDraft({ ...draft, urgencyMode: urgencyMode as TaskUrgencyMode })} options={[{ value: "auto", label: "automatisch (nach Ablauf der Frist)" }, { value: "urgent", label: "Notfall" }, { value: "not_urgent", label: "Kein Notfall" }]} /></label>
              <DateTimeField label="Fälligkeitsdatum" value={draft.dueAt} onChange={(dueAt) => setDraft({ ...draft, dueAt })} />
              <label><span>voraussichtliche Dauer (Minuten)</span><input type="number" min="5" max="1440" step="5" value={draft.estimatedMinutes} onChange={(event) => setDraft({ ...draft, estimatedMinutes: event.target.value })} placeholder="z.B. 45" /></label>
              <label className="task-project-field"><span>Projekt</span><AppSelect ariaLabel="aufgabenbeteiligte Projekte" value={draft.projectId || (draft.projectName ? "__legacy__" : "")} onValueChange={(projectId) => {
                const project = taskProjects.find((entry) => entry.id === projectId);
                setDraft({
                  ...draft,
                  projectId: project?.id ?? "",
                  projectName: project?.name ?? "",
                  areaName: project?.areaName ?? (projectId ? draft.areaName : ""),
                });
              }} options={[{ value: "", label: "keine Projekte" }, ...(draft.projectName && !draft.projectId ? [{ value: "__legacy__", label: `Alte Tabs . ${draft.projectName}`, disabled: true }] : []), ...taskProjects.map((project) => ({ value: project.id, label: `${project.name}${project.areaName ? ` · ${project.areaName}` : ""}${project.status === "archived" ? " · Archiviert" : ""}`, disabled: project.status === "archived" && project.id !== draft.projectId }))]} /></label>
              <label className="task-important-field"><input type="checkbox" checked={draft.important} onChange={(event) => setDraft({ ...draft, important: event.target.checked })} /><Star size={15} fill={draft.important ? "currentColor" : "none"} /><span>Dies ist eine wichtige Aufgabe</span></label>
              <details className="task-advanced-options">
                <summary><span>mehr Optionen{draft.areaName || draft.assigneeUserId || draft.notes ? " . . . . . . . . . . ." : ""}</span><ChevronDown size={16} /></summary>
                <div>
                  <label><span>Bereich{draft.projectId ? " · Nach Projekt vererbt" : ""}</span><input value={draft.areaName} maxLength={100} disabled={Boolean(draft.projectId)} onChange={(event) => setDraft({ ...draft, areaName: event.target.value })} placeholder="z.B. Arbeit/Einzelperson" /></label>
                  <label><span>zugewiesen</span><AppSelect ariaLabel="Mandatsinhaber" value={draft.assigneeUserId} onValueChange={(assigneeUserId) => setDraft({ ...draft, assigneeUserId })} options={[{ value: "", label: "nicht zugeordnet" }, ...collaborators.map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))]} /></label>
                  <label className="task-notes-field"><span>Notizen</span><textarea value={draft.notes} maxLength={10_000} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Ergänzen von Standards, Warten oder Nächsten..." /></label>
                </div>
              </details>
              {editingTask && <section className="task-time-blocks"><header><div><CalendarClock size={15} /><span>Zeit im Fokus</span><em>{editingTask.scheduledBlocks.length}</em></div><button type="button" className="secondary-button" onClick={() => openSchedule(editingTask, undefined, true)}><Plus size={14} />Zeit hinzufügen</button></header>{editingTask.scheduledBlocks.length ? <div>{editingTask.scheduledBlocks.map((block) => <article key={block.eventId}><Link href={block.href}><CalendarClock size={14} /><span><strong>{formatTaskBlockRange(block.start, block.end)}</strong><small>{block.calendarName}</small></span></Link><button type="button" aria-label={`Zeit anpassen:${formatTaskBlockRange(block.start, block.end)}`} title="Zeit anpassen" onClick={() => openSchedule(editingTask, block, true)}><Pencil size={14} /></button><button type="button" className="danger-button" aria-label={`Zeitblock löschen:${formatTaskBlockRange(block.start, block.end)}`} title="Zeitblock löschen" disabled={scheduleBusy} onClick={() => void deleteTaskTimeBlock(editingTask, block)}><Trash2 size={14} /></button></article>)}</div> : <p>Es wurde keine Fokuszeit geplant. Sie können mehrere Zeitblöcke hinzufügen oder später in den Kalender ziehen.</p>}</section>}
              {draft.id && <RelatedContentPanel kind="task" entityId={draft.id} emptyText="Diese Aufgabe hat keine zugehörige Quelle oder Zeitblock." />}
            </div>
            <footer><div><button className="secondary-button" disabled={Boolean(busyTaskId)} onClick={() => setDraft(undefined)}>Abbrechen</button><button className="primary-button" disabled={Boolean(busyTaskId) || !draft.title.trim()} onClick={() => void saveDraft()}>{busyTaskId && <LoaderCircle className="spin" size={15} />}{draft.id ? "Änderungen speichern" : "Aufgabe erstellen"}</button></div></footer>
          </section>
        </div>
      )}

      {scheduleDraft && (
        <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !scheduleBusy) setScheduleDraft(undefined); }}>
          <section className="calendar-dialog task-schedule-dialog panel" role="dialog" aria-modal="true" aria-labelledby="task-schedule-title">
            <header><div><h2 id="task-schedule-title">{scheduleDraft.eventId ? "Anpassungsmodalitäten" : "Zeitplan für den Kalender"}</h2></div><button aria-label="Schließen" onClick={() => { if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft); setScheduleDraft(undefined); }} disabled={scheduleBusy}><X size={18} /></button></header>
            <div className="task-schedule-summary"><ListChecks size={17} /><strong>{scheduleDraft.taskTitle}</strong></div>
            <div className="calendar-form task-schedule-form">
              <DateTimeField label="Anfang" value={scheduleDraft.startLocal} onChange={changeScheduleStart} />
              <DateTimeField label="Ende" value={scheduleDraft.endLocal} onChange={(value) => { setScheduleDraft((current) => current ? { ...current, endLocal: value, conflicts: [] } : current); }} />
              <label className="calendar-title-field"><span>Kalender</span><AppSelect ariaLabel="Zeitplan für den Kalender" value={scheduleDraft.calendarId} onValueChange={(calendarId) => setScheduleDraft((current) => current ? { ...current, calendarId, conflicts: [] } : current)} options={taskCalendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))} /></label>
            </div>
            {scheduleDraft.conflicts.length > 0 && <div className="task-schedule-conflicts" role="alert"><header><AlertCircle size={16} /><strong>Zeitkonflikt erkannt</strong></header>{scheduleDraft.conflicts.map((conflict) => <div key={conflict.id}><span>{formatTaskBlockRange(conflict.start, conflict.end)}</span><strong>{conflict.title}</strong></div>)}<p>Sie können die Zeit ändern oder bestätigen, dass sie noch angeordnet ist.</p></div>}
            <footer><div><button className="secondary-button" disabled={scheduleBusy} onClick={() => { if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft); setScheduleDraft(undefined); }}>Abbrechen</button><button className={scheduleDraft.conflicts.length ? "danger-confirm-button" : "primary-button"} disabled={scheduleBusy} onClick={() => void saveSchedule(scheduleDraft.conflicts.length > 0)}>{scheduleBusy && <LoaderCircle className="spin" size={15} />}{scheduleDraft.conflicts.length ? "Immer noch arrangiert" : scheduleDraft.eventId ? "Zeitersparnis" : "Zeitblock erstellen"}</button></div></footer>
          </section>
        </div>
      )}

      {menu && menuTask && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          ariaLabel="Aufgaben"
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

function TaskProjectGroups({ projects, selectedProjectId, tasks, busyTaskId, onComplete, onEdit, onMenu }: {
  readonly projects: readonly ClientProject[];
  readonly selectedProjectId?: string;
  readonly tasks: readonly ClientTask[];
  readonly busyTaskId?: string;
  readonly onComplete: (task: ClientTask) => void;
  readonly onEdit: (task: ClientTask) => void;
  readonly onMenu: (task: ClientTask, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const visibleProjects = projects.filter((project) => (
    (project.status === "active" || project.id === selectedProjectId)
    && (!selectedProjectId || project.id === selectedProjectId)
    && (Boolean(selectedProjectId) || tasks.some((task) => task.projectId === project.id))
  ));
  const legacyGroups = selectedProjectId ? [] : Array.from(new Set(
    tasks.filter((task) => !task.projectId).map((task) => task.projectName).filter((name): name is string => Boolean(name)),
  ));
  if (!visibleProjects.length && !legacyGroups.length) {
    const selectedProject = projects.find((project) => project.id === selectedProjectId);
    return <section className="panel task-empty-state"><div><FolderPlus size={22} /></div><h3>{selectedProject ? `${selectedProject.name} zur Zeit keine Aufgabe` : "keine Projektaufgabe verfügbar"}</h3><p>{selectedProject ? "Wählen Sie dieses Projekt beim Erstellen oder Bearbeiten einer Aufgabe aus, die hier angezeigt wird." : "Wählen Sie in den Aufgabendetails ein Projekt aus, das hier automatisch aggregiert wird."}</p></section>;
  }
  return <div className="task-project-groups">
    {visibleProjects.map((project) => {
      const entries = tasks.filter((task) => task.projectId === project.id);
      return <section className="panel" key={project.id}><header><div><i style={{ background: project.color }} /><Link href={`/projects?project=${encodeURIComponent(project.id)}`}>{project.name}</Link>{project.areaName && <small>{project.areaName}</small>}</div><span>{entries.length}</span></header>{entries.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}</section>;
    })}
    {legacyGroups.map((projectName) => {
      const entries = tasks.filter((task) => !task.projectId && task.projectName === projectName);
      return <section className="panel" key={`legacy:${projectName}`}><header><div><FolderPlus size={15} /><strong>{projectName}</strong><small>alte Gruppe</small></div><span>{entries.length}</span></header>{entries.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}</section>;
    })}
  </div>;
}

function TaskMatrix({ tasks, busyTaskId, onComplete, onEdit, onMenu, onMove }: {
  readonly tasks: readonly ClientTask[];
  readonly busyTaskId?: string;
  readonly onComplete: (task: ClientTask) => void;
  readonly onEdit: (task: ClientTask) => void;
  readonly onMenu: (task: ClientTask, x: number, y: number, returnFocus?: HTMLElement | null) => void;
  readonly onMove: (task: ClientTask, important: boolean, urgent: boolean) => void;
}) {
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const quadrants = [
    { key: "important-urgent", title: "sofortige Verarbeitung", hint: "Wichtig und dringend", important: true, urgent: true },
    { key: "important-calm", title: "Zeitplanung", hint: "wichtig, aber nicht dringend", important: true, urgent: false },
    { key: "urgent-light", title: "Charge oder Kommission", hint: "Notfall, aber nicht wichtig", important: false, urgent: true },
    { key: "calm-light", title: "reduzierter Eingang", hint: "nicht wichtig und nicht dringend", important: false, urgent: false },
  ] as const;

  const finishDrag = () => {
    setDraggedTaskId(undefined);
    setDropTarget(undefined);
  };

  return (
    <div className={`task-matrix panel ${draggedTaskId ? "is-dragging" : ""}`} aria-label="Aufgabe vier Quadranten">
      <div className="task-matrix-corner" aria-hidden="true"><LayoutGrid size={16} /><span>Wesentlichkeit</span></div>
      <div className="task-matrix-column-heading urgent"><strong>Notfall</strong><span>muss so schnell wie möglich vorangebracht werden</span></div>
      <div className="task-matrix-column-heading calm"><strong>Kein Notfall</strong><span>Sie können planen</span></div>
      <div className="task-matrix-row-heading important"><strong>Wichtig</strong><span>Wirkungsziel</span></div>
      <div className="task-matrix-row-heading light"><strong>nicht wichtig</strong><span>Begrenzte Auswirkungen</span></div>
      {quadrants.map((quadrant) => {
        const entries = tasks.filter((task) => task.important === quadrant.important && task.isUrgent === quadrant.urgent);
        const isDropTarget = dropTarget === quadrant.key;
        return (
          <section
            className={`task-quadrant ${quadrant.key} ${isDropTarget ? "drop-target" : ""}`}
            key={quadrant.key}
            onDragEnter={(event) => {
              if (!draggedTaskId) return;
              event.preventDefault();
              setDropTarget(quadrant.key);
            }}
            onDragOver={(event) => {
              if (!draggedTaskId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const taskId = draggedTaskId ?? event.dataTransfer.getData("text/plain");
              const task = tasks.find((entry) => entry.id === taskId);
              if (task && (task.important !== quadrant.important || task.isUrgent !== quadrant.urgent)) {
                onMove(task, quadrant.important, quadrant.urgent);
              }
              finishDrag();
            }}
          >
            <header><div><h3>{quadrant.title}</h3><p>{quadrant.hint}</p></div><span aria-label={`${entries.length} eine Aufgabe`}>{entries.length}</span></header>
            <div className="task-quadrant-list">
              {entries.map((task) => <TaskCard task={task} compact draggable key={task.id} busy={busyTaskId === task.id} dragging={draggedTaskId === task.id} onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", task.id);
                setDraggedTaskId(task.id);
              }} onDragEnd={finishDrag} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}
              {!entries.length && <div className="task-quadrant-empty"><CheckCircle2 size={17} /><span>{draggedTaskId ? "Hier ist es." : "zur Zeit keine Aufgabe"}</span></div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ task, busy, compact, draggable, dragging, onDragStart, onDragEnd, onComplete, onEdit, onMenu }: {
  readonly task: ClientTask;
  readonly busy: boolean;
  readonly compact?: boolean;
  readonly draggable?: boolean;
  readonly dragging?: boolean;
  readonly onDragStart?: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd?: () => void;
  readonly onComplete: () => void;
  readonly onEdit: () => void;
  readonly onMenu: (x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const source = task.sourceReferences[0];
  const mailSource = task.sourceReferences.find((entry) => entry.kind === "mail");
  const scheduledBlock = task.scheduledBlocks[0];
  return (
    <article className={`task-card ${compact ? "compact" : ""} ${draggable ? "draggable" : ""} ${dragging ? "dragging" : ""}`} draggable={draggable && !busy} onDragStart={onDragStart} onDragEnd={onDragEnd} onContextMenu={(event) => { event.preventDefault(); onMenu(event.clientX, event.clientY, event.currentTarget); }}>
      <button className={`task-check ${task.status === "done" ? "completed" : ""}`} aria-label={`${task.status === "done" ? "Wiedereröffnen" : "Erledigt"} ${task.title}`} title={task.status === "done" ? "Aufgaben wieder öffnen" : "als fertig markiert"} disabled={busy} onClick={onComplete}>{busy ? <LoaderCircle className="spin" size={15} /> : task.status === "done" ? <RefreshCw size={15} /> : <Check size={15} />}</button>
      <button className="task-card-body" onClick={onEdit}>
        <strong>{task.title}</strong>
        <span className="task-card-meta">
          {task.dueAt && <em className={new Date(task.dueAt).getTime() < Date.now() ? "overdue" : undefined}><CalendarClock size={12} />{formatTaskDue(task.dueAt)}</em>}
          {task.estimatedMinutes && <em><Clock3 size={12} />{formatTaskEstimate(task.estimatedMinutes)}</em>}
          {task.projectName && <em>{task.projectName}</em>}
          {task.areaName && <em>{task.areaName}</em>}
          {task.assigneeDisplayName && <em>zugewiesen {task.assigneeDisplayName}</em>}
          {source && <em><Link2 size={12} />{source.label}</em>}
          {scheduledBlock && <em className="scheduled"><CalendarClock size={12} />{task.scheduledBlockCount > 1 ? `Angeordnet ${task.scheduledBlockCount} einen Zeitblock . ` : "Angeordnet "}{formatTaskBlockRange(scheduledBlock.start, scheduledBlock.end)}</em>}
          {task.status === "waiting" && <em>warten</em>}
        </span>
      </button>
      <div className="task-card-flags">{scheduledBlock && <Link className="task-calendar-link" href={scheduledBlock.href} aria-label={`Eröffnungsveranstaltung für den Kalender:${scheduledBlock.title}`} title={`Eröffnungsveranstaltung für den Kalender:${formatTaskBlockRange(scheduledBlock.start, scheduledBlock.end)}`}><CalendarClock size={13} /></Link>}{mailSource && <Link className="task-source-link" href={taskSourceHref(mailSource) ?? "/inbox"} aria-label={`Offene Assoziations-E-Mail:${mailSource.label}`} title={`Offene Assoziations-E-Mail:${mailSource.label}`}><Mail size={13} /></Link>}{task.important && <Star size={13} fill="currentColor" />}{task.isUrgent && <span>Dringend</span>}</div>
      {draggable && <GripVertical className="task-drag-indicator" size={14} aria-hidden="true" />}
      <button className="task-menu-trigger" aria-label={`mehr Operationen:${task.title}`} aria-expanded={false} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); onMenu(bounds.right, bounds.bottom + 4, event.currentTarget); }}><MoreHorizontal size={15} /></button>
    </article>
  );
}

function createEmptyTaskDraft(status: TaskStatus): TaskDraft {
  return { title: "", notes: "", status, important: false, urgencyMode: "auto", dueAt: "", estimatedMinutes: "", projectId: "", projectName: "", areaName: "", assigneeUserId: "", sourceReferences: [] };
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
    projectId: task.projectId ?? "",
    projectName: task.projectName ?? "",
    areaName: task.areaName ?? "",
    assigneeUserId: task.assigneeUserId ?? "",
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
    projectId: draft.projectId || undefined,
    projectName: draft.projectId ? undefined : draft.projectName || undefined,
    areaName: draft.areaName || undefined,
    assigneeUserId: draft.assigneeUserId || undefined,
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

function taskSourceLabel(kind: ClientTaskSource["kind"]): string {
  return kind === "mail" ? "E-Mail" : kind === "calendar" ? "Kalender" : "Notiz";
}
