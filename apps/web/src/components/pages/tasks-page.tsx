"use client";

import Link from "next/link";
import {
  CalendarDays, CalendarClock, Check, CheckCircle2,
  ChevronRight, Circle, Clock3, Folder, FolderPlus, GripVertical, Inbox, Link2, ListChecks,
  LayoutGrid, LoaderCircle, Mail, MoreHorizontal, Pause, Plus, RefreshCw, Star, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { appConfirm } from "@/components/app-dialog-provider";
import { useRealtimeEvent, useRealtimeRefresh, type RealtimeEvent } from "@/components/realtime-context";
import { AppSelect } from "../app-select";
import { ContextMenu } from "../context-menu";
import { resolveContextCommands, type TaskCommandId } from "../context-commands";
import { TransientToast } from "../workspace-shared";
import { TaskEditorDialog } from "./task-editor-dialog";
import { offerToCompleteLinkedPlanItem } from "./project-plan-progress";
import { TaskScheduleDialog } from "./task-schedule-dialog";
import { resolveNewTaskDefaults } from "./task-view-model";

const TASKS_CHANGED_EVENT = "kalender:tasks-changed";
const PROJECTS_CHANGED_EVENT = "kalender:projects-changed";

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

interface ClientTaskTimeBlock {
  readonly eventId: string;
  readonly calendarId: string;
  readonly calendarName: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly href: string;
}

interface TaskScheduleTarget {
  readonly task: ClientTask;
  readonly block?: ClientTaskTimeBlock;
  readonly returnTaskDraft?: TaskDraft;
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
  planItemId: string;
  projectName: string;
  areaName: string;
  assigneeUserId: string;
}

interface ClientTaskPlanItem {
  readonly id: string;
  readonly title: string;
  readonly status: "planned" | "in_progress" | "paused" | "done" | "cancelled";
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
  today: "今天",
  inbox: "收集箱",
  upcoming: "后续",
  waiting: "等待",
  projects: "项目",
  completed: "已完成",
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
  const [taskPlanItems, setTaskPlanItems] = useState<readonly ClientTaskPlanItem[]>([]);
  const [collaborators, setCollaborators] = useState<readonly ClientCollaborator[]>([]);
  const [view, setView] = useState<TaskView>(initialTaskView ?? "today");
  const [loading, setLoading] = useState(true);
  const [busyTaskId, setBusyTaskId] = useState<string>();
  const [draft, setDraft] = useState<TaskDraft>();
  const [feedback, setFeedback] = useState<string>();
  const [menu, setMenu] = useState<TaskContextMenuState>();
  const [scheduleTarget, setScheduleTarget] = useState<TaskScheduleTarget>();
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
  useEffect(() => {
    let active = true;
    if (!draft?.projectId) {
      setTaskPlanItems([]);
      return () => { active = false; };
    }
    void (async () => {
      try {
        const response = await workspaceFetch(`/api/projects/${encodeURIComponent(draft.projectId)}`);
        const payload = await response.json() as {
          readonly ok?: boolean;
          readonly overview?: { readonly planItems?: readonly ClientTaskPlanItem[] };
        };
        if (active) setTaskPlanItems(response.ok && payload.ok ? payload.overview?.planItems ?? [] : []);
      } catch {
        if (active) setTaskPlanItems([]);
      }
    })();
    return () => { active = false; };
  }, [draft?.projectId]);
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
    const previousTask = draft.id ? tasks.find((task) => task.id === draft.id) : undefined;
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
      let completedPlanItem = false;
      if (previousTask?.status !== "done" && payload.task.status === "done") {
        try {
          completedPlanItem = await offerToCompleteLinkedPlanItem(payload.task);
          if (completedPlanItem) window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
        } catch (error) {
          setFeedback(`任务已完成，但${error instanceof Error ? error.message : "无法检查计划项进度"}`);
          return;
        }
      }
      setFeedback(completedPlanItem ? "任务和关联计划项已完成" : draft.id ? "任务已更新" : "任务已创建");
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
      let completedPlanItem = false;
      if (task.status !== "done" && payload.task.status === "done") {
        try {
          completedPlanItem = await offerToCompleteLinkedPlanItem(payload.task);
          if (completedPlanItem) window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
        } catch (error) {
          setFeedback(`任务已完成，但${error instanceof Error ? error.message : "无法检查计划项进度"}`);
          return;
        }
      }
      setFeedback(completedPlanItem ? "任务和关联计划项已完成" : payload.task.status === "done" ? "任务已完成" : "任务已更新");
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
    if (returnToTaskDetails) setDraft(undefined);
    setScheduleTarget({
      task,
      block,
      returnTaskDraft: returnToTaskDetails ? draft : undefined,
    });
  };

  useEffect(() => {
    if (!initialScheduleTaskId || openedInitialScheduleTask.current || loading) return;
    openedInitialScheduleTask.current = true;
    const task = tasks.find((entry) => entry.id === initialScheduleTaskId);
    if (!task || task.status === "done") {
      setFeedback("待安排任务不存在或已经完成");
      return;
    }
    setView(task.status === "inbox" ? "inbox" : task.status === "waiting" ? "waiting" : "today");
    openSchedule(task);
  }, [initialScheduleTaskId, loading, tasks]);

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
        <nav className="task-view-tabs" aria-label="任务视图">
          {taskViews.map((item) => {
            const Icon = item === "today" ? CalendarClock : item === "inbox" ? Inbox : item === "upcoming" ? CalendarDays : item === "waiting" ? Pause : item === "projects" ? FolderPlus : item === "completed" ? CheckCircle2 : LayoutGrid;
            return <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}><Icon size={15} />{taskViewCopy[item]}<span>{viewCounts[item]}</span></button>;
          })}
        </nav>
        <div className="task-view-actions">
          <button className="secondary-button" onClick={openNewTask}><Plus size={15} />添加任务</button>
        </div>
      </div>

      {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
      {loading ? (
        <div className="task-loading"><LoaderCircle className="spin" size={17} />正在读取任务…</div>
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
          <h3>{view === "inbox" ? "任务收集箱是空的" : view === "completed" ? "还没有已完成任务" : view === "waiting" ? "没有等待事项" : view === "upcoming" ? "没有后续截止任务" : "今天没有紧急任务"}</h3>
          <p>{view === "inbox" ? "先快速记下来，稍后再设置项目、截止时间和优先级。" : view === "completed" ? "完成任务后会在这里保留记录，也可以重新打开。" : view === "waiting" ? "将依赖他人的任务设为等待中，方便集中跟进。" : view === "upcoming" ? "给任务设置今天之后的截止时间，就会出现在这里。" : "可以从四象限里挑一项重要但不紧急的任务安排时间。"}</p>
          <button className="primary-button" onClick={() => setDraft(createEmptyTaskDraft(view === "inbox" ? "inbox" : "next"))}><Plus size={15} />新建任务</button>
        </section>
      )}

      {draft && <TaskEditorDialog
        draft={draft}
        projects={taskProjects}
        planItems={taskPlanItems}
        collaborators={collaborators}
        editingTask={editingTask}
        busy={Boolean(busyTaskId)}
        scheduleBusy={scheduleBusy}
        onDraftChange={(nextDraft) => setDraft(nextDraft as TaskDraft)}
        onClose={() => setDraft(undefined)}
        onSave={() => void saveDraft()}
        onSchedule={(block) => { if (editingTask) openSchedule(editingTask, block as ClientTaskTimeBlock | undefined, true); }}
        onDeleteTimeBlock={(block) => { if (editingTask) void deleteTaskTimeBlock(editingTask, block as ClientTaskTimeBlock); }}
      />}

      {scheduleTarget && <TaskScheduleDialog
        task={scheduleTarget.task}
        block={scheduleTarget.block}
        onClose={() => {
          if (scheduleTarget.returnTaskDraft) setDraft(scheduleTarget.returnTaskDraft);
          setScheduleTarget(undefined);
        }}
        onSaved={(savedTask) => {
          setTasks((current) => current.map((entry) => entry.id === savedTask.id ? savedTask : entry));
          window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
        }}
        onFeedback={setFeedback}
      />}

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
    return <section className="panel task-empty-state"><div><FolderPlus size={22} /></div><h3>{selectedProject ? `${selectedProject.name} 暂无任务` : "还没有项目任务"}</h3><p>{selectedProject ? "在新建或编辑任务时选择这个项目，任务会显示在这里。" : "在任务详情中选择一个项目，相关行动会自动汇总到这里。"}</p></section>;
  }
  return <div className="task-project-groups">
    {visibleProjects.map((project) => {
      const entries = tasks.filter((task) => task.projectId === project.id);
      return <section className="panel" key={project.id}><header><div><i style={{ background: project.color }} /><Link href={`/projects?project=${encodeURIComponent(project.id)}`}>{project.name}</Link>{project.areaName && <small>{project.areaName}</small>}</div><span>{entries.length}</span></header>{entries.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}</section>;
    })}
    {legacyGroups.map((projectName) => {
      const entries = tasks.filter((task) => !task.projectId && task.projectName === projectName);
      return <section className="panel" key={`legacy:${projectName}`}><header><div><FolderPlus size={15} /><strong>{projectName}</strong><small>旧分组</small></div><span>{entries.length}</span></header>{entries.map((task) => <TaskCard task={task} key={task.id} busy={busyTaskId === task.id} onComplete={() => onComplete(task)} onEdit={() => onEdit(task)} onMenu={(x, y, returnFocus) => onMenu(task, x, y, returnFocus)} />)}</section>;
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
    { key: "important-urgent", title: "立即处理", important: true, urgent: true },
    { key: "important-calm", title: "安排时间", important: true, urgent: false },
    { key: "urgent-light", title: "批量或委托", important: false, urgent: true },
    { key: "calm-light", title: "减少投入", important: false, urgent: false },
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
            <header><h3>{quadrant.title}</h3><span aria-label={`${entries.length} 个任务`}>{entries.length}</span></header>
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
          {task.planItemTitle && <em>计划项：{task.planItemTitle}</em>}
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
  return { title: "", notes: "", status, important: false, urgencyMode: "auto", dueAt: "", estimatedMinutes: "", projectId: "", planItemId: "", projectName: "", areaName: "", assigneeUserId: "", sourceReferences: [] };
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
    planItemId: task.planItemId ?? "",
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
    planItemId: draft.projectId && draft.planItemId ? draft.planItemId : undefined,
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
