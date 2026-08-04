import { listStoredCalendarEvents, listStoredCalendars } from "./calendar-repository";
import { listUnreadInboxSummary } from "./mail-repository";
import { listStoredTodayTasks, type TaskSourceReference } from "./task-repository";
import { listCalendarTaskLinks } from "./task-schedule";

export interface TodayEventItem {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly descriptionContent?: string;
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
  readonly timeZone?: string;
  readonly linkedTask?: { readonly id: string; readonly title: string; readonly href: string };
  readonly deleteDisabledReason?: string;
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
  const referenceTime = new Date();
  const [events, calendars, tasks, unreadInbox] = await Promise.all([
    listStoredCalendarEvents({ from, to, limit: 500 }),
    listStoredCalendars(),
    listStoredTodayTasks(to, referenceTime),
    listUnreadInboxSummary(6),
  ]);
  const fromTime = new Date(from).getTime();
  const toTime = new Date(to).getTime();
  const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const calendarTaskLinks = await listCalendarTaskLinks(events.map((event) => event.id));
  const todayTasks = tasks
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
  const unreadMail = unreadInbox.items
    .map((message): TodayMailItem => ({
      id: message.id,
      subject: message.subject,
      senderName: message.senderName,
      senderAddress: message.senderAddress,
      accountName: message.accountName,
      accountColor: message.accountColor,
      snippet: message.snippet,
      receivedAt: message.receivedAt,
      isStarred: message.isStarred,
      attachmentCount: message.attachmentCount,
      canArchive: message.canArchive,
      href: `/inbox?message=${encodeURIComponent(message.id)}`,
    }));

  return {
    from,
    to,
    events: events.map((event): TodayEventItem => {
      const calendar = calendarById.get(event.calendarId);
      return {
        id: event.id,
        calendarId: event.calendarId,
        title: event.title,
        description: todayEventDescription(event.description),
        descriptionContent: event.descriptionContent,
        location: event.location,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        status: event.status,
        availability: event.availability,
        attendees: event.attendees,
        meetingUrl: event.meetingUrl,
        calendarName: calendar?.name ?? "日历",
        calendarColor: calendar?.color ?? "#86bdf5",
        recurrenceSeriesId: event.recurrenceSeriesId,
        recurrenceId: event.recurrenceId,
        timeZone: event.timeZone,
        linkedTask: calendarTaskLinks.get(event.id),
        deleteDisabledReason: todayEventDeleteDisabledReason(event, calendar),
        href: `/calendar?event=${encodeURIComponent(event.id)}&date=${encodeURIComponent(event.start)}`,
      };
    }),
    tasks: todayTasks,
    unreadMail,
    totals: { events: events.length, tasks: tasks.length, unreadMail: unreadInbox.total },
  };
}

function todayEventDescription(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function todayEventDeleteDisabledReason(
  event: Awaited<ReturnType<typeof listStoredCalendarEvents>>[number],
  calendar: Awaited<ReturnType<typeof listStoredCalendars>>[number] | undefined,
): string | undefined {
  if (calendar?.readOnly) return "只读日历不可删除";
  if (event.providerData?.providerId !== "exchange") return undefined;
  if (!event.providerData.itemId) return "请先同步 Exchange 日历";
  if (event.providerData.isRecurring) return "Exchange 重复日程请在日历详情中处理";
  if (event.providerData.isMeeting) return "含参与者的会议请在日历详情中处理";
  return undefined;
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
