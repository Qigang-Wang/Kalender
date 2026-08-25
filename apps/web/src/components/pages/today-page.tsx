"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronUp, Clock3, Link2, ListChecks, LoaderCircle, Mail, MapPin, Paperclip, Star, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { appConfirm } from "@/components/app-dialog-provider";
import { useRealtimeRefresh } from "@/components/realtime-context";
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

  const loadToday = useCallback(async ({ background = false }: { readonly background?: boolean } = {}) => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (!background) {
      setFeedback(undefined);
      setState("loading");
    }
    try {
      const response = await fetchWithTimeout(`/api/today?${params}`, { cache: "no-store" });
      const payload = await response.json() as { readonly ok?: boolean; readonly snapshot?: TodaySnapshot; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.snapshot) throw new Error(payload.message ?? "Daten können heute nicht gelesen werden");
      setSnapshot(payload.snapshot);
      setState("ready");
    } catch (error) {
      if (background) return;
      setFeedback(error instanceof Error ? error.message : "Daten können heute nicht gelesen werden");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void loadToday();
  }, [loadToday, retry]);
  useRealtimeRefresh(["mail", "calendar", "task", "relation"], () => loadToday({ background: true }));

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
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "nicht in der Lage, die Aufgabe zu erledigen");
      setSnapshot((current) => current ? {
        ...current,
        tasks: current.tasks.filter((entry) => entry.id !== task.id),
        totals: { ...current.totals, tasks: Math.max(0, current.totals.tasks - 1) },
      } : current);
      window.dispatchEvent(new Event("kalender:tasks-changed"));
      setFeedback("Erledigte Aufgabe");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "nicht in der Lage, die Aufgabe zu erledigen");
    } finally {
      setBusyTaskId(undefined);
    }
  };

  const deleteTask = async (task: TodayTaskItem) => {
    if (busyTaskId) return;
    if (!await appConfirm({
      title: `Aufgaben löschen${task.title}“?`,
      description: "Die Aufgabe und deren Kalenderblock werden dauerhaft gelöscht und diese Operation kann nicht widerrufen werden.",
      confirmLabel: "Aufgaben löschen",
      tone: "danger",
    })) return;
    setBusyTaskId(task.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { readonly ok?: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Aufgabe kann nicht gelöscht werden");
      setSnapshot((current) => current ? {
        ...current,
        tasks: current.tasks.filter((entry) => entry.id !== task.id),
        totals: { ...current.totals, tasks: Math.max(0, current.totals.tasks - 1) },
      } : current);
      window.dispatchEvent(new Event("kalender:tasks-changed"));
      setFeedback("Aufgabe gelöscht");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht gelöscht werden");
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
      title: `Termin „${event.title}“ löschen?`,
      description: event.recurrenceSeriesId && event.recurrenceId
        ? "löschen Sie nur dieses Kalenderereignis für heute, diese Operation kann nicht widerrufen werden."
        : "Dieses Kalenderereignis wird dauerhaft gelöscht und diese Operation kann nicht widerrufen werden.",
      confirmLabel: "Termin löschen",
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
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Kalenderereignis kann nicht gelöscht werden");
      setSnapshot((current) => current ? {
        ...current,
        events: current.events.filter((entry) => entry.id !== event.id),
        totals: { ...current.totals, events: Math.max(0, current.totals.events - 1) },
      } : current);
      setFeedback("Termin gelöscht");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Kalenderereignis kann nicht gelöscht werden");
    } finally {
      setBusyEventId(undefined);
    }
  };

  const resizeEvent = async (event: TodayEventItem, end: Date) => {
    if (busyEventId || event.allDay || event.deleteDisabledReason) return;
    const start = new Date(event.start);
    const targetEnd = new Date(Math.max(start.getTime() + 5 * 60_000, end.getTime()));
    if (targetEnd.getTime() === new Date(event.end).getTime()) return;
    setBusyEventId(event.id);
    try {
      const requestResize = async (allowConflicts: boolean) => {
        const linkedTaskUrl = event.linkedTask
          ? `/api/tasks/${encodeURIComponent(event.linkedTask.id)}/schedule/${encodeURIComponent(event.id)}`
          : undefined;
        const response = await fetch(linkedTaskUrl ?? `/api/calendar-events/${encodeURIComponent(event.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event.linkedTask ? {
            calendarId: event.calendarId,
            start: start.toISOString(),
            end: targetEnd.toISOString(),
            timeZone: event.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            allowConflicts,
          } : {
            calendarId: event.calendarId,
            title: event.title,
            description: event.description,
            descriptionContent: event.descriptionContent,
            location: event.location,
            start: start.toISOString(),
            end: targetEnd.toISOString(),
            timeZone: event.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            allDay: false,
            recurrenceSeriesId: event.recurrenceSeriesId,
            recurrenceId: event.recurrenceId,
            recurrenceScope: event.recurrenceSeriesId && event.recurrenceId ? "occurrence" : undefined,
            allowConflicts,
          }),
        });
        const payload = await response.json().catch(() => ({})) as {
          readonly ok?: boolean;
          readonly conflicts?: readonly { readonly title: string }[];
          readonly message?: string;
        };
        return { response, payload };
      };
      let result = await requestResize(false);
      if (result.response.status === 409 && result.payload.conflicts?.length) {
        const conflictNames = result.payload.conflicts.slice(0, 3).map((conflict) => `„${conflict.title}“`).join(", ");
        if (!await appConfirm({
          title: "Zeitkonflikt mit bestehenden Terminen",
          description: `Zeit und Zeit nach der Anpassung ${conflictNames}Konflikt. Passen Sie dieses Kalenderereignis noch lange an?`,
          confirmLabel: "Nach wie vor anpassen",
        })) {
          setFeedback("Terminanpassung abgebrochen");
          return;
        }
        result = await requestResize(true);
      }
      if (!result.response.ok || !result.payload.ok) throw new Error(result.payload.message ?? "es ist nicht möglich, die Länge des Kalenderereignisses anzupassen");
      setSnapshot((current) => current ? {
        ...current,
        events: current.events.map((entry) => entry.id === event.id ? { ...entry, end: targetEnd.toISOString() } : entry),
      } : current);
      void loadToday({ background: true });
      setFeedback(`angepasst "${event.title}"lange Zeit"`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "es ist nicht möglich, die Länge des Kalenderereignisses anzupassen");
    } finally {
      setBusyEventId(undefined);
    }
  };

  const runMailAction = async (message: TodayMailItem, action: TodayMailAction) => {
    if (busyMailId) return;
    if (action === "delete" && !await appConfirm({
      title: `Mail löschen '${message.subject}“?`,
      description: "Mail wird in den gelöschten Mail-Ordner im Postfach verschoben.",
      confirmLabel: "Mail löschen",
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
      if (!response.ok || !payload.result) throw new Error(payload.message ?? "Mail-Operation fehlgeschlagen");
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
        action === "mark-read" ? "E-Mail als gelesen markiert"
          : action === "archive" ? "E-Mail archiviert"
          : action === "delete" ? payload.result.alreadyRemoved ? "lokale Mail-Datensätze gelöscht" : "E-Mail auf gelöschte E-Mail verschoben"
          : action === "star" ? "E-Mail hinzugefügt Sternchen" : "E-Mail storniert Sternchen",
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Mail-Operation fehlgeschlagen");
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

  if (state === "loading") return <div className="today-loading panel"><LoaderCircle className="spin" size={19} />Die heutigen Daten zu synthetisieren...</div>;
  if (state === "error" || !snapshot) return <div className="today-loading panel"><AlertCircle size={19} /><span>{feedback ?? "Daten können heute nicht gelesen werden"}</span><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>Erneut versuchen</button></div>;

  const contextEvent = contextMenu?.kind === "event" ? snapshot.events.find((event) => event.id === contextMenu.id) : undefined;
  const contextTask = contextMenu?.kind === "task" ? snapshot.tasks.find((task) => task.id === contextMenu.id) : undefined;
  const contextMail = contextMenu?.kind === "mail" ? snapshot.unreadMail.find((message) => message.id === contextMenu.id) : undefined;

  return (
    <>
      <div className="today-summary-strip">
        <time>{formatTodayDate(snapshot.from)}</time>
        <span><CalendarDays size={14} />{snapshot.totals.events} Termin(e)</span>
        <span><ListChecks size={14} />{snapshot.totals.tasks} anstehende Aufgabe(n)</span>
        <span><Mail size={14} />{snapshot.totals.unreadMail} Abdeckung ungelesen</span>
      </div>
      {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
      <div className="today-layout">
        <section className="panel schedule-panel">
          <h2><Clock3 size={19} />heute Zeitplan <small>{snapshot.events.length}</small></h2>
          {snapshot.events.length ? <TodayTimeline events={snapshot.events} dayStartValue={snapshot.from} busyEventId={busyEventId} onResizeEvent={(event, end) => void resizeEvent(event, end)} onOpenMenu={(event, x, y, returnFocus) => openContextMenu("event", event.id, x, y, returnFocus)} />
            : <TodayEmpty icon={<CalendarDays size={20} />} text="kein Veranstaltungskalender für heute" />}
        </section>
        <div className="today-side">
          <section className="panel compact-panel">
            <h2><ListChecks size={19} />muss fortgeschritten sein <small>{snapshot.totals.tasks}</small></h2>
            {snapshot.tasks.length ? snapshot.tasks.map((task) => <TaskRow task={task} busy={busyTaskId === task.id} onComplete={() => void completeTask(task)} onOpenMenu={(x, y, returnFocus) => openContextMenu("task", task.id, x, y, returnFocus)} key={task.id} />)
              : <TodayEmpty icon={<CheckCircle2 size={20} />} text="keine abgelaufene oder dringende Aufgabe heute" />}
          </section>
          <section className="panel reply-panel">
            <h2><Mail size={18} />ungelesene E-Mail <small>{snapshot.totals.unreadMail}</small></h2>
            {snapshot.unreadMail.length ? <div className="today-mail-list">{snapshot.unreadMail.map((message) => <TodayMailRow
              message={message}
              onOpenMenu={(x, y, returnFocus) => openContextMenu("mail", message.id, x, y, returnFocus)}
              key={message.id}
            />)}</div> : <TodayEmpty icon={<Mail size={20} />} text="Posteingang hat keine ungelesene E-Mail" />}
          </section>
        </div>
      </div>
      {contextMenu && contextEvent && <ContextMenu
        anchor={{ x: contextMenu.x, y: contextMenu.y }}
        ariaLabel="Die heutige Veranstaltung des Kalenders Operation"
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
        ariaLabel="Betrieb heute"
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
        ariaLabel="Die heutige Mail Operation"
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

interface TodayEventResizePreview {
  readonly eventId: string;
  readonly pointerId: number;
  readonly start: Date;
  readonly originalEnd: Date;
  readonly end: Date;
}

const TODAY_TIMELINE_HOUR_HEIGHT = 56;
const TODAY_TIMELINE_MIN_EVENT_HEIGHT = 30;

function TodayTimeline({
  events,
  dayStartValue,
  busyEventId,
  onResizeEvent,
  onOpenMenu,
}: {
  readonly events: readonly TodayEventItem[];
  readonly dayStartValue: string;
  readonly busyEventId?: string;
  readonly onResizeEvent: (event: TodayEventItem, end: Date) => void;
  readonly onOpenMenu: (event: TodayEventItem, x: number, y: number, returnFocus?: HTMLElement | null) => void;
}) {
  const [resizePreview, setResizePreview] = useState<TodayEventResizePreview>();
  const resizePreviewRef = useRef<TodayEventResizePreview | undefined>(undefined);
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
    Math.ceil(Math.max(...(eventMinutes.length ? eventMinutes : [17 * 60])) / 60) + 1,
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

  const setActiveResize = (preview: TodayEventResizePreview | undefined) => {
    resizePreviewRef.current = preview;
    setResizePreview(preview);
  };

  const beginResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>, event: TodayEventItem) => {
    if (busyEventId || event.deleteDisabledReason) return;
    if (pointerEvent.pointerType === "mouse" && pointerEvent.button !== 0) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
    setActiveResize({
      eventId: event.id,
      pointerId: pointerEvent.pointerId,
      start: new Date(event.start),
      originalEnd: new Date(event.end),
      end: new Date(event.end),
    });
  };

  const updateResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>) => {
    const current = resizePreviewRef.current;
    if (!current || current.pointerId !== pointerEvent.pointerId) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    if (pointerEvent.clientY < 48) window.scrollBy(0, -12);
    else if (pointerEvent.clientY > window.innerHeight - 48) window.scrollBy(0, 12);
    const canvas = pointerEvent.currentTarget.closest<HTMLElement>(".today-event-canvas");
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const rawMinutes = rangeStartMinutes + ((pointerEvent.clientY - bounds.top) / TODAY_TIMELINE_HOUR_HEIGHT) * 60;
    const roundedMinutes = Math.round(rawMinutes / 5) * 5;
    const clampedMinutes = Math.max(rangeStartMinutes, Math.min(rangeEndMinutes, roundedMinutes));
    const candidateEnd = new Date(dayStart.getTime() + clampedMinutes * 60_000);
    setActiveResize({ ...current, end: new Date(Math.max(current.start.getTime() + 5 * 60_000, candidateEnd.getTime())) });
  };

  const finishResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>) => {
    updateResize(pointerEvent);
    const current = resizePreviewRef.current;
    if (!current || current.pointerId !== pointerEvent.pointerId) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    if (pointerEvent.currentTarget.hasPointerCapture(pointerEvent.pointerId)) pointerEvent.currentTarget.releasePointerCapture(pointerEvent.pointerId);
    setActiveResize(undefined);
    if (current.end.getTime() !== current.originalEnd.getTime()) {
      const resizedEvent = events.find((event) => event.id === current.eventId);
      if (resizedEvent) onResizeEvent(resizedEvent, current.end);
    }
  };

  const cancelResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>) => {
    const current = resizePreviewRef.current;
    if (!current || current.pointerId !== pointerEvent.pointerId) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    setActiveResize(undefined);
  };

  return (
    <div className="today-timeline">
      {allDayEvents.length > 0 && <div className="today-all-day-lane">
        <span>Ganztägig</span>
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
            const activeResize = resizePreview?.eventId === event.id ? resizePreview : undefined;
            const eventStartMinutes = Math.max(rangeStartMinutes, minutesSince(dayStart, event.start));
            const previewEndMinutes = activeResize ? Math.min(rangeEndMinutes, minutesSince(dayStart, activeResize.end.toISOString())) : undefined;
            const displayHeight = previewEndMinutes === undefined
              ? height
              : Math.max(TODAY_TIMELINE_MIN_EVENT_HEIGHT, ((previewEndMinutes - eventStartMinutes) / 60) * TODAY_TIMELINE_HOUR_HEIGHT);
            const resizable = !busyEventId && !event.deleteDisabledReason
              && new Date(event.start).getTime() >= dayStart.getTime()
              && new Date(event.end).getTime() <= dayStart.getTime() + 24 * 60 * 60_000;
            return <TodayEventLink
              className={`today-timeline-event${displayHeight < 44 ? " compact" : ""}${activeResize ? " resizing" : ""}`}
              event={activeResize ? { ...event, end: activeResize.end.toISOString() } : event}
              style={{
                top,
                height: displayHeight,
                left: `${column * width}%`,
                width: `calc(${width}% - 5px)`,
                borderLeftColor: event.calendarColor,
              }}
              resizeHandle={resizable ? <span
                className="today-event-resize-handle"
                title="Länge des Ziehens und Wechselns"
                onPointerDown={(pointerEvent) => beginResize(pointerEvent, event)}
                onPointerMove={updateResize}
                onPointerUp={finishResize}
                onPointerCancel={cancelResize}
                onClick={(clickEvent) => {
                  clickEvent.preventDefault();
                  clickEvent.stopPropagation();
                }}
              /> : undefined}
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
  resizeHandle,
  onOpenMenu,
}: {
  readonly event: TodayEventItem;
  readonly className: string;
  readonly style?: CSSProperties;
  readonly resizeHandle?: ReactNode;
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
        <span className="today-event-time">{event.allDay ? "Ganztägig" : formatTodayEventClockRange(event)}</span>
        <strong>{event.title}</strong>
        <small>{event.calendarName}{event.location ? ` · ${event.location}` : ""}</small>
        {resizeHandle}
      </Link>
    </HoverCardTrigger>
    <HoverCardContent className="today-event-hover-card" align="start" side="right" sideOffset={8} collisionPadding={12}>
      <header>
        <span><i style={{ background: event.calendarColor }} />{event.calendarName}</span>
        {(event.availability === "oof" || event.status !== "confirmed") && <em>{event.availability === "oof" ? "Ausflug" : event.status === "tentative" ? "vorläufig" : "Annulliert"}</em>}
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
        aria-label={expanded ? "Komplette Details fallen lassen" : "Volle Details erweitern"}
        title={expanded ? "Komplette Details fallen lassen" : "Volle Details erweitern"}
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
        <button className="checkbox" aria-label={`vollständig ${task.title}`} disabled={busy} onClick={onComplete}>{busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}</button>
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
        <b>{task.dueAt ? formatTodayTaskDue(task.dueAt) : "Notfall"}</b>
      </div>
    </HoverCardTrigger>
    <HoverCardContent className="today-event-hover-card today-task-hover-card" align="start" side="left" sideOffset={8} collisionPadding={12}>
      <header>
        <span><ListChecks size={14} />{todayTaskAttentionLabel(task)}</span>
        <em>{task.isUrgent ? "Notfall" : todayTaskStatusLabel(task.status)}</em>
      </header>
      <strong>{task.title}</strong>
      <div className="today-event-hover-meta">
        {task.dueAt && <span><Clock3 size={14} />Ende:{formatTodayTaskDueDetail(task.dueAt)}</span>}
        {task.estimatedMinutes && <span><Clock3 size={14} />Erwartet:{formatTodayTaskEstimate(task.estimatedMinutes)}</span>}
        {(task.projectName || task.areaName) && <span><Link2 size={14} />{[task.areaName, task.projectName].filter(Boolean).join(" · ")}</span>}
      </div>
      {task.notes && <p className={expanded ? "expanded" : undefined}>{task.notes}</p>}
      {visibleSources.length > 0 && <div className="today-task-hover-sources">
        {visibleSources.map((source) => <span key={source.id}><Link2 size={13} />{source.label}</span>)}
      </div>}
      {hasMore && <button
        type="button"
        className="today-hover-expand"
        aria-label={expanded ? "Komplette Details fallen lassen" : "Volle Details erweitern"}
        title={expanded ? "Komplette Details fallen lassen" : "Volle Details erweitern"}
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
        <em>{message.isStarred ? "Ungelesen . Sterne" : "Ungelesen"}</em>
      </header>
      <strong>{message.subject}</strong>
      <div className="today-event-hover-meta">
        <span><Mail size={14} />{message.senderName} &lt;{message.senderAddress}&gt;</span>
        <span><Clock3 size={14} />{formatTodayMailDateTime(message.receivedAt)}</span>
        {message.attachmentCount > 0 && <span><Paperclip size={14} />{message.attachmentCount} eine Anlage</span>}
      </div>
      {message.snippet && <p className={expanded ? "expanded" : undefined}>{message.snippet}</p>}
      {hasMore && <button
        type="button"
        className="today-hover-expand"
        aria-label={expanded ? "Komplette Details fallen lassen" : "Volle Details erweitern"}
        title={expanded ? "Komplette Details fallen lassen" : "Volle Details erweitern"}
        onClick={() => setExpanded((value) => !value)}
      >{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}
    </HoverCardContent>
  </HoverCard>;
}

function TodayEmpty({ icon, text }: { readonly icon: ReactNode; readonly text: string }) {
  return <div className="today-empty">{icon}<span>{text}</span></div>;
}

function formatTodayDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "long", month: "long", day: "numeric" }).format(new Date(value));
}

function formatTodayClock(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatTodayEventClockRange(event: TodayEventItem): string {
  return `${formatTodayClock(event.start)}–${formatTodayClock(event.end)}`;
}

function formatTodayEventRange(event: TodayEventItem): string {
  if (event.allDay) return "Ganztägig";
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (start.toDateString() === end.toDateString()) return formatTodayEventClockRange(event);
  const format = new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${format.format(start)}–${format.format(end)}`;
}

function formatTodayEventDuration(event: TodayEventItem): string {
  if (event.allDay) return "Ganztägig";
  const minutes = Math.max(0, Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000));
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} Stunden` : `${minutes} Minuten`;
}

function minutesSince(dayStart: Date, value: string): number {
  return (new Date(value).getTime() - dayStart.getTime()) / 60_000;
}

function formatTodayAttendees(attendees: TodayEventItem["attendees"], limit = 3): string {
  const names = attendees.slice(0, limit).map((attendee) => attendee.name?.trim() || attendee.address);
  const remaining = attendees.length - names.length;
  return remaining > 0 ? `${names.join(", ")} und ${remaining} weitere` : names.join(", ");
}

function formatTodayMeetingHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "Online-Sitzungen";
  }
}

function todayTaskAttentionLabel(task: TodayTaskItem): string {
  return task.attention === "overdue" ? "Überfällig" : task.attention === "today" ? "Heute fällig" : "muss sofort vorgerückt werden";
}

function formatTodayTaskDue(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date < now) return "Überfällig";
  return formatTodayClock(value);
}

function formatTodayTaskDueDetail(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatTodayTaskEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} Minuten`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} Stunden ${remainder} Minuten` : `${hours} Stunden`;
}

function todayTaskStatusLabel(status: TodayTaskItem["status"]): string {
  if (status === "waiting") return "warten";
  if (status === "someday") return "später";
  if (status === "next") return "Weiter";
  return "Sammelbox";
}

function formatTodayMailTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? formatTodayClock(value)
    : new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric" }).format(date);
}

function formatTodayMailDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
