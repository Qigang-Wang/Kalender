import { listStoredCalendarEvents, listStoredCalendars } from "./calendar-repository";
import { listInbox } from "./mail-repository";
import { listStoredTasks, type TaskSourceReference } from "./task-repository";

export interface TodayEventItem {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly calendarName: string;
  readonly calendarColor: string;
  readonly href: string;
}

export interface TodayTaskItem {
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
  readonly sourceReferences: readonly TaskSourceReference[];
  readonly attention: "overdue" | "today" | "urgent";
  readonly href: string;
}

export interface TodayMailItem {
  readonly id: string;
  readonly subject: string;
  readonly senderName: string;
  readonly accountName: string;
  readonly accountColor: string;
  readonly receivedAt: string;
  readonly isStarred: boolean;
  readonly href: string;
}

export interface TodaySnapshot {
  readonly from: string;
  readonly to: string;
  readonly events: readonly TodayEventItem[];
  readonly tasks: readonly TodayTaskItem[];
  readonly unreadMail: readonly TodayMailItem[];
  readonly totals: {
    readonly events: number;
    readonly tasks: number;
    readonly unreadMail: number;
  };
}

export async function getTodaySnapshot(from: string, to: string): Promise<TodaySnapshot> {
  const [events, calendars, tasks, inbox] = await Promise.all([
    listStoredCalendarEvents({ from, to, limit: 500 }),
    listStoredCalendars(),
    listStoredTasks(false),
    listInbox(100),
  ]);
  const fromTime = new Date(from).getTime();
  const toTime = new Date(to).getTime();
  const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const allTodayTasks = tasks
    .filter((task) => {
      const dueTime = task.dueAt ? new Date(task.dueAt).getTime() : undefined;
      return (dueTime !== undefined && dueTime < toTime) || (task.status === "next" && task.isUrgent);
    })
    .sort((left, right) => {
      const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY;
      return leftDue - rightDue || Number(right.important) - Number(left.important);
    });
  const todayTasks = allTodayTasks
    .slice(0, 8)
    .map((task): TodayTaskItem => {
      const dueTime = task.dueAt ? new Date(task.dueAt).getTime() : undefined;
      return {
        id: task.id,
        title: task.title,
        notes: task.notes,
        status: task.status as TodayTaskItem["status"],
        important: task.important,
        urgencyMode: task.urgencyMode,
        isUrgent: task.isUrgent,
        dueAt: task.dueAt,
        estimatedMinutes: task.estimatedMinutes,
        projectName: task.projectName,
        areaName: task.areaName,
        sourceReferences: task.sourceReferences,
        attention: dueTime !== undefined && dueTime < fromTime ? "overdue" : dueTime !== undefined && dueTime < toTime ? "today" : "urgent",
        href: `/tasks?task=${encodeURIComponent(task.id)}`,
      };
    });
  const allUnreadMail = inbox
    .filter((message) => !message.isRead)
    .sort((left, right) => Number(right.isStarred) - Number(left.isStarred) || new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime());
  const unreadMail = allUnreadMail
    .slice(0, 6)
    .map((message): TodayMailItem => ({
      id: message.id,
      subject: message.subject,
      senderName: message.senderName,
      accountName: message.accountName,
      accountColor: message.accountColor,
      receivedAt: message.receivedAt,
      isStarred: message.isStarred,
      href: `/inbox?message=${encodeURIComponent(message.id)}`,
    }));

  return {
    from,
    to,
    events: events.map((event): TodayEventItem => {
      const calendar = calendarById.get(event.calendarId);
      return {
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        calendarName: calendar?.name ?? "日历",
        calendarColor: calendar?.color ?? "#86bdf5",
        href: `/calendar?event=${encodeURIComponent(event.id)}&date=${encodeURIComponent(event.start)}`,
      };
    }),
    tasks: todayTasks,
    unreadMail,
    totals: { events: events.length, tasks: allTodayTasks.length, unreadMail: allUnreadMail.length },
  };
}

export function parseTodayRange(url: URL): { readonly from: string; readonly to: string } {
  const from = new Date(url.searchParams.get("from") ?? "");
  const to = new Date(url.searchParams.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new TodayRangeError("Today 时间范围无效");
  if (to.getTime() - from.getTime() > 48 * 60 * 60 * 1000) throw new TodayRangeError("Today 时间范围不能超过 48 小时");
  return { from: from.toISOString(), to: to.toISOString() };
}

export class TodayRangeError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "TodayRangeError";
  }
}
