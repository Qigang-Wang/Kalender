"use client";

import Link from "next/link";
import {
  AlertCircle, ArrowRight, CalendarDays, CalendarClock, Check, ChevronDown, ChevronLeft,
  ChevronRight, Circle, Clock3, Folder, Link2, ListChecks, LoaderCircle, Mail,
  MapPin, MoreHorizontal, NotebookPen, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { EMPTY_PLATE_NOTE_CONTENT } from "@/lib/note-content";
import { ContextMenu } from "../context-menu";
import {
  resolveContextCommands,
  type CalendarEventCommandId,
  type CalendarSlotCommandId,
  type ContextCommandId,
} from "../context-commands";
import { TransientToast } from "../workspace-shared";
import {
  createClientEntityLink,
  ProjectAssociationControl,
  RelatedContentPanel,
} from "./related-content";

const TASKS_CHANGED_EVENT = "kalender:tasks-changed";

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
  readonly status: "inbox" | "next" | "waiting" | "someday" | "done";
  readonly important: boolean;
  readonly urgencyMode: "auto" | "urgent" | "not_urgent";
  readonly isUrgent: boolean;
  readonly dueAt?: string;
  readonly estimatedMinutes?: number;
  readonly sourceReferences: readonly ClientTaskSource[];
  readonly scheduledBlocks: readonly ClientTaskTimeBlock[];
}

interface TaskScheduleConflict {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

function formatTaskBlockRange(startValue: string, endValue: string): string {
  const start = new Date(startValue);
  const end = new Date(endValue);
  const sameDay = start.toDateString() === end.toDateString();
  const day = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time.format(start)}–${sameDay ? time.format(end) : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}

function formatTaskEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

interface CalendarListItem {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: { readonly providerId?: string };
}

interface CalendarViewEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone?: string;
  readonly allDay: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly providerData?: {
    readonly providerId?: string;
    readonly itemId?: string;
    readonly changeKey?: string;
    readonly isMeeting?: boolean;
    readonly isRecurring?: boolean;
    readonly isOrganizer?: boolean;
  };
  readonly attendees?: readonly { readonly address: string; readonly name?: string }[];
  readonly meetingUrl?: string;
  readonly linkedTask?: { readonly id: string; readonly title: string; readonly href: string };
}

interface CalendarEventDraft {
  readonly id?: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly timeZone: string;
  readonly allDay: boolean;
  readonly conflicts: readonly TaskScheduleConflict[];
}

type CalendarMenuState =
  | { readonly kind: "event"; readonly eventId: string; readonly x: number; readonly y: number }
  | { readonly kind: "slot"; readonly startsAt: string; readonly x: number; readonly y: number };

interface CalendarEventPreviewState {
  readonly eventId: string;
  readonly x: number;
  readonly y: number;
}

const calendarDayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
type CalendarViewMode = "week" | "month";
type CalendarDialogMode = "view" | "edit";

function calendarEventWriteDisabledReason(event?: CalendarViewEvent, calendar?: CalendarListItem): string | undefined {
  if (calendar?.readOnly) return "这个日历当前为只读";
  if (event?.providerData?.providerId !== "exchange") return undefined;
  if (!event.providerData.itemId) return "请先立即同步 RWTH 日历，再尝试修改";
  if (event.providerData.isRecurring) return "重复日程暂不支持写回，请在 RWTH 网页端处理";
  if (event.providerData.isMeeting) return "含参会人的会议暂不支持写回，避免误发会议通知";
  return undefined;
}

export function CalendarPage({ initialEventId, initialCalendarDate }: { readonly initialEventId?: string; readonly initialCalendarDate?: string }) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [anchorDate, setAnchorDate] = useState(() => {
    const requested = initialCalendarDate ? new Date(initialCalendarDate) : undefined;
    return requested && !Number.isNaN(requested.getTime()) ? requested : new Date();
  });
  const [calendars, setCalendars] = useState<readonly CalendarListItem[]>([]);
  const [events, setEvents] = useState<readonly CalendarViewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<CalendarEventDraft>();
  const [draftMode, setDraftMode] = useState<CalendarDialogMode>("view");
  const [menu, setMenu] = useState<CalendarMenuState>();
  const [eventPreview, setEventPreview] = useState<CalendarEventPreviewState>();
  const [relatedVersion, setRelatedVersion] = useState(0);
  const [calendarTasks, setCalendarTasks] = useState<readonly ClientTask[]>([]);
  const [taskDropBusy, setTaskDropBusy] = useState(false);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const openedInitialEvent = useRef(false);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin", []);
  const writableLocalCalendar = useMemo(() => (
    calendars.find((calendar) => !calendar.readOnly && calendar.primary && calendar.providerData?.providerId === "local-calendar")
      ?? calendars.find((calendar) => !calendar.readOnly && calendar.providerData?.providerId === "local-calendar")
      ?? calendars.find((calendar) => !calendar.readOnly)
  ), [calendars]);
  const visibleRange = useMemo(() => {
    if (viewMode === "week") {
      const start = startOfCalendarWeek(anchorDate);
      return { start, end: addCalendarDays(start, 7) };
    }
    const monthStart = startOfCalendarMonth(anchorDate);
    const start = startOfCalendarWeek(monthStart);
    return { start, end: addCalendarDays(start, 42) };
  }, [anchorDate, viewMode]);

  useEffect(() => {
    const storedView = window.localStorage.getItem("kalender.calendar.view");
    if (storedView === "week" || storedView === "month") setViewMode(storedView);
  }, []);

  useEffect(() => {
    void workspaceFetch("/api/tasks")
      .then(async (response) => {
        const payload = await response.json() as { readonly tasks?: readonly ClientTask[] };
        if (response.ok) setCalendarTasks(payload.tasks ?? []);
      })
      .catch(() => setCalendarTasks([]));
  }, []);

  const changeViewMode = (nextView: CalendarViewMode) => {
    setViewMode(nextView);
    window.localStorage.setItem("kalender.calendar.view", nextView);
  };

  const loadCalendars = useCallback(async () => {
    const response = await workspaceFetch("/api/calendars");
    const payload = await response.json() as { readonly calendars?: readonly CalendarListItem[]; readonly message?: string };
    if (!response.ok || !payload.calendars) throw new Error(payload.message || "无法读取日历");
    setCalendars(payload.calendars);
    return payload.calendars;
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: visibleRange.start.toISOString(), to: visibleRange.end.toISOString() });
    const response = await workspaceFetch(`/api/calendar-events?${params}`, {}, 1_000);
      const payload = await response.json() as { readonly events?: readonly CalendarViewEvent[]; readonly message?: string };
      if (!response.ok || !payload.events) throw new Error(payload.message || "无法读取日程");
      setEvents(payload.events);
      setFeedback("");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取日程");
    } finally {
      setLoading(false);
    }
  }, [visibleRange]);

  useEffect(() => {
    void loadCalendars().catch((error: unknown) => {
      setLoading(false);
      setFeedback(error instanceof Error ? error.message : "无法读取日历");
    });
  }, [loadCalendars]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  const openCreateDraft = useCallback((start = nextCalendarHour(new Date()), title = "") => {
    const calendarId = writableLocalCalendar?.id;
    if (!calendarId) {
      setFeedback("本地日历尚未准备好，请稍后再试");
      return;
    }
    setMenu(undefined);
    setEventPreview(undefined);
    setDraftMode("edit");
    setDraft({
      calendarId,
      title,
      description: "",
      location: "",
      startLocal: toLocalDateTimeInput(start),
      endLocal: toLocalDateTimeInput(new Date(start.getTime() + 30 * 60 * 1000)),
      timeZone,
      allDay: false,
      conflicts: [],
    });
  }, [timeZone, writableLocalCalendar]);

  const openEditDraft = useCallback((event: CalendarViewEvent, mode: CalendarDialogMode = "view") => {
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    const inclusiveAllDayEnd = event.allDay ? addCalendarDays(eventEnd, -1) : eventEnd;
    setMenu(undefined);
    setEventPreview(undefined);
    setDraftMode(mode);
    setDraft({
      id: event.id,
      calendarId: event.calendarId,
      title: event.title,
      description: event.description ?? "",
      location: event.location ?? "",
      startLocal: event.allDay ? toCalendarDateKey(eventStart) : toLocalDateTimeInput(eventStart),
      endLocal: event.allDay ? toCalendarDateKey(inclusiveAllDayEnd) : toLocalDateTimeInput(eventEnd),
      timeZone: event.timeZone ?? timeZone,
      allDay: event.allDay,
      conflicts: [],
    });
  }, [timeZone]);

  const updateCalendarDraft = (changes: Partial<CalendarEventDraft>) => {
    setDraft((current) => current ? { ...current, ...changes, conflicts: [] } : current);
  };

  const changeCalendarAllDay = (allDay: boolean) => {
    if (!draft) return;
    const start = new Date(draft.allDay ? `${draft.startLocal}T09:00` : draft.startLocal);
    const end = new Date(draft.allDay ? `${draft.endLocal}T10:00` : draft.endLocal);
    if (allDay) {
      updateCalendarDraft({
        allDay: true,
        startLocal: Number.isNaN(start.getTime()) ? toCalendarDateKey(new Date()) : toCalendarDateKey(start),
        endLocal: Number.isNaN(end.getTime()) ? toCalendarDateKey(new Date()) : toCalendarDateKey(end),
      });
    } else {
      const timedStart = Number.isNaN(start.getTime()) ? nextCalendarHour(new Date()) : start;
      timedStart.setHours(timedStart.getHours() || 9, 0, 0, 0);
      updateCalendarDraft({
        allDay: false,
        startLocal: toLocalDateTimeInput(timedStart),
        endLocal: toLocalDateTimeInput(new Date(timedStart.getTime() + 30 * 60_000)),
      });
    }
  };

  useEffect(() => {
    if (!initialEventId || openedInitialEvent.current || loading) return;
    const event = events.find((entry) => entry.id === initialEventId);
    openedInitialEvent.current = true;
    if (event) {
      openEditDraft(event);
      setFeedback("已打开任务安排的日程");
    } else {
      setFeedback("关联日程已删除或不在当前时间范围内");
    }
  }, [events, initialEventId, loading, openEditDraft]);

  const saveDraft = async (allowConflicts = false) => {
    if (!draft || busy) return;
    if (calendars.find((calendar) => calendar.id === draft.calendarId)?.readOnly) {
      setFeedback("这是只读日历，不能修改远端日程");
      return;
    }
    if (!draft.title.trim()) {
      setFeedback("请输入日程标题");
      return;
    }
    let start = new Date(draft.allDay ? `${draft.startLocal}T00:00` : draft.startLocal);
    let end = new Date(draft.allDay ? `${draft.endLocal}T00:00` : draft.endLocal);
    if (draft.allDay && !Number.isNaN(end.getTime())) end = addCalendarDays(end, 1);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setFeedback("结束时间必须晚于开始时间");
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch(draft.id ? `/api/calendar-events/${encodeURIComponent(draft.id)}` : "/api/calendar-events", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarId: draft.calendarId,
          title: draft.title.trim(),
          description: draft.description.trim() || undefined,
          location: draft.location.trim() || undefined,
          start: start.toISOString(),
          end: end.toISOString(),
          timeZone: draft.timeZone,
          allDay: draft.allDay,
          allowConflicts,
          idempotencyKey: draft.id ? undefined : `calendar-ui-${globalThis.crypto.randomUUID()}`,
        }),
      });
      const payload = await response.json() as { readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
      if (response.status === 409 && payload.conflicts?.length) {
        setDraft({ ...draft, conflicts: payload.conflicts });
        setFeedback("所选时间与现有日程冲突");
        return;
      }
      if (!response.ok || !payload.event) throw new Error(payload.message || "无法保存日程");
      setDraft(undefined);
      setFeedback(draft.id ? "日程已更新" : "日程已创建");
      await loadEvents();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存日程");
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async (event: CalendarViewEvent) => {
    if (calendars.find((calendar) => calendar.id === event.calendarId)?.readOnly) {
      setMenu(undefined);
      setFeedback("这是只读日历，不能删除远端日程");
      return;
    }
    if (busy || !window.confirm(`删除“${event.title}”？`)) return;
    setMenu(undefined);
    setBusy(true);
    try {
      const response = await fetch(`/api/calendar-events/${encodeURIComponent(event.id)}?calendarId=${encodeURIComponent(event.calendarId)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "无法删除日程");
      setDraft(undefined);
      setFeedback("日程已删除");
      await loadEvents();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除日程");
    } finally {
      setBusy(false);
    }
  };

  const duplicateEvent = (event: CalendarViewEvent) => {
    const targetCalendar = writableLocalCalendar;
    if (!targetCalendar) {
      setMenu(undefined);
      setFeedback("没有可写的个人日历，暂时无法复制日程");
      return;
    }
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    setMenu(undefined);
    setEventPreview(undefined);
    setDraftMode("edit");
    setDraft({
      calendarId: targetCalendar.id,
      title: `${event.title}（副本）`,
      description: event.description ?? "",
      location: event.location ?? "",
      startLocal: event.allDay ? toCalendarDateKey(eventStart) : toLocalDateTimeInput(eventStart),
      endLocal: event.allDay ? toCalendarDateKey(addCalendarDays(eventEnd, -1)) : toLocalDateTimeInput(eventEnd),
      timeZone: event.timeZone ?? timeZone,
      allDay: event.allDay,
      conflicts: [],
    });
  };

  const createMeetingNote = async (event: CalendarViewEvent) => {
    if (busy) return;
    setMenu(undefined);
    setBusy(true);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `会议笔记：${event.title}`.slice(0, 240),
          content: EMPTY_PLATE_NOTE_CONTENT,
          noteType: "meeting",
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly note?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建会议笔记");
      try {
        await createClientEntityLink({ sourceKind: "calendar", sourceId: event.id, targetKind: "note", targetId: payload.note.id, relation: "meeting-note" });
      } catch (error) {
        await fetch(`/api/notes/${encodeURIComponent(payload.note.id)}`, { method: "DELETE" });
        throw error;
      }
      setRelatedVersion((current) => current + 1);
      openEditDraft(event);
      setFeedback("会议笔记已创建，可从相关内容打开");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建会议笔记");
    } finally {
      setBusy(false);
    }
  };

  const createEventTask = async (event: CalendarViewEvent, kind: "preparation" | "follow-up") => {
    if (busy) return;
    setMenu(undefined);
    setBusy(true);
    const prefix = kind === "preparation" ? "准备" : "跟进";
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${prefix}：${event.title}`.slice(0, 240),
          notes: `关联日程：${event.title}`,
          status: kind === "preparation" ? "next" : "inbox",
          important: false,
          urgencyMode: "auto",
          dueAt: kind === "preparation" ? event.start : undefined,
          estimatedMinutes: kind === "preparation" ? 30 : undefined,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? `无法创建${prefix}任务`);
      try {
        await createClientEntityLink({ sourceKind: "calendar", sourceId: event.id, targetKind: "task", targetId: payload.task.id, relation: kind });
      } catch (error) {
        await fetch(`/api/tasks/${encodeURIComponent(payload.task.id)}`, { method: "DELETE" });
        throw error;
      }
      setRelatedVersion((current) => current + 1);
      openEditDraft(event);
      setFeedback(`${prefix}任务已创建，可从相关内容打开`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : `无法创建${prefix}任务`);
    } finally {
      setBusy(false);
    }
  };

  const contextEvent = menu?.kind === "event" ? events.find((event) => event.id === menu.eventId) : undefined;
  const contextCalendar = contextEvent ? calendars.find((calendar) => calendar.id === contextEvent.calendarId) : undefined;
  const contextWriteDisabledReason = calendarEventWriteDisabledReason(contextEvent, contextCalendar);
  const contextCommands = menu?.kind === "event" && contextEvent
    ? resolveContextCommands({
        kind: "calendar-event",
        id: contextEvent.id,
        title: contextEvent.title,
        busy,
        hasLinkedTask: Boolean(contextEvent.linkedTask),
        readOnly: Boolean(contextCalendar?.readOnly),
        writeDisabledReason: contextWriteDisabledReason,
        hasWritableCalendar: Boolean(writableLocalCalendar),
      })
    : menu?.kind === "slot"
      ? resolveContextCommands({ kind: "calendar-slot", startsAt: menu.startsAt, busy })
      : [];

  const handleContextCommand = (commandId: ContextCommandId) => {
    if (menu?.kind === "event" && contextEvent) {
      const eventCommand = commandId as CalendarEventCommandId;
      if (eventCommand === "calendar.open") openEditDraft(contextEvent, "view");
      if (eventCommand === "calendar.edit") openEditDraft(contextEvent, "edit");
      if (eventCommand === "calendar.open-task" && contextEvent.linkedTask) window.location.assign(contextEvent.linkedTask.href);
      if (eventCommand === "calendar.duplicate") duplicateEvent(contextEvent);
      if (eventCommand === "calendar.create-note") void createMeetingNote(contextEvent);
      if (eventCommand === "calendar.create-prep-task") void createEventTask(contextEvent, "preparation");
      if (eventCommand === "calendar.create-followup-task") void createEventTask(contextEvent, "follow-up");
      if (eventCommand === "calendar.delete") void deleteEvent(contextEvent);
      return;
    }
    if (menu?.kind === "slot") {
      const slotCommand = commandId as CalendarSlotCommandId;
      const start = new Date(menu.startsAt);
      if (slotCommand === "calendar.create-event") openCreateDraft(start);
      if (slotCommand === "calendar.create-focus") openCreateDraft(start, "专注时间");
    }
  };

  const scheduleDroppedTask = async (taskId: string, start: Date) => {
    if (taskDropBusy) return;
    const task = calendarTasks.find((item) => item.id === taskId);
    const calendar = calendars.find((item) => !item.readOnly && item.primary && item.providerData?.providerId === "local-calendar")
      ?? calendars.find((item) => !item.readOnly && item.providerData?.providerId === "local-calendar");
    if (!task || !calendar) {
      setFeedback("没有找到任务或可写的本地日历");
      return;
    }
    const end = new Date(start.getTime() + (task.estimatedMinutes ?? 60) * 60_000);
    setTaskDropBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarId: calendar.id, start: start.toISOString(), end: end.toISOString(), timeZone, allowConflicts: false }),
      });
      const payload = await response.json() as { readonly task?: ClientTask; readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
      if (response.status === 409 && payload.conflicts?.length) throw new Error("这个时间已有日程，请换一个空闲位置或从任务详情确认冲突");
      if (!response.ok || !payload.task || !payload.event) throw new Error(payload.message ?? "无法安排任务");
      setCalendarTasks((current) => current.map((item) => item.id === payload.task!.id ? payload.task! : item));
      setEvents((current) => [...current.filter((item) => item.id !== payload.event!.id), payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(`已安排“${task.title}”`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法安排任务");
    } finally {
      setTaskDropBusy(false);
    }
  };

  const moveTaskTimeBlock = async (event: CalendarViewEvent, start: Date) => {
    if (taskDropBusy || !event.linkedTask) return;
    const duration = Math.max(5 * 60_000, new Date(event.end).getTime() - new Date(event.start).getTime());
    const end = new Date(start.getTime() + duration);
    setTaskDropBusy(true);
    try {
      const requestMove = async (allowConflicts: boolean) => {
        const response = await fetch(`/api/tasks/${encodeURIComponent(event.linkedTask!.id)}/schedule/${encodeURIComponent(event.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calendarId: event.calendarId, start: start.toISOString(), end: end.toISOString(), timeZone, allowConflicts }),
        });
        const payload = await response.json() as { readonly task?: ClientTask; readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
        return { response, payload };
      };
      let result = await requestMove(false);
      if (result.response.status === 409 && result.payload.conflicts?.length) {
        const conflictNames = result.payload.conflicts.slice(0, 3).map((conflict) => `“${conflict.title}”`).join("、");
        if (!window.confirm(`新时间与 ${conflictNames} 冲突，仍然移动吗？`)) {
          setFeedback("已取消移动时间块");
          return;
        }
        result = await requestMove(true);
      }
      if (!result.response.ok || !result.payload.task || !result.payload.event) throw new Error(result.payload.message ?? "无法调整时间块");
      setCalendarTasks((current) => current.map((item) => item.id === result.payload.task!.id ? result.payload.task! : item));
      setEvents((current) => [...current.filter((item) => item.id !== result.payload.event!.id), result.payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(`已重新安排“${result.payload.task.title}”`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法调整时间块");
    } finally {
      setTaskDropBusy(false);
    }
  };

  const unscheduledTasks = calendarTasks.filter((task) => task.status !== "done" && task.scheduledBlocks.length === 0).slice(0, 8);
  const previewEvent = eventPreview ? events.find((event) => event.id === eventPreview.eventId) : undefined;
  const previewCalendar = previewEvent ? calendars.find((calendar) => calendar.id === previewEvent.calendarId) : undefined;
  const draftCalendar = draft ? calendars.find((calendar) => calendar.id === draft.calendarId) : undefined;
  const draftEvent = draft?.id ? events.find((event) => event.id === draft.id) : undefined;
  const draftWriteDisabledReason = draft?.id ? calendarEventWriteDisabledReason(draftEvent, draftCalendar) : undefined;
  const draftReadOnly = Boolean(draftWriteDisabledReason);
  const draftEditing = Boolean(draft && (!draft.id || draftMode === "edit"));

  const showEventPreview = useCallback((event: CalendarViewEvent, anchor: HTMLElement) => {
    const bounds = anchor.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    const x = bounds.right + 10 + width <= window.innerWidth - 8
      ? bounds.right + 10
      : Math.max(8, bounds.left - width - 10);
    const y = Math.max(8, Math.min(bounds.top, window.innerHeight - 250));
    setEventPreview({ eventId: event.id, x, y });
  }, []);

  return (
    <>
      <section className="calendar-shell">
        <div className="calendar-toolbar">
          <div className="calendar-navigation">
            <button className="secondary-button" aria-label={viewMode === "week" ? "上一周" : "上个月"} onClick={() => setAnchorDate(moveCalendarPeriod(anchorDate, viewMode, -1))}>‹</button>
            <button className="secondary-button" onClick={() => setAnchorDate(new Date())}>今天</button>
            <button className="secondary-button" aria-label={viewMode === "week" ? "下一周" : "下个月"} onClick={() => setAnchorDate(moveCalendarPeriod(anchorDate, viewMode, 1))}>›</button>
          </div>
          <strong>{viewMode === "week" ? formatCalendarWeekRange(visibleRange.start, visibleRange.end) : formatCalendarMonth(anchorDate)}</strong>
          <div className="calendar-toolbar-actions">
            <div className="calendar-view-switch" role="group" aria-label="日历视图">
              <button className={viewMode === "week" ? "active" : ""} aria-pressed={viewMode === "week"} onClick={() => changeViewMode("week")}>周</button>
              <button className={viewMode === "month" ? "active" : ""} aria-pressed={viewMode === "month"} onClick={() => changeViewMode("month")}>月</button>
            </div>
            <button className="primary-button" onClick={() => openCreateDraft()}><Plus size={15} />新建日程</button>
          </div>
        </div>
        <div className="calendar-source-row"><div>{calendars.map((calendar) => <span key={calendar.id}><i style={{ background: calendar.color ?? "#86bdf5" }} />{calendar.name}{calendar.readOnly ? " · 只读" : ""}</span>)}</div><small>{timeZone}</small></div>
        {viewMode === "week" && <section className="calendar-task-shelf" aria-label="待安排任务"><header><div><ListChecks size={15} /><strong>待安排任务</strong></div><small>{taskDropBusy ? "正在安排…" : <><span className="desktop-hint">拖入日历，或点击选择时间</span><span className="mobile-hint">点击任务选择时间</span></>}</small></header><div>{unscheduledTasks.length ? unscheduledTasks.map((task) => <Link href={`/tasks?schedule=${encodeURIComponent(task.id)}`} draggable={!taskDropBusy} key={task.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-kalender-task", task.id); }}><span>{task.title}</span>{task.estimatedMinutes && <em>{formatTaskEstimate(task.estimatedMinutes)}</em>}</Link>) : <span>所有当前任务都已安排</span>}</div></section>}
        {feedback && <TransientToast message={feedback} onClose={() => setFeedback("")} />}
        {viewMode === "week" ? (
          <CalendarWeekView
            calendars={calendars}
            events={events}
            loading={loading}
            weekStart={visibleRange.start}
            onCreate={openCreateDraft}
            onEdit={openEditDraft}
            previewEventId={eventPreview?.eventId}
            onPreviewEvent={showEventPreview}
            onClearEventPreview={() => setEventPreview(undefined)}
            onOpenEventMenu={(event, x, y, returnFocus) => {
              setEventPreview(undefined);
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "event", eventId: event.id, x, y });
            }}
            onOpenSlotMenu={(startsAt, x, y, returnFocus) => {
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "slot", startsAt: startsAt.toISOString(), x, y });
            }}
            onDropTask={(taskId, startsAt) => void scheduleDroppedTask(taskId, startsAt)}
            onMoveTaskBlock={(event, startsAt) => void moveTaskTimeBlock(event, startsAt)}
          />
        ) : (
          <CalendarMonthView
            anchorDate={anchorDate}
            calendars={calendars}
            events={events}
            loading={loading}
            rangeStart={visibleRange.start}
            onCreate={openCreateDraft}
            onEdit={openEditDraft}
            previewEventId={eventPreview?.eventId}
            onPreviewEvent={showEventPreview}
            onClearEventPreview={() => setEventPreview(undefined)}
            onOpenEventMenu={(event, x, y, returnFocus) => {
              setEventPreview(undefined);
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "event", eventId: event.id, x, y });
            }}
            onOpenSlotMenu={(startsAt, x, y, returnFocus) => {
              menuReturnFocusRef.current = returnFocus;
              setMenu({ kind: "slot", startsAt: startsAt.toISOString(), x, y });
            }}
          />
        )}
      </section>

      {eventPreview && previewEvent && (
        <CalendarEventTooltip
          anchor={{ x: eventPreview.x, y: eventPreview.y }}
          calendar={previewCalendar}
          event={previewEvent}
        />
      )}

      {draft && (
        <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDraft(undefined); }}>
          <section className={`calendar-dialog panel calendar-event-dialog ${draftEditing ? "calendar-edit-dialog" : "calendar-detail-dialog"}`} role="dialog" aria-modal="true" aria-labelledby="calendar-dialog-title">
            <header className="calendar-event-dialog-header">
              {draftEditing ? (
                <h2 className="calendar-edit-dialog-title" id="calendar-dialog-title">{draft.id ? "编辑日程" : "新建日程"}</h2>
              ) : (
                <div className="calendar-event-dialog-heading">
                  <span className={`calendar-event-badge ${draftReadOnly ? "protected" : ""}`}>
                    {draftReadOnly ? <ShieldCheck size={14} /> : <CalendarDays size={14} />}
                    {draftReadOnly ? "受保护" : draftCalendar?.name ?? "日程详情"}
                  </span>
                  <h2 id="calendar-dialog-title">{draft.title}</h2>
                </div>
              )}
              <button aria-label="关闭" onClick={() => setDraft(undefined)} disabled={busy && draftEditing}><X size={20} /></button>
            </header>
            {draftEditing ? <>
              <div className="calendar-form calendar-modern-form">
                <label className="calendar-title-field">
                  <i className="calendar-title-dot" aria-hidden="true" style={{ background: draftCalendar?.color ?? "#86bdf5" }} />
                  <input aria-label="日程标题" autoFocus value={draft.title} maxLength={200} placeholder="添加标题" onChange={(event) => updateCalendarDraft({ title: event.target.value })} />
                </label>
                <div className="calendar-schedule-card">
                  <div className="calendar-schedule-row">
                    <span className="calendar-schedule-icon" aria-hidden="true"><CalendarDays size={18} /></span>
                    <label className="calendar-schedule-field">
                      <input aria-label={draft.allDay ? "开始日期" : "开始时间"} type={draft.allDay ? "date" : "datetime-local"} step={draft.allDay ? undefined : 300} value={draft.startLocal} onChange={(event) => updateCalendarDraft({ startLocal: event.target.value })} />
                    </label>
                    <ArrowRight className="calendar-schedule-arrow" size={16} strokeWidth={1.7} aria-hidden="true" />
                    <label className="calendar-schedule-field">
                      <input aria-label={draft.allDay ? "结束日期（含）" : "结束时间"} type={draft.allDay ? "date" : "datetime-local"} step={draft.allDay ? undefined : 300} min={draft.allDay ? draft.startLocal : undefined} value={draft.endLocal} onChange={(event) => updateCalendarDraft({ endLocal: event.target.value })} />
                    </label>
                    <small className="calendar-schedule-duration"><Clock3 size={12} />{formatCalendarDetailDuration(draft)}</small>
                    <label className="calendar-all-day-switch">
                      <span>全天</span>
                      <input aria-label="全天日程" type="checkbox" checked={draft.allDay} onChange={(event) => changeCalendarAllDay(event.target.checked)} />
                      <i aria-hidden="true"><b /></i>
                    </label>
                  </div>
                </div>
                <div className="calendar-edit-meta">
                  <label className="calendar-meta-field">
                    <i className="calendar-meta-dot" aria-hidden="true" style={{ background: draftCalendar?.color ?? "#86bdf5" }} />
                    <select aria-label="日历" disabled={Boolean(draft.id)} value={draft.calendarId} onChange={(event) => updateCalendarDraft({ calendarId: event.target.value })}>{calendars.map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}</select>
                    <ChevronDown size={17} aria-hidden="true" />
                  </label>
                  <label className="calendar-meta-field">
                    <MapPin size={18} aria-hidden="true" />
                    <input aria-label="地点" value={draft.location} maxLength={500} placeholder="添加地点" onChange={(event) => updateCalendarDraft({ location: event.target.value })} />
                  </label>
                </div>
                <label className="calendar-description">
                  <NotebookPen size={18} aria-hidden="true" />
                  <textarea aria-label="备注" rows={1} value={draft.description} maxLength={100000} placeholder="添加备注" onChange={(event) => updateCalendarDraft({ description: event.target.value })} />
                </label>
                {draft.id && <ProjectAssociationControl kind="calendar" entityId={draft.id} onChanged={() => setRelatedVersion((current) => current + 1)} />}
                {draft.id && <RelatedContentPanel kind="calendar" entityId={draft.id} refreshKey={relatedVersion} hideWhenEmpty />}
              </div>
              {draft.conflicts.length > 0 && <div className="task-schedule-conflicts calendar-dialog-conflicts" role="alert"><header><AlertCircle size={16} /><strong>发现时间冲突</strong></header>{draft.conflicts.map((conflict) => <div key={conflict.id}><span>{formatTaskBlockRange(conflict.start, conflict.end)}</span><strong>{conflict.title}</strong></div>)}<p>可以返回修改时间，或者确认仍然保存。</p></div>}
            </> : <div className="calendar-detail-content">
              <div className="calendar-detail-time">
                <div><span className="calendar-detail-icon calendar-detail-icon-date"><CalendarDays size={17} /></span><strong>{formatCalendarDetailDate(draft)}</strong></div>
                <div><span className="calendar-detail-icon calendar-detail-icon-time"><Clock3 size={17} /></span><strong>{formatCalendarDetailTime(draft)}</strong><small>{formatCalendarDetailDuration(draft)}</small></div>
              </div>
              <div className="calendar-detail-meta">
                <div><span className="calendar-detail-icon"><CalendarDays size={15} /></span><strong>{draftCalendar?.name ?? "日历"}</strong></div>
                {draft.location && <div><span className="calendar-detail-icon"><MapPin size={15} /></span><strong>{draft.location}</strong></div>}
              </div>
              {draftWriteDisabledReason && <div className="calendar-detail-notice" role="note"><ShieldCheck size={14} /><span>{draftWriteDisabledReason}</span></div>}
              {draft.description.trim() && <section className="calendar-detail-notes"><h3>备注</h3><p>{draft.description}</p></section>}
              {draft.id && <ProjectAssociationControl kind="calendar" entityId={draft.id} onChanged={() => setRelatedVersion((current) => current + 1)} />}
              {draft.id && <RelatedContentPanel kind="calendar" entityId={draft.id} refreshKey={relatedVersion} hideWhenEmpty />}
            </div>}
            <footer className={draftEditing ? "calendar-edit-footer" : "calendar-detail-footer"}>
              {draftEditing && draft.id ? <button className="ghost-button danger-button" disabled={busy} onClick={() => { const event = events.find((item) => item.id === draft.id); if (event) void deleteEvent(event); }}><Trash2 size={15} />删除</button> : <span />}
              <div>{draftEditing ? <>
                <button className="secondary-button" disabled={busy} onClick={() => { if (draftEvent) openEditDraft(draftEvent, "view"); else setDraft(undefined); }}>取消</button>
                <button className={draft.conflicts.length ? "danger-confirm-button" : "primary-button"} disabled={busy} onClick={() => void saveDraft(draft.conflicts.length > 0)}>{busy && <LoaderCircle className="spin" size={15} />}{draft.conflicts.length ? "仍然保存" : draft.id ? "保存修改" : "创建日程"}</button>
              </> : <>
                {!draftReadOnly && <button className="secondary-button" onClick={() => setDraftMode("edit")}><Pencil size={14} />编辑</button>}
                <button className="primary-button" onClick={() => setDraft(undefined)}>关闭</button>
              </>}</div>
            </footer>
          </section>
        </div>
      )}

      {menu && contextCommands.length > 0 && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          ariaLabel={contextEvent ? `日程操作：${contextEvent.title}` : "空闲时间操作"}
          commands={contextCommands}
          heading={contextEvent?.title ?? (menu.kind === "slot" ? formatCalendarSlotHeading(menu.startsAt) : "空闲时间")}
          returnFocus={menuReturnFocusRef.current}
          testId="calendar-context-menu"
          onClose={() => setMenu(undefined)}
          onSelect={handleContextCommand}
        />
      )}
    </>
  );
}

interface CalendarViewCommonProps {
  readonly calendars: readonly CalendarListItem[];
  readonly events: readonly CalendarViewEvent[];
  readonly loading: boolean;
  readonly onCreate: (start: Date, title?: string) => void;
  readonly onEdit: (event: CalendarViewEvent) => void;
  readonly previewEventId?: string;
  readonly onPreviewEvent: (event: CalendarViewEvent, anchor: HTMLElement) => void;
  readonly onClearEventPreview: () => void;
  readonly onOpenEventMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void;
  readonly onOpenSlotMenu: (startsAt: Date, x: number, y: number, returnFocus: HTMLElement) => void;
  readonly onDropTask?: (taskId: string, startsAt: Date) => void;
  readonly onMoveTaskBlock?: (event: CalendarViewEvent, startsAt: Date) => void;
}

const weekVisibleStartHour = 7;
const weekVisibleEndHour = 22;
const weekHourHeight = 60;

function CalendarWeekView({
  calendars,
  events,
  loading,
  weekStart,
  onCreate,
  onEdit,
  previewEventId,
  onPreviewEvent,
  onClearEventPreview,
  onOpenEventMenu,
  onOpenSlotMenu,
  onDropTask,
  onMoveTaskBlock,
}: CalendarViewCommonProps & { readonly weekStart: Date }) {
  const [currentTime, setCurrentTime] = useState<Date>();
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(weekStart, index));
  const hours = Array.from({ length: weekVisibleEndHour - weekVisibleStartHour + 1 }, (_, index) => weekVisibleStartHour + index);
  const timelineHeight = (weekVisibleEndHour - weekVisibleStartHour) * weekHourHeight;
  const currentMinutes = currentTime ? currentTime.getHours() * 60 + currentTime.getMinutes() + currentTime.getSeconds() / 60 : undefined;
  const currentTimeTop = currentMinutes === undefined
    ? undefined
    : ((currentMinutes - weekVisibleStartHour * 60) / 60) * weekHourHeight;
  const currentTimeVisible = currentTimeTop !== undefined && currentTimeTop >= 0 && currentTimeTop <= timelineHeight;

  useEffect(() => {
    const updateCurrentTime = () => setCurrentTime(new Date());
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") updateCurrentTime(); };
    updateCurrentTime();
    const interval = window.setInterval(updateCurrentTime, 30_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const slotFromPointer = (day: Date, target: HTMLElement, clientY: number) => {
    const bounds = target.getBoundingClientRect();
    const rawMinutes = ((clientY - bounds.top) / weekHourHeight) * 60;
    const roundedMinutes = Math.round(rawMinutes / 15) * 15;
    const start = new Date(day);
    start.setHours(weekVisibleStartHour, Math.max(0, Math.min(roundedMinutes, (weekVisibleEndHour - weekVisibleStartHour) * 60 - 15)), 0, 0);
    return start;
  };

  return (
    <section className="calendar-week panel" aria-label="周视图" data-testid="calendar-week-view">
      <div className="calendar-week-viewport">
        <div className="calendar-week-sticky">
          <div className="calendar-week-header">
            <div className="calendar-week-corner">GMT{formatTimezoneOffset(new Date())}</div>
            {days.map((day, index) => (
              <div className={`calendar-week-day-heading ${calendarDatesMatch(day, new Date()) ? "today" : ""}`} key={day.toISOString()}>
                <span>{calendarDayNames[index]}</span><b>{day.getDate()}</b>
              </div>
            ))}
          </div>
          <div className="calendar-all-day-row">
            <div className="calendar-all-day-label">全天</div>
            {days.map((day) => (
              <div className="calendar-all-day-cell" key={day.toISOString()}>
                {events.filter((event) => event.allDay && calendarEventOverlapsDay(event, day)).map((event) => (
                  <CalendarCompactEvent
                    calendar={calendars.find((item) => item.id === event.calendarId)}
                    event={event}
                    key={event.id}
                    onEdit={onEdit}
                    previewed={previewEventId === event.id}
                    onPreview={onPreviewEvent}
                    onClearPreview={onClearEventPreview}
                    onOpenMenu={onOpenEventMenu}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="calendar-week-timeline">
          <div className="calendar-time-axis" style={{ height: timelineHeight }}>
            {hours.map((hour) => <time key={hour} style={{ top: (hour - weekVisibleStartHour) * weekHourHeight }}>{String(hour).padStart(2, "0")}:00</time>)}
          </div>
          <div className="calendar-week-grid" style={{ height: timelineHeight }}>
            {days.map((day, index) => {
              const laidOutEvents = layoutCalendarDayEvents(events.filter((event) => !event.allDay), day);
              const isToday = Boolean(currentTime && calendarDatesMatch(day, currentTime));
              return (
                <div
                  className={`calendar-time-lane ${isToday ? "today" : ""}`}
                  data-testid={`calendar-week-day-${index}`}
                  key={day.toISOString()}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes("application/x-kalender-task") && !event.dataTransfer.types.includes("application/x-kalender-task-block")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  event.currentTarget.classList.add("task-drop-target");
                }}
                onDragLeave={(event) => event.currentTarget.classList.remove("task-drop-target")}
                onDrop={(event) => {
                  event.preventDefault();
                  event.currentTarget.classList.remove("task-drop-target");
                  const blockId = event.dataTransfer.getData("application/x-kalender-task-block");
                  const movedEvent = blockId ? events.find((item) => item.id === blockId) : undefined;
                  if (movedEvent) {
                    onMoveTaskBlock?.(movedEvent, slotFromPointer(day, event.currentTarget, event.clientY));
                    return;
                  }
                  const taskId = event.dataTransfer.getData("application/x-kalender-task");
                  if (taskId) onDropTask?.(taskId, slotFromPointer(day, event.currentTarget, event.clientY));
                }}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(".calendar-week-event")) return;
                  onCreate(slotFromPointer(day, event.currentTarget, event.clientY));
                }}
                onContextMenu={(event) => {
                  if (event.shiftKey || (event.target as HTMLElement).closest(".calendar-week-event")) return;
                  event.preventDefault();
                  onOpenSlotMenu(slotFromPointer(day, event.currentTarget, event.clientY), event.clientX, event.clientY, event.currentTarget);
                }}
              >
                {isToday && currentTimeVisible && currentTimeTop !== undefined && currentTime && (
                  <div
                    className="calendar-current-time"
                    style={{ top: currentTimeTop }}
                    role="timer"
                    aria-label={`当前时间 ${formatCalendarCurrentTime(currentTime)}`}
                  >
                    <time dateTime={currentTime.toISOString()}>{formatCalendarCurrentTime(currentTime)}</time>
                  </div>
                )}
                {laidOutEvents.map((placed) => {
                  const calendar = calendars.find((item) => item.id === placed.event.calendarId);
                  return (
                    <button
                      className={`calendar-week-event ${placed.event.linkedTask ? "task-block-draggable" : ""}`}
                      data-testid="calendar-event"
                      draggable={Boolean(placed.event.linkedTask)}
                      key={placed.event.id}
                      style={{
                        top: placed.top,
                        height: placed.height,
                        left: `${placed.leftPercent}%`,
                        width: `${placed.widthPercent}%`,
                        borderLeftColor: calendar?.color ?? "#86bdf5",
                      }}
                      onClick={(event) => { event.stopPropagation(); onEdit(placed.event); }}
                      onMouseEnter={(event) => onPreviewEvent(placed.event, event.currentTarget)}
                      onMouseLeave={onClearEventPreview}
                      onFocus={(event) => onPreviewEvent(placed.event, event.currentTarget)}
                      onBlur={onClearEventPreview}
                      onDragStart={(event) => {
                        if (!placed.event.linkedTask) return;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("application/x-kalender-task-block", placed.event.id);
                        event.currentTarget.classList.add("dragging");
                      }}
                      onDragEnd={(event) => event.currentTarget.classList.remove("dragging")}
                      onContextMenu={(event) => {
                        if (event.shiftKey) return;
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenEventMenu(placed.event, event.clientX, event.clientY, event.currentTarget);
                      }}
                      onKeyDown={(event) => openCalendarEventKeyboardMenu(event, placed.event, onOpenEventMenu)}
                      aria-describedby={previewEventId === placed.event.id ? "calendar-event-tooltip" : undefined}
                    >
                      <span className="calendar-week-event-heading">
                        <time>{formatCalendarEventTime(placed.event.start)}</time>
                        <strong>{placed.event.title}</strong>
                      </span>
                      {placed.height >= 42 && (placed.event.linkedTask ? <small className="calendar-event-task"><ListChecks size={10} />任务 · {placed.event.linkedTask.title}</small> : placed.event.location && <small>{placed.event.location}</small>)}
                    </button>
                  );
                })}
                </div>
              );
            })}
            {loading && <div className="calendar-view-loading"><LoaderCircle className="spin" size={17} />正在读取日程</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function CalendarMonthView({
  anchorDate,
  calendars,
  events,
  loading,
  rangeStart,
  onCreate,
  onEdit,
  previewEventId,
  onPreviewEvent,
  onClearEventPreview,
  onOpenEventMenu,
  onOpenSlotMenu,
}: CalendarViewCommonProps & { readonly anchorDate: Date; readonly rangeStart: Date }) {
  const [expandedDay, setExpandedDay] = useState("");
  const days = Array.from({ length: 42 }, (_, index) => addCalendarDays(rangeStart, index));

  return (
    <section className="calendar-month panel" aria-label="月视图" data-testid="calendar-month-view">
      <div className="calendar-month-weekdays">
        {calendarDayNames.map((name) => <div key={name}>{name}</div>)}
      </div>
      <div className="calendar-month-grid">
        {days.map((day, index) => {
          const dayKey = toCalendarDateKey(day);
          const dayEvents = events
            .filter((event) => calendarEventOverlapsDay(event, day))
            .sort((left, right) => Number(right.allDay) - Number(left.allDay) || new Date(left.start).getTime() - new Date(right.start).getTime());
          const expanded = expandedDay === dayKey;
          const visibleEvents = expanded ? dayEvents : dayEvents.slice(0, 3);
          const slotStart = calendarSlotStart(day);
          return (
            <div
              className={`calendar-month-day ${day.getMonth() !== anchorDate.getMonth() ? "outside" : ""} ${calendarDatesMatch(day, new Date()) ? "today" : ""}`}
              data-testid={`calendar-month-day-${index}`}
              key={dayKey}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest(".calendar-month-event, .calendar-more-events")) return;
                onCreate(slotStart);
              }}
              onContextMenu={(event) => {
                if (event.shiftKey || (event.target as HTMLElement).closest(".calendar-month-event")) return;
                event.preventDefault();
                onOpenSlotMenu(slotStart, event.clientX, event.clientY, event.currentTarget);
              }}
            >
              <header><span>{day.getDate()}</span>{day.getDate() === 1 && <small>{day.getMonth() + 1}月</small>}</header>
              <div className="calendar-month-events">
                {visibleEvents.map((event) => (
                  <CalendarCompactEvent
                    calendar={calendars.find((item) => item.id === event.calendarId)}
                    event={event}
                    key={event.id}
                    month
                    onEdit={onEdit}
                    previewed={previewEventId === event.id}
                    onPreview={onPreviewEvent}
                    onClearPreview={onClearEventPreview}
                    onOpenMenu={onOpenEventMenu}
                  />
                ))}
                {dayEvents.length > 3 && (
                  <button className="calendar-more-events" onClick={(event) => { event.stopPropagation(); setExpandedDay(expanded ? "" : dayKey); }}>
                    {expanded ? "收起" : `还有 ${dayEvents.length - 3} 项`}
                  </button>
                )}
              </div>
              {loading && index === 0 && <div className="calendar-loading"><LoaderCircle className="spin" size={14} /></div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CalendarCompactEvent({
  calendar,
  event,
  month = false,
  onEdit,
  previewed = false,
  onPreview,
  onClearPreview,
  onOpenMenu,
}: {
  readonly calendar?: CalendarListItem;
  readonly event: CalendarViewEvent;
  readonly month?: boolean;
  readonly onEdit: (event: CalendarViewEvent) => void;
  readonly previewed?: boolean;
  readonly onPreview: (event: CalendarViewEvent, anchor: HTMLElement) => void;
  readonly onClearPreview: () => void;
  readonly onOpenMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void;
}) {
  return (
    <button
      className={month ? "calendar-month-event" : "calendar-all-day-event"}
      style={{ borderLeftColor: calendar?.color ?? "#86bdf5" }}
      onClick={(clickEvent) => { clickEvent.stopPropagation(); onEdit(event); }}
      onMouseEnter={(hoverEvent) => onPreview(event, hoverEvent.currentTarget)}
      onMouseLeave={onClearPreview}
      onFocus={(focusEvent) => onPreview(event, focusEvent.currentTarget)}
      onBlur={onClearPreview}
      onContextMenu={(contextEvent) => {
        if (contextEvent.shiftKey) return;
        contextEvent.preventDefault();
        contextEvent.stopPropagation();
        onOpenMenu(event, contextEvent.clientX, contextEvent.clientY, contextEvent.currentTarget);
      }}
      onKeyDown={(keyEvent) => openCalendarEventKeyboardMenu(keyEvent, event, onOpenMenu)}
      aria-describedby={previewed ? "calendar-event-tooltip" : undefined}
    >
      {!event.allDay && <time>{formatCalendarEventTime(event.start)}</time>}
      <span>{event.title}</span>
      {event.linkedTask && <ListChecks className="calendar-compact-task-icon" size={10} aria-label="关联任务" />}
    </button>
  );
}

function CalendarEventTooltip({
  anchor,
  calendar,
  event,
}: {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly calendar?: CalendarListItem;
  readonly event: CalendarViewEvent;
}) {
  const statusLabel = event.status === "tentative" ? "暂定" : event.status === "cancelled" ? "已取消" : undefined;
  return (
    <aside
      id="calendar-event-tooltip"
      className="calendar-event-tooltip"
      role="tooltip"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <header>
        <span><i style={{ background: calendar?.color ?? "#86bdf5" }} />{calendar?.name ?? "日历"}{calendar?.readOnly ? " · 只读" : ""}</span>
        {statusLabel && <em className={`status-${event.status}`}>{statusLabel}</em>}
      </header>
      <strong>{event.title}</strong>
      <div className="calendar-event-tooltip-meta">
        <span><Clock3 size={13} />{formatCalendarEventRange(event)}</span>
        {event.location && <span><MapPin size={13} />{event.location}</span>}
        {event.meetingUrl && <span><Link2 size={13} />{formatCalendarMeetingHost(event.meetingUrl)}</span>}
      </div>
      {event.description && <p>{event.description}</p>}
      {event.attendees?.length ? <small>{event.attendees.length} 位参与者</small> : null}
      {event.linkedTask && <small><ListChecks size={12} />关联任务：{event.linkedTask.title}</small>}
    </aside>
  );
}

function openCalendarEventKeyboardMenu(
  keyEvent: KeyboardEvent<HTMLButtonElement>,
  event: CalendarViewEvent,
  onOpenMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void,
) {
  if (keyEvent.key !== "ContextMenu" && !(keyEvent.shiftKey && keyEvent.key === "F10")) return;
  keyEvent.preventDefault();
  const bounds = keyEvent.currentTarget.getBoundingClientRect();
  onOpenMenu(event, bounds.right - 10, bounds.bottom + 4, keyEvent.currentTarget);
}

interface LaidOutCalendarEvent {
  readonly event: CalendarViewEvent;
  readonly top: number;
  readonly height: number;
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly column: number;
  readonly clippedStart: number;
  readonly clippedEnd: number;
}

function layoutCalendarDayEvents(events: readonly CalendarViewEvent[], day: Date): readonly LaidOutCalendarEvent[] {
  const visibleStart = new Date(day);
  visibleStart.setHours(weekVisibleStartHour, 0, 0, 0);
  const visibleEnd = new Date(day);
  visibleEnd.setHours(weekVisibleEndHour, 0, 0, 0);
  const candidates = events
    .map((event) => ({
      event,
      clippedStart: Math.max(new Date(event.start).getTime(), visibleStart.getTime()),
      clippedEnd: Math.min(new Date(event.end).getTime(), visibleEnd.getTime()),
    }))
    .filter((item) => item.clippedStart < item.clippedEnd)
    .sort((left, right) => left.clippedStart - right.clippedStart || right.clippedEnd - left.clippedEnd);
  const placed: LaidOutCalendarEvent[] = [];
  for (const candidate of candidates) {
    const overlappingPrevious = placed.filter((item) => item.clippedEnd > candidate.clippedStart && item.clippedStart < candidate.clippedEnd);
    const usedColumns = new Set(overlappingPrevious.map((item) => item.column));
    let column = 0;
    while (usedColumns.has(column)) column += 1;
    const minutesFromStart = (candidate.clippedStart - visibleStart.getTime()) / 60000;
    const durationMinutes = (candidate.clippedEnd - candidate.clippedStart) / 60000;
    placed.push({
      ...candidate,
      column,
      top: (minutesFromStart / 60) * weekHourHeight,
      height: Math.max(24, (durationMinutes / 60) * weekHourHeight),
      leftPercent: 0,
      widthPercent: 100,
    });
  }
  return placed.map((item) => {
    const overlapGroup = placed.filter((other) => other.clippedEnd > item.clippedStart && other.clippedStart < item.clippedEnd);
    const columns = Math.max(...overlapGroup.map((other) => other.column), 0) + 1;
    return { ...item, leftPercent: (item.column / columns) * 100, widthPercent: 100 / columns };
  });
}

function startOfCalendarWeek(value: Date): Date {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  const mondayOffset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - mondayOffset);
  return result;
}

function startOfCalendarMonth(value: Date): Date {
  const result = new Date(value);
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
}

function moveCalendarPeriod(value: Date, view: CalendarViewMode, amount: number): Date {
  const result = new Date(value);
  if (view === "week") result.setDate(result.getDate() + amount * 7);
  else result.setMonth(result.getMonth() + amount, 1);
  return result;
}

function addCalendarDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function calendarSlotStart(day: Date): Date {
  const result = new Date(day);
  result.setHours(9, 0, 0, 0);
  return result;
}

function nextCalendarHour(value: Date): Date {
  const result = new Date(value);
  result.setMinutes(0, 0, 0);
  result.setHours(result.getHours() + 1);
  return result;
}

function calendarDatesMatch(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function calendarEventOverlapsDay(event: CalendarViewEvent, day: Date): boolean {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addCalendarDays(dayStart, 1);
  return new Date(event.start) < dayEnd && new Date(event.end) > dayStart;
}

function toCalendarDateKey(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toLocalDateTimeInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function formatCalendarEventTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatCalendarDetailDate(draft: CalendarEventDraft): string {
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00:00` : draft.startLocal);
  const end = new Date(draft.allDay ? `${draft.endLocal}T00:00:00` : draft.endLocal);
  const format = (value: Date) => new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
  if (Number.isNaN(start.getTime())) return draft.startLocal;
  if (Number.isNaN(end.getTime()) || calendarDatesMatch(start, end)) return format(start);
  return `${format(start)} — ${format(end)}`;
}

function formatCalendarDetailTime(draft: CalendarEventDraft): string {
  if (draft.allDay) return "全天";
  const start = new Date(draft.startLocal);
  const end = new Date(draft.endLocal);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${draft.startLocal} — ${draft.endLocal}`;
  const format = (value: Date) => new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
  return calendarDatesMatch(start, end) ? `${format(start)} — ${format(end)}` : `${format(start)} — ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}

function formatCalendarDetailDuration(draft: CalendarEventDraft): string {
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00:00` : draft.startLocal);
  const end = new Date(draft.allDay ? `${draft.endLocal}T00:00:00` : draft.endLocal);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  if (draft.allDay) {
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    return days === 1 ? "全天" : `${days} 天`;
  }
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}

function formatCalendarEventRange(event: CalendarViewEvent): string {
  const start = new Date(event.start);
  const end = event.allDay ? new Date(new Date(event.end).getTime() - 1) : new Date(event.end);
  const sameDay = calendarDatesMatch(start, end);
  const date = (value: Date, includeWeekday = false) => {
    const weekday = includeWeekday ? new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(value) : "";
    return `${value.getMonth() + 1}月${value.getDate()}日${weekday}`;
  };
  if (event.allDay) return sameDay ? `${date(start, true)} · 全天` : `${date(start)} – ${date(end)} · 全天`;
  const time = (value: Date) => new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
  return sameDay ? `${date(start, true)} · ${time(start)}–${time(end)}` : `${date(start)} ${time(start)} – ${date(end)} ${time(end)}`;
}

function formatCalendarMeetingHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "在线会议";
  }
}

function formatCalendarCurrentTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
}

function formatCalendarWeekRange(start: Date, end: Date): string {
  const inclusiveEnd = addCalendarDays(end, -1);
  const startLabel = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(start);
  const endLabel = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: start.getFullYear() === inclusiveEnd.getFullYear() ? undefined : "numeric" }).format(inclusiveEnd);
  return `${startLabel} – ${endLabel}`;
}

function formatCalendarMonth(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(value);
}

function formatTimezoneOffset(value: Date): string {
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

function formatCalendarSlotHeading(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
