"use client";

import Link from "next/link";
import { AlertCircle, CalendarDays, Check, CheckCircle2, Clock3, ListChecks, LoaderCircle, Mail, Star } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { TransientToast } from "../workspace-shared";

interface TodayEventItem {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly calendarName: string;
  readonly calendarColor: string;
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
  readonly accountName: string;
  readonly accountColor: string;
  readonly receivedAt: string;
  readonly isStarred: boolean;
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

export function TodayPage() {
  const [snapshot, setSnapshot] = useState<TodaySnapshot>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [busyTaskId, setBusyTaskId] = useState<string>();
  const [feedback, setFeedback] = useState<string>();

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
      setFeedback("任务已完成");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法完成任务");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  if (state === "loading") return <div className="today-loading panel"><LoaderCircle className="spin" size={19} />正在汇总今天的数据…</div>;
  if (state === "error" || !snapshot) return <div className="today-loading panel"><AlertCircle size={19} /><span>{feedback ?? "无法读取 Today 数据"}</span><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重试</button></div>;

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
          {snapshot.events.length ? <div className="timeline">{snapshot.events.map((event) => <TimelineEvent event={event} key={event.id} />)}</div>
            : <TodayEmpty icon={<CalendarDays size={20} />} text="今天没有日程安排" />}
        </section>
        <div className="today-side">
          <section className="panel compact-panel">
            <h2><ListChecks size={19} />需要推进 <small>{snapshot.totals.tasks}</small></h2>
            {snapshot.tasks.length ? snapshot.tasks.map((task) => <TaskRow task={task} busy={busyTaskId === task.id} onComplete={() => void completeTask(task)} key={task.id} />)
              : <TodayEmpty icon={<CheckCircle2 size={20} />} text="今天没有到期或紧急任务" />}
          </section>
          <section className="panel reply-panel">
            <h2><Mail size={18} />未读邮件 <small>{snapshot.totals.unreadMail}</small></h2>
            {snapshot.unreadMail.length ? <div className="today-mail-list">{snapshot.unreadMail.map((message) => <Link href={message.href} key={message.id}>
              <i style={{ background: message.accountColor }} />
              <span><strong>{message.subject}</strong><small>{message.senderName} · {message.accountName}</small></span>
              {message.isStarred ? <Star size={13} fill="currentColor" /> : <time>{formatTodayMailTime(message.receivedAt)}</time>}
            </Link>)}</div> : <TodayEmpty icon={<Mail size={20} />} text="收件箱没有未读邮件" />}
          </section>
        </div>
      </div>
    </>
  );
}

function TimelineEvent({ event }: { readonly event: TodayEventItem }) {
  return (
    <div className="timeline-row">
      <time>{event.allDay ? "全天" : formatTodayClock(event.start)}</time>
      <Link className="event-card event-blue" href={event.href}>
        <div><strong>{event.title}</strong><span>{event.calendarName} · {formatTodayEventDuration(event)}</span></div>
        <i className="event-dot" style={{ background: event.calendarColor }} />
      </Link>
    </div>
  );
}

function TaskRow({ task, busy, onComplete }: { readonly task: TodayTaskItem; readonly busy: boolean; readonly onComplete: () => void }) {
  return (
    <div className="task-row">
      <button className="checkbox" aria-label={`完成 ${task.title}`} disabled={busy} onClick={onComplete}>{busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}</button>
      <Link href={task.href}><strong>{task.title}</strong><span>{todayTaskAttentionLabel(task)}{task.projectName ? ` · ${task.projectName}` : ""}</span></Link>
      <b>{task.dueAt ? formatTodayTaskDue(task.dueAt) : "紧急"}</b>
    </div>
  );
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

function formatTodayEventDuration(event: TodayEventItem): string {
  if (event.allDay) return "全天";
  const minutes = Math.max(0, Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000));
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
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

function formatTodayMailTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? formatTodayClock(value)
    : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}
