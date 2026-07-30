"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronUp, Clock3, Link2, ListChecks, LoaderCircle, Mail, MapPin, Paperclip, Star, Users } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { appConfirm } from "@/components/app-dialog-provider";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { ContextMenu } from "../context-menu";
import { resolveContextCommands, type CalendarEventCommandId, type MailMessageCommandId, type TaskCommandId } from "../context-commands";
import { TransientToast } from "../workspace-shared";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";

interface TodayEventItem {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly availability?: "free" | "tentative" | "busy" | "oof" | "working_elsewhere";
  readonly attendees: readonly { readonly address: string; readonly name?: string }[];
  readonly meetingUrl?: string;
  readonly calendarName: string;
  readonly calendarColor: string;
  readonly recurrenceSeriesId?: string;
  readonly recurrenceId?: string;
  readonly deleteDisabledReason?: string;
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
  readonly senderAddress: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly snippet: string;
  readonly receivedAt: string;
  readonly isStarred: boolean;
  readonly attachmentCount: number;
  readonly canArchive: boolean;
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

interface TodayContextMenuState {
  readonly kind: "event" | "task" | "mail";
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

type TodayMailAction = "mark-read" | "star" | "unstar" | "archive" | "delete";

export function TodayPage() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<TodaySnapshot>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [busyTaskId, setBusyTaskId] = useState<string>();
  const [busyEventId, setBusyEventId] = useState<string>();
  const [busyMailId, setBusyMailId] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [contextMenu, setContextMenu] = useState<TodayContextMenuState>();

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
      window.dispatchEvent(new Event("kalender:tasks-changed"));
      setFeedback("任务已完成");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法完成任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const deleteTask = async (task: TodayTaskItem) => {
    if (busyTaskId) return;
    if (!await appConfirm({
      title: `删除任务“${task.title}”？`,
      description: "任务及其日历时间块将被永久删除，此操作无法撤销。",
      confirmLabel: "删除任务",
      tone: "danger",
    })) return;
    setBusyTaskId(task.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除任务");
      setSnapshot((current) => current ? {
        ...current,
        tasks: current.tasks.filter((entry) => entry.id !== task.id),
        totals: { ...current.totals, tasks: Math.max(0, current.totals.tasks - 1) },
      } : current);
      window.dispatchEvent(new Event("kalender:tasks-changed"));
      setFeedback("任务已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const deleteEvent = async (event: TodayEventItem) => {
    if (busyEventId) return;
    if (event.deleteDisabledReason) {
      setFeedback(event.deleteDisabledReason);
      return;
    }
    if (!await appConfirm({
      title: `删除日程“${event.title}”？`,
      description: event.recurrenceSeriesId && event.recurrenceId
        ? "只删除今天这一次日程，此操作无法撤销。"
        : "该日程将被永久删除，此操作无法撤销。",
      confirmLabel: "删除日程",
      tone: "danger",
    })) return;
    setBusyEventId(event.id);
    try {
      const params = new URLSearchParams({ calendarId: event.calendarId });
      if (event.recurrenceSeriesId && event.recurrenceId) {
        params.set("recurrenceSeriesId", event.recurrenceSeriesId);
        params.set("recurrenceId", event.recurrenceId);
        params.set("scope", "occurrence");
      }
      const response = await fetch(`/api/calendar-events/${encodeURIComponent(event.id)}?${params}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除日程");
      setSnapshot((current) => current ? {
        ...current,
        events: current.events.filter((entry) => entry.id !== event.id),
        totals: { ...current.totals, events: Math.max(0, current.totals.events - 1) },
      } : current);
      setFeedback("日程已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除日程");
    } finally {
      setBusyEventId(undefined);
    }
  };

  const runMailAction = async (message: TodayMailItem, action: TodayMailAction) => {
    if (busyMailId) return;
    if (action === "delete" && !await appConfirm({
      title: `删除邮件“${message.subject}”？`,
      description: "邮件将移至邮箱的已删除邮件文件夹。",
      confirmLabel: "删除邮件",
      tone: "danger",
    })) return;
    setBusyMailId(message.id);
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(message.id)}/actions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => ({})) as {
        readonly message?: string;
        readonly result?: {
          readonly isStarred?: boolean;
          readonly removedFromInbox: boolean;
          readonly alreadyRemoved?: boolean;
        };
      };
      if (!response.ok || !payload.result) throw new Error(payload.message ?? "邮件操作失败");
      const leavesUnreadList = action === "mark-read" || payload.result.removedFromInbox;
      setSnapshot((current) => current ? {
        ...current,
        unreadMail: leavesUnreadList
          ? current.unreadMail.filter((entry) => entry.id !== message.id)
          : current.unreadMail.map((entry) => entry.id === message.id
            ? { ...entry, isStarred: payload.result?.isStarred ?? entry.isStarred }
            : entry),
        totals: leavesUnreadList
          ? { ...current.totals, unreadMail: Math.max(0, current.totals.unreadMail - 1) }
          : current.totals,
      } : current);
      setFeedback(
        action === "mark-read" ? "邮件已标为已读"
          : action === "archive" ? "邮件已归档"
          : action === "delete" ? payload.result.alreadyRemoved ? "本地邮件记录已清理" : "邮件已移至已删除邮件"
          : action === "star" ? "邮件已添加星标" : "邮件已取消星标",
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "邮件操作失败");
    } finally {
      setBusyMailId(undefined);
    }
  };

  const openContextMenu = (
    kind: TodayContextMenuState["kind"],
    id: string,
    x: number,
    y: number,
    returnFocus?: HTMLElement | null,
  ) => setContextMenu({ kind, id, x, y, returnFocus });

  if (state === "loading") return <div className="today-loading panel"><LoaderCircle className="spin" size={19} />正在汇总今天的数据…</div>;
  if (state === "error" || !snapshot) return <div className="today-loading panel"><AlertCircle size={19} /><span>{feedback ?? "无法读取 Today 数据"}</span><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重试</button></div>;

  const contextEvent = contextMenu?.kind === "event" ? snapshot.events.find((event) => event.id === contextMenu.id) : undefined;
  const contextTask = contextMenu?.kind === "task" ? snapshot.tasks.find((task) => task.id === contextMenu.id) : undefined;
  const contextMail = contextMenu?.kind === "mail" ? snapshot.unreadMail.find((message) => message.id === contextMenu.id) : undefined;

  return (
    <>
      <div className="today-summary-strip">
        <time>{formatTodayDate(snapshot.from)}</time>
        <span><CalendarDays size={14} />{snapshot.totals.events} 项日程</span>
        <span><ListChecks size={14} />{snapshot.totals.tasks} 项需推进</span>
        <span><Mail size={14} />{snapshot.totals.unreadMail} 封未读</span>
      </div>
      {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
      <div className="today-layout">
        <section className="panel schedule-panel">
          <h2><Clock3 size={19} />今日安排 <small>{snapshot.events.length}</small></h2>
          {snapshot.events.length ? <TodayTimeline events={snapshot.events} dayStartValue={snapshot.from} onOpenMenu={(event, x, y, returnFocus) => openContextMenu("event", event.id, x, y, returnFocus)} />
            : <TodayEmpty icon={<CalendarDays size={20} />} text="今天没有日程安排" />}
        </section>
        <div className="today-side">
          <section className="panel compact-panel">
            <h2><ListChecks size={19} />需要推进 <small>{snapshot.totals.tasks}</small></h2>
            {snapshot.tasks.length ? snapshot.tasks.map((task) => <TaskRow task={task} busy={busyTaskId === task.id} onComplete={() => void completeTask(task)} onOpenMenu={(x, y, returnFocus) => openContextMenu("task", task.id, x, y, returnFocus)} key={task.id} />)
              : <TodayEmpty icon={<CheckCircle2 size={20} />} text="今天没有到期或紧急任务" />}
          </section>
          <section className="panel reply-panel">
            <h2><Mail size={18} />未读邮件 <small>{snapshot.totals.unreadMail}</small></h2>
            {snapshot.unreadMail.length ? <div className="today-mail-list">{snapshot.unreadMail.map((message) => <TodayMailRow
              message={message}
              onOpenMenu={(x, y, returnFocus) => openContextMenu("mail", message.id, x, y, returnFocus)}
              key={message.id}
            />)}</div> : <TodayEmpty icon={<Mail size={20} />} text="收件箱没有未读邮件" />}
          </section>
        </div>
      </div>
      {contextMenu && contextEvent && <ContextMenu
        anchor={{ x: contextMenu.x, y: contextMenu.y }}
        ariaLabel="今日日程操作"
        commands={resolveContextCommands({
          kind: "calendar-event",
          id: contextEvent.id,
          title: contextEvent.title,
          busy: busyEventId === contextEvent.id,
          hasLinkedTask: false,
          readOnly: false,
          writeDisabledReason: contextEvent.deleteDisabledReason,
          hasWritableCalendar: true,
        }).filter((command) => command.id === "calendar.open" || command.id === "calendar.delete")}
        heading={contextEvent.title}
        returnFocus={contextMenu.returnFocus}
        testId="today-event-context-menu"
        onClose={() => setContextMenu(undefined)}
        onSelect={(commandId) => {
          if ((commandId as CalendarEventCommandId) === "calendar.open") router.push(contextEvent.href);
          if ((commandId as CalendarEventCommandId) === "calendar.delete") void deleteEvent(contextEvent);
        }}
      />}
      {contextMenu && contextTask && <ContextMenu
        anchor={{ x: contextMenu.x, y: contextMenu.y }}
        ariaLabel="今日任务操作"
        commands={resolveContextCommands({
          kind: "task",
          id: contextTask.id,
          title: contextTask.title,
          busy: busyTaskId === contextTask.id,
          important: contextTask.important,
          urgent: contextTask.isUrgent,
          waiting: contextTask.status === "waiting",
          hasMailSource: contextTask.sourceReferences.some((source) => source.kind === "mail"),
        }).filter((command) => command.id === "task.complete" || command.id === "task.edit" || command.id === "task.delete")}
        heading={contextTask.title}
        returnFocus={contextMenu.returnFocus}
        testId="today-task-context-menu"
        onClose={() => setContextMenu(undefined)}
        onSelect={(commandId) => {
          const taskCommand = commandId as TaskCommandId;
          if (taskCommand === "task.complete") void completeTask(contextTask);
          if (taskCommand === "task.edit") router.push(contextTask.href);
          if (taskCommand === "task.delete") void deleteTask(contextTask);
        }}
      />}
      {contextMenu && contextMail && <ContextMenu
        anchor={{ x: contextMenu.x, y: contextMenu.y }}
        ariaLabel="今日邮件操作"
        commands={resolveContextCommands({
          kind: "mail-message",
          id: contextMail.id,
          subject: contextMail.subject,
          connected: true,
          busy: busyMailId === contextMail.id,
          isRead: false,
          isStarred: contextMail.isStarred,
          canArchive: contextMail.canArchive,
        }).filter((command) => (
          command.id === "mail.toggle-read"
          || command.id === "mail.toggle-star"
          || command.id === "mail.archive"
          || command.id === "mail.delete"
        ))}
        heading={contextMail.subject}
        returnFocus={contextMenu.returnFocus}
        testId="today-mail-context-menu"
        onClose={() => setContextMenu(undefined)}
        onSelect={(commandId) => {
          const mailCommand = commandId as MailMessageCommandId;
          if (mailCommand === "mail.toggle-read") void runMailAction(contextMail, "mark-read");
          if (mailCommand === "mail.toggle-star") void runMailAction(contextMail, contextMail.isStarred ? "unstar" : "star");
          if (mailCommand === "mail.archive") void runMailAction(contextMail, "archive");
          if (mailCommand === "mail.delete") void runMailAction(contextMail, "delete");
        }}
      />}
    </>
  );
}

interface LaidOutTodayEvent {
  readonly event: TodayEventItem;
  readonly top: number;
  readonly height: number;
  readonly column: number;
  readonly columns: number;
}

const TODAY_TIMELINE_HOUR_HEIGHT = 56;
const TODAY_TIMELINE_MIN_EVENT_HEIGHT = 30;

function TodayTimeline({
  events,
  dayStartValue,
  onOpenMenu,
}: {
  readonly events: readonly TodayEventItem[];
  readonly dayStartValue: string;
  readonly onOpenMenu: (event: TodayEventItem, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const dayStart = new Date(dayStartValue);
  const timedEvents = events.filter((event) => !event.allDay);
  const allDayEvents = events.filter((event) => event.allDay);
  const eventMinutes = timedEvents.flatMap((event) => [
    minutesSince(dayStart, event.start),
    minutesSince(dayStart, event.end),
  ]);
  const now = new Date();
  const isToday = now.toDateString() === dayStart.toDateString();
  const nowMinutes = isToday ? minutesSince(dayStart, now.toISOString()) : undefined;
  const startHour = Math.max(0, Math.min(8, Math.floor(Math.min(...(eventMinutes.length ? eventMinutes : [8 * 60])) / 60)));
  const endHour = Math.min(24, Math.max(
    18,
    Math.ceil(Math.max(...(eventMinutes.length ? eventMinutes : [18 * 60])) / 60),
    nowMinutes === undefined ? 0 : Math.ceil(nowMinutes / 60),
    startHour + 1,
  ));
  const rangeStartMinutes = startHour * 60;
  const rangeEndMinutes = endHour * 60;
  const timelineHeight = (endHour - startHour) * TODAY_TIMELINE_HOUR_HEIGHT;
  const laidOutEvents = layoutTodayEvents(timedEvents, dayStart, rangeStartMinutes, rangeEndMinutes);
  const hourMarks = Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index);
  const nowTop = nowMinutes !== undefined && nowMinutes >= rangeStartMinutes && nowMinutes <= rangeEndMinutes
    ? ((nowMinutes - rangeStartMinutes) / 60) * TODAY_TIMELINE_HOUR_HEIGHT
    : undefined;

  return (
    <div className="today-timeline">
      {allDayEvents.length > 0 && <div className="today-all-day-lane">
        <span>全天</span>
        <div>{allDayEvents.map((event) => <TodayEventLink className="today-all-day-event" event={event} key={event.id} onOpenMenu={onOpenMenu} />)}</div>
      </div>}
      <div className="today-time-grid" style={{ height: timelineHeight }}>
        {hourMarks.map((hour, index) => <div
          className={`today-hour-mark${index === hourMarks.length - 1 ? " end" : ""}`}
          style={{ top: index * TODAY_TIMELINE_HOUR_HEIGHT }}
          key={hour}
        ><time>{String(hour).padStart(2, "0")}:00</time><i /></div>)}
        <div className="today-event-canvas">
          {laidOutEvents.map(({ event, top, height, column, columns }) => {
            const width = 100 / columns;
            return <TodayEventLink
              className={`today-timeline-event${height < 44 ? " compact" : ""}`}
              event={event}
              style={{
                top,
                height,
                left: `${column * width}%`,
                width: `calc(${width}% - 5px)`,
                borderLeftColor: event.calendarColor,
              }}
              onOpenMenu={onOpenMenu}
              key={event.id}
            />;
          })}
          {nowTop !== undefined && <div className="today-now-line" style={{ top: nowTop }}><i /><time>{formatTodayClock(now.toISOString())}</time></div>}
        </div>
      </div>
    </div>
  );
}

function TodayEventLink({
  event,
  className,
  style,
  onOpenMenu,
}: {
  readonly event: TodayEventItem;
  readonly className: string;
  readonly style?: CSSProperties;
  readonly onOpenMenu: (event: TodayEventItem, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = Boolean(event.description && event.description.length > 180) || event.attendees.length > 3;
  return <HoverCard openDelay={260} closeDelay={100} onOpenChange={(open) => { if (!open) setExpanded(false); }}>
    <HoverCardTrigger asChild>
      <Link
        className={`${className}${event.availability === "oof" ? " calendar-availability-oof" : ""}`}
        href={event.href}
        style={style}
        onContextMenu={(contextEvent) => {
          contextEvent.preventDefault();
          onOpenMenu(event, contextEvent.clientX, contextEvent.clientY, contextEvent.currentTarget);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== "ContextMenu" && !(keyEvent.shiftKey && keyEvent.key === "F10")) return;
          keyEvent.preventDefault();
          const bounds = keyEvent.currentTarget.getBoundingClientRect();
          onOpenMenu(event, bounds.right - 8, bounds.top + 24, keyEvent.currentTarget);
        }}
      >
        <span className="today-event-time">{event.allDay ? "全天" : formatTodayEventClockRange(event)}</span>
        <strong>{event.title}</strong>
        <small>{event.calendarName}{event.location ? ` · ${event.location}` : ""}</small>
      </Link>
    </HoverCardTrigger>
    <HoverCardContent className="today-event-hover-card" align="start" side="right" sideOffset={8} collisionPadding={12}>
      <header>
        <span><i style={{ background: event.calendarColor }} />{event.calendarName}</span>
        {(event.availability === "oof" || event.status !== "confirmed") && <em>{event.availability === "oof" ? "外出" : event.status === "tentative" ? "暂定" : "已取消"}</em>}
      </header>
      <strong>{event.title}</strong>
      <div className="today-event-hover-meta">
        <span><Clock3 size={14} />{formatTodayEventRange(event)} · {formatTodayEventDuration(event)}</span>
        {event.location && <span><MapPin size={14} />{event.location}</span>}
        {event.attendees.length > 0 && <span><Users size={14} />{formatTodayAttendees(event.attendees, expanded ? event.attendees.length : 3)}</span>}
        {event.meetingUrl && <span><Link2 size={14} />{formatTodayMeetingHost(event.meetingUrl)}</span>}
      </div>
      {event.description && <p className={expanded ? "expanded" : undefined}>{event.description}</p>}
      {hasMore && <button
        type="button"
        className="today-hover-expand"
        aria-label={expanded ? "收起完整详情" : "展开完整详情"}
        title={expanded ? "收起完整详情" : "展开完整详情"}
        onClick={() => setExpanded((value) => !value)}
      >{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}
    </HoverCardContent>
  </HoverCard>;
}

function layoutTodayEvents(
  events: readonly TodayEventItem[],
  dayStart: Date,
  rangeStartMinutes: number,
  rangeEndMinutes: number,
): readonly LaidOutTodayEvent[] {
  const candidates = events
    .map((event) => ({
      event,
      start: Math.max(rangeStartMinutes, minutesSince(dayStart, event.start)),
      end: Math.min(rangeEndMinutes, minutesSince(dayStart, event.end)),
    }))
    .filter((item) => item.end > rangeStartMinutes && item.start < rangeEndMinutes)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: LaidOutTodayEvent[] = [];
  let group: typeof candidates = [];
  let groupEnd = Number.NEGATIVE_INFINITY;

  const commitGroup = () => {
    if (!group.length) return;
    const columnEnds: number[] = [];
    const assigned = group.map((item) => {
      let column = columnEnds.findIndex((end) => end <= item.start);
      if (column < 0) column = columnEnds.length;
      columnEnds[column] = item.end;
      return { ...item, column };
    });
    const columns = Math.max(1, columnEnds.length);
    for (const item of assigned) {
      result.push({
        event: item.event,
        top: ((item.start - rangeStartMinutes) / 60) * TODAY_TIMELINE_HOUR_HEIGHT,
        height: Math.max(TODAY_TIMELINE_MIN_EVENT_HEIGHT, ((item.end - item.start) / 60) * TODAY_TIMELINE_HOUR_HEIGHT),
        column: item.column,
        columns,
      });
    }
  };

  for (const item of candidates) {
    if (group.length && item.start >= groupEnd) {
      commitGroup();
      group = [];
      groupEnd = Number.NEGATIVE_INFINITY;
    }
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  commitGroup();
  return result;
}

function TaskRow({
  task,
  busy,
  onComplete,
  onOpenMenu,
}: {
  readonly task: TodayTaskItem;
  readonly busy: boolean;
  readonly onComplete: () => void;
  readonly onOpenMenu: (x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = Boolean(task.notes && task.notes.length > 180) || task.sourceReferences.length > 2;
  const visibleSources = expanded ? task.sourceReferences : task.sourceReferences.slice(0, 2);
  return <HoverCard openDelay={260} closeDelay={100} onOpenChange={(open) => { if (!open) setExpanded(false); }}>
    <HoverCardTrigger asChild>
      <div
        className="task-row"
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu(event.clientX, event.clientY, event.currentTarget);
        }}
      >
        <button className="checkbox" aria-label={`完成 ${task.title}`} disabled={busy} onClick={onComplete}>{busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}</button>
        <Link
          href={task.href}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenMenu(bounds.right - 8, bounds.top + 24, event.currentTarget);
          }}
        >
          <strong>{task.title}</strong>
          <span>{todayTaskAttentionLabel(task)}{task.projectName ? ` · ${task.projectName}` : ""}</span>
        </Link>
        <b>{task.dueAt ? formatTodayTaskDue(task.dueAt) : "紧急"}</b>
      </div>
    </HoverCardTrigger>
    <HoverCardContent className="today-event-hover-card today-task-hover-card" align="start" side="left" sideOffset={8} collisionPadding={12}>
      <header>
        <span><ListChecks size={14} />{todayTaskAttentionLabel(task)}</span>
        <em>{task.isUrgent ? "紧急" : todayTaskStatusLabel(task.status)}</em>
      </header>
      <strong>{task.title}</strong>
      <div className="today-event-hover-meta">
        {task.dueAt && <span><Clock3 size={14} />截止：{formatTodayTaskDueDetail(task.dueAt)}</span>}
        {task.estimatedMinutes && <span><Clock3 size={14} />预计：{formatTodayTaskEstimate(task.estimatedMinutes)}</span>}
        {(task.projectName || task.areaName) && <span><Link2 size={14} />{[task.areaName, task.projectName].filter(Boolean).join(" · ")}</span>}
      </div>
      {task.notes && <p className={expanded ? "expanded" : undefined}>{task.notes}</p>}
      {visibleSources.length > 0 && <div className="today-task-hover-sources">
        {visibleSources.map((source) => <span key={source.id}><Link2 size={13} />{source.label}</span>)}
      </div>}
      {hasMore && <button
        type="button"
        className="today-hover-expand"
        aria-label={expanded ? "收起完整详情" : "展开完整详情"}
        title={expanded ? "收起完整详情" : "展开完整详情"}
        onClick={() => setExpanded((value) => !value)}
      >{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}
    </HoverCardContent>
  </HoverCard>;
}

function TodayMailRow({
  message,
  onOpenMenu,
}: {
  readonly message: TodayMailItem;
  readonly onOpenMenu: (x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = message.snippet.length > 180;
  return <HoverCard openDelay={260} closeDelay={100} onOpenChange={(open) => { if (!open) setExpanded(false); }}>
    <HoverCardTrigger asChild>
      <Link
        href={message.href}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu(event.clientX, event.clientY, event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          onOpenMenu(bounds.right - 8, bounds.top + 24, event.currentTarget);
        }}
      >
        <i style={{ background: message.accountColor }} />
        <span><strong>{message.subject}</strong><small>{message.senderName} · {message.accountName}</small></span>
        {message.isStarred ? <Star size={13} fill="currentColor" /> : <time>{formatTodayMailTime(message.receivedAt)}</time>}
      </Link>
    </HoverCardTrigger>
    <HoverCardContent className="today-event-hover-card today-mail-hover-card" align="start" side="left" sideOffset={8} collisionPadding={12}>
      <header>
        <span><i style={{ background: message.accountColor }} />{message.accountName}</span>
        <em>{message.isStarred ? "未读 · 星标" : "未读"}</em>
      </header>
      <strong>{message.subject}</strong>
      <div className="today-event-hover-meta">
        <span><Mail size={14} />{message.senderName} &lt;{message.senderAddress}&gt;</span>
        <span><Clock3 size={14} />{formatTodayMailDateTime(message.receivedAt)}</span>
        {message.attachmentCount > 0 && <span><Paperclip size={14} />{message.attachmentCount} 个附件</span>}
      </div>
      {message.snippet && <p className={expanded ? "expanded" : undefined}>{message.snippet}</p>}
      {hasMore && <button
        type="button"
        className="today-hover-expand"
        aria-label={expanded ? "收起完整详情" : "展开完整详情"}
        title={expanded ? "收起完整详情" : "展开完整详情"}
        onClick={() => setExpanded((value) => !value)}
      >{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}
    </HoverCardContent>
  </HoverCard>;
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

function formatTodayEventClockRange(event: TodayEventItem): string {
  return `${formatTodayClock(event.start)}–${formatTodayClock(event.end)}`;
}

function formatTodayEventRange(event: TodayEventItem): string {
  if (event.allDay) return "全天";
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (start.toDateString() === end.toDateString()) return formatTodayEventClockRange(event);
  const format = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${format.format(start)}–${format.format(end)}`;
}

function formatTodayEventDuration(event: TodayEventItem): string {
  if (event.allDay) return "全天";
  const minutes = Math.max(0, Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000));
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function minutesSince(dayStart: Date, value: string): number {
  return (new Date(value).getTime() - dayStart.getTime()) / 60_000;
}

function formatTodayAttendees(attendees: TodayEventItem["attendees"], limit = 3): string {
  const names = attendees.slice(0, limit).map((attendee) => attendee.name?.trim() || attendee.address);
  const remaining = attendees.length - names.length;
  return remaining > 0 ? `${names.join("、")} 等 ${attendees.length} 人` : names.join("、");
}

function formatTodayMeetingHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "在线会议";
  }
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

function formatTodayTaskDueDetail(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatTodayTaskEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function todayTaskStatusLabel(status: TodayTaskItem["status"]): string {
  if (status === "waiting") return "等待中";
  if (status === "someday") return "以后";
  if (status === "next") return "下一步";
  return "收集箱";
}

function formatTodayMailTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? formatTodayClock(value)
    : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function formatTodayMailDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
