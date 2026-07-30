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
import { TransientToast } from "../workspace-shared";
import { RelatedContentPanel } from "./related-content";

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
  today: "Today",
  inbox: "Inbox",
  upcoming: "Upcoming",
  waiting: "Waiting",
  projects: "项目",
  completed: "Completed",
  matrix: "四象限",
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
      if (!tasksResponse.ok || !tasksPayload.ok) throw new Error(tasksPayload.message ?? "无法读取任务");
      if (!projectsResponse.ok || !projectsPayload.ok) throw new Error(projectsPayload.message ?? "无法读取项目");
      setTasks(tasksPayload.tasks ?? []);
      setTaskProjects(projectsPayload.projects ?? []);
      if (collaboratorsResponse.ok && collaboratorsPayload.ok) setCollaborators(collaboratorsPayload.users ?? []);
      if (!background) setFeedback(undefined);
    } catch (error) {
      if (!background) setFeedback(error instanceof Error ? error.message : "无法读取任务");
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
      throw new Error(payload.message ?? "无法增量刷新任务");
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
    const project = taskProjects.find((entry) => entry.id === initialProjectId);
    if (!project || project.status === "archived") {
      setFeedback(project ? "已归档项目不能添加任务" : "项目不存在或已删除");
      return;
    }
    setView("projects");
    setDraft({
      ...createEmptyTaskDraft("next"),
      projectId: project.id,
      projectName: project.name,
      areaName: project.areaName ?? "",
    });
  }, [initialCreateTask, initialProjectId, loading, taskProjects]);
  useEffect(() => {
    void workspaceFetch("/api/calendars")
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
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
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
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
      setFeedback(changes.status === "done" ? "任务已完成" : "任务已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法更新任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const deleteTask = async (task: ClientTask) => {
    if (!await appConfirm({
      title: `删除任务“${task.title}”？`,
      description: "任务及其日历时间块将被永久删除，此操作无法撤销。",
      confirmLabel: "删除任务",
      tone: "danger",
    })) return;
    setBusyTaskId(task.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const payload = await response.json() as { ok: boolean; message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除任务");
      setTasks((current) => current.filter((entry) => entry.id !== task.id));
      window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
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
    if (scheduleBusy || !await appConfirm({
      title: "删除这个时间块？",
      description: `${formatTaskBlockRange(block.start, block.end)}\n任务本身会保留，并重新回到待安排状态。`,
      confirmLabel: "删除时间块",
      tone: "danger",
    })) return;
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
      <nav className="task-view-tabs task-view-tabs-mobile" aria-label="任务视图">
        {taskViews.map((item) => {
          const Icon = item === "today" ? CalendarClock : item === "inbox" ? Inbox : item === "upcoming" ? CalendarDays : item === "waiting" ? Pause : item === "projects" ? FolderPlus : item === "completed" ? CheckCircle2 : LayoutGrid;
          return <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}><Icon size={15} />{taskViewCopy[item]}<span>{viewCounts[item]}</span></button>;
        })}
      </nav>

      <div className="task-view-actions">
        <button className="secondary-button" onClick={() => setDraft(createEmptyTaskDraft(view === "matrix" ? "next" : "inbox"))}><Plus size={15} />添加任务</button>
      </div>

      {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
      {loading ? (
        <div className="task-loading"><LoaderCircle className="spin" size={17} />正在读取任务…</div>
      ) : view === "matrix" ? (
        <TaskMatrix tasks={matrixTasks} busyTaskId={busyTaskId} onComplete={(task) => void updateTask(task, { status: "done" })} onEdit={(task) => setDraft(taskToDraft(task))} onMenu={openTaskMenu} onMove={(task, important, urgent) => void updateTask(task, { important, urgencyMode: urgent ? "urgent" : "not_urgent" })} />
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
            <header><div><h2 id="task-dialog-title">{draft.id ? "编辑任务" : "新建任务"}</h2></div><button aria-label="关闭" onClick={() => setDraft(undefined)} disabled={Boolean(busyTaskId)}><X size={18} /></button></header>
            <div className="task-form">
              <label className="task-title-field"><span>任务标题</span><input autoFocus value={draft.title} maxLength={240} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="要完成什么？" /></label>
              <label><span>状态</span><AppSelect ariaLabel="任务状态" value={draft.status} onValueChange={(status) => setDraft({ ...draft, status: status as TaskStatus })} options={[{ value: "inbox", label: "Inbox · 待整理" }, { value: "next", label: "下一步" }, { value: "waiting", label: "等待中" }, { value: "someday", label: "以后也许" }, { value: "done", label: "已完成" }]} /></label>
              <label><span>紧急程度</span><AppSelect ariaLabel="紧急程度" value={draft.urgencyMode} onValueChange={(urgencyMode) => setDraft({ ...draft, urgencyMode: urgencyMode as TaskUrgencyMode })} options={[{ value: "auto", label: "自动（按截止时间）" }, { value: "urgent", label: "紧急" }, { value: "not_urgent", label: "不紧急" }]} /></label>
              <label><span>截止时间</span><input type="datetime-local" value={draft.dueAt} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value })} /></label>
              <label><span>预计时长（分钟）</span><input type="number" min="5" max="1440" step="5" value={draft.estimatedMinutes} onChange={(event) => setDraft({ ...draft, estimatedMinutes: event.target.value })} placeholder="例如 45" /></label>
              <label className="task-project-field"><span>项目</span><AppSelect ariaLabel="任务所属项目" value={draft.projectId || (draft.projectName ? "__legacy__" : "")} onValueChange={(projectId) => {
                const project = taskProjects.find((entry) => entry.id === projectId);
                setDraft({
                  ...draft,
                  projectId: project?.id ?? "",
                  projectName: project?.name ?? "",
                  areaName: project?.areaName ?? (projectId ? draft.areaName : ""),
                });
              }} options={[{ value: "", label: "无项目" }, ...(draft.projectName && !draft.projectId ? [{ value: "__legacy__", label: `旧标签 · ${draft.projectName}`, disabled: true }] : []), ...taskProjects.map((project) => ({ value: project.id, label: `${project.name}${project.areaName ? ` · ${project.areaName}` : ""}${project.status === "archived" ? " · 已归档" : ""}`, disabled: project.status === "archived" && project.id !== draft.projectId }))]} /></label>
              <label className="task-important-field"><input type="checkbox" checked={draft.important} onChange={(event) => setDraft({ ...draft, important: event.target.checked })} /><Star size={15} fill={draft.important ? "currentColor" : "none"} /><span>这是重要任务</span></label>
              <details className="task-advanced-options">
                <summary><span>更多选项{draft.areaName || draft.assigneeUserId || draft.notes ? " · 已填写" : ""}</span><ChevronDown size={16} /></summary>
                <div>
                  <label><span>领域{draft.projectId ? " · 由项目继承" : ""}</span><input value={draft.areaName} maxLength={100} disabled={Boolean(draft.projectId)} onChange={(event) => setDraft({ ...draft, areaName: event.target.value })} placeholder="例如 工作 / 个人" /></label>
                  <label><span>指派给</span><AppSelect ariaLabel="任务负责人" value={draft.assigneeUserId} onValueChange={(assigneeUserId) => setDraft({ ...draft, assigneeUserId })} options={[{ value: "", label: "未指派" }, ...collaborators.map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))]} /></label>
                  <label className="task-notes-field"><span>备注</span><textarea value={draft.notes} maxLength={10_000} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="补充完成标准、等待事项或下一步…" /></label>
                </div>
              </details>
              {editingTask && <section className="task-time-blocks"><header><div><CalendarClock size={15} /><span>专注时间</span><em>{editingTask.scheduledBlocks.length}</em></div><button type="button" className="secondary-button" onClick={() => openSchedule(editingTask, undefined, true)}><Plus size={14} />添加时间</button></header>{editingTask.scheduledBlocks.length ? <div>{editingTask.scheduledBlocks.map((block) => <article key={block.eventId}><Link href={block.href}><CalendarClock size={14} /><span><strong>{formatTaskBlockRange(block.start, block.end)}</strong><small>{block.calendarName}</small></span></Link><button type="button" aria-label={`调整时间：${formatTaskBlockRange(block.start, block.end)}`} title="调整时间" onClick={() => openSchedule(editingTask, block, true)}><Pencil size={14} /></button><button type="button" className="danger-button" aria-label={`删除时间块：${formatTaskBlockRange(block.start, block.end)}`} title="删除时间块" disabled={scheduleBusy} onClick={() => void deleteTaskTimeBlock(editingTask, block)}><Trash2 size={14} /></button></article>)}</div> : <p>尚未安排专注时间。可以添加多个时间块，也可以稍后拖入日历。</p>}</section>}
              {draft.id && <RelatedContentPanel kind="task" entityId={draft.id} emptyText="这个任务还没有关联来源或时间块。" />}
            </div>
            <footer><div><button className="secondary-button" disabled={Boolean(busyTaskId)} onClick={() => setDraft(undefined)}>取消</button><button className="primary-button" disabled={Boolean(busyTaskId) || !draft.title.trim()} onClick={() => void saveDraft()}>{busyTaskId && <LoaderCircle className="spin" size={15} />}{draft.id ? "保存修改" : "创建任务"}</button></div></footer>
          </section>
        </div>
      )}

      {scheduleDraft && (
        <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !scheduleBusy) setScheduleDraft(undefined); }}>
          <section className="calendar-dialog task-schedule-dialog panel" role="dialog" aria-modal="true" aria-labelledby="task-schedule-title">
            <header><div><h2 id="task-schedule-title">{scheduleDraft.eventId ? "调整安排" : "安排到日历"}</h2></div><button aria-label="关闭" onClick={() => { if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft); setScheduleDraft(undefined); }} disabled={scheduleBusy}><X size={18} /></button></header>
            <div className="task-schedule-summary"><ListChecks size={17} /><strong>{scheduleDraft.taskTitle}</strong></div>
            <div className="calendar-form task-schedule-form">
              <label><span>开始</span><input type="datetime-local" value={scheduleDraft.startLocal} onChange={(event) => changeScheduleStart(event.target.value)} /></label>
              <label><span>结束</span><input type="datetime-local" value={scheduleDraft.endLocal} onChange={(event) => { const value = event.target.value; setScheduleDraft((current) => current ? { ...current, endLocal: value, conflicts: [] } : current); }} /></label>
              <label className="calendar-title-field"><span>日历</span><AppSelect ariaLabel="安排到日历" value={scheduleDraft.calendarId} onValueChange={(calendarId) => setScheduleDraft((current) => current ? { ...current, calendarId, conflicts: [] } : current)} options={taskCalendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))} /></label>
            </div>
            {scheduleDraft.conflicts.length > 0 && <div className="task-schedule-conflicts" role="alert"><header><AlertCircle size={16} /><strong>发现时间冲突</strong></header>{scheduleDraft.conflicts.map((conflict) => <div key={conflict.id}><span>{formatTaskBlockRange(conflict.start, conflict.end)}</span><strong>{conflict.title}</strong></div>)}<p>你可以修改时间，或者确认仍然安排。</p></div>}
            <footer><div><button className="secondary-button" disabled={scheduleBusy} onClick={() => { if (scheduleDraft.returnTaskDraft) setDraft(scheduleDraft.returnTaskDraft); setScheduleDraft(undefined); }}>取消</button><button className={scheduleDraft.conflicts.length ? "danger-confirm-button" : "primary-button"} disabled={scheduleBusy} onClick={() => void saveSchedule(scheduleDraft.conflicts.length > 0)}>{scheduleBusy && <LoaderCircle className="spin" size={15} />}{scheduleDraft.conflicts.length ? "仍然安排" : scheduleDraft.eventId ? "保存时间" : "创建时间块"}</button></div></footer>
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
  if (!groups.length) return <section className="panel task-empty-state"><div><FolderPlus size={22} /></div><h3>还没有项目任务</h3><p>在任务详情中选择一个项目，相关行动会自动汇总到这里。</p></section>;
  return <div className="task-project-groups">{groups.map((project) => {
    const entries = tasks.filter((task) => task.projectName === project);
    const color = entries.find((task) => task.projectColor)?.projectColor;
    const projectId = entries.find((task) => task.projectId)?.projectId;
    return <section className="panel" key={project}><header><div>{color ? <i style={{ background: color }} /> : <FolderPlus size={15} />}{projectId ? <Link href={`/projects?project=${encodeURIComponent(projectId)}`}>{project}</Link> : <strong>{project}</strong>}</div><span>{entries.length}</span></header>{entries.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}</section>;
  })}</div>;
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
    { key: "important-urgent", title: "立即处理", hint: "重要且紧急", important: true, urgent: true },
    { key: "important-calm", title: "安排时间", hint: "重要但不紧急", important: true, urgent: false },
    { key: "urgent-light", title: "批量或委托", hint: "紧急但不重要", important: false, urgent: true },
    { key: "calm-light", title: "减少投入", hint: "不重要且不紧急", important: false, urgent: false },
  ] as const;

  const finishDrag = () => {
    setDraggedTaskId(undefined);
    setDropTarget(undefined);
  };

  return (
    <div className={`task-matrix panel ${draggedTaskId ? "is-dragging" : ""}`} aria-label="任务四象限">
      <div className="task-matrix-corner" aria-hidden="true"><LayoutGrid size={16} /><span>重要性</span></div>
      <div className="task-matrix-column-heading urgent"><strong>紧急</strong><span>需要尽快推进</span></div>
      <div className="task-matrix-column-heading calm"><strong>不紧急</strong><span>可以计划安排</span></div>
      <div className="task-matrix-row-heading important"><strong>重要</strong><span>影响目标</span></div>
      <div className="task-matrix-row-heading light"><strong>不重要</strong><span>影响有限</span></div>
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
            <header><div><h3>{quadrant.title}</h3><p>{quadrant.hint}</p></div><span aria-label={`${entries.length} 个任务`}>{entries.length}</span></header>
            <div className="task-quadrant-list">
              {entries.map((task) => <TaskCard task={task} compact draggable key={task.id} busy={busyTaskId === task.id} dragging={draggedTaskId === task.id} onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", task.id);
                setDraggedTaskId(task.id);
              }} onDragEnd={finishDrag} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}
              {!entries.length && <div className="task-quadrant-empty"><CheckCircle2 size={17} /><span>{draggedTaskId ? "放到这里" : "暂无任务"}</span></div>}
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
      <button className={`task-check ${task.status === "done" ? "completed" : ""}`} aria-label={`${task.status === "done" ? "重新打开" : "完成"} ${task.title}`} title={task.status === "done" ? "重新打开任务" : "标记为已完成"} disabled={busy} onClick={onComplete}>{busy ? <LoaderCircle className="spin" size={15} /> : task.status === "done" ? <RefreshCw size={15} /> : <Check size={15} />}</button>
      <button className="task-card-body" onClick={onEdit}>
        <strong>{task.title}</strong>
        <span className="task-card-meta">
          {task.dueAt && <em className={new Date(task.dueAt).getTime() < Date.now() ? "overdue" : undefined}><CalendarClock size={12} />{formatTaskDue(task.dueAt)}</em>}
          {task.estimatedMinutes && <em><Clock3 size={12} />{formatTaskEstimate(task.estimatedMinutes)}</em>}
          {task.projectName && <em>{task.projectName}</em>}
          {task.areaName && <em>{task.areaName}</em>}
          {task.assigneeDisplayName && <em>指派给 {task.assigneeDisplayName}</em>}
          {source && <em><Link2 size={12} />{source.label}</em>}
          {scheduledBlock && <em className="scheduled"><CalendarClock size={12} />{task.scheduledBlockCount > 1 ? `已安排 ${task.scheduledBlockCount} 个时间块 · ` : "已安排 "}{formatTaskBlockRange(scheduledBlock.start, scheduledBlock.end)}</em>}
          {task.status === "waiting" && <em>等待中</em>}
        </span>
      </button>
      <div className="task-card-flags">{scheduledBlock && <Link className="task-calendar-link" href={scheduledBlock.href} aria-label={`打开安排的日程：${scheduledBlock.title}`} title={`打开安排的日程：${formatTaskBlockRange(scheduledBlock.start, scheduledBlock.end)}`}><CalendarClock size={13} /></Link>}{mailSource && <Link className="task-source-link" href={taskSourceHref(mailSource) ?? "/inbox"} aria-label={`打开关联邮件：${mailSource.label}`} title={`打开关联邮件：${mailSource.label}`}><Mail size={13} /></Link>}{task.important && <Star size={13} fill="currentColor" />}{task.isUrgent && <span>急</span>}</div>
      {draggable && <GripVertical className="task-drag-indicator" size={14} aria-hidden="true" />}
      <button className="task-menu-trigger" aria-label={`更多操作：${task.title}`} aria-expanded={false} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); onMenu(bounds.right, bounds.bottom + 4, event.currentTarget); }}><MoreHorizontal size={15} /></button>
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
