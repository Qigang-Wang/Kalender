"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle, ArrowRight, BellRing, CalendarDays, CalendarClock, Check, ChevronLeft,
  ChevronDown, ChevronRight, Circle, Clock3, Copy, Folder, Link2, ListChecks, LoaderCircle, Mail,
  MailOpen, MapPin, MoreHorizontal, NotebookPen, Pencil, Plus, RefreshCw, Repeat2, ShieldCheck, Trash2, Users, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { appConfirm } from "@/components/app-dialog-provider";
import { useRealtimeRefresh } from "@/components/realtime-context";
import { useVisiblePageRefresh } from "@/hooks/use-visible-page-refresh";
import {
  EMPTY_PLATE_NOTE_CONTENT,
  decodeNoteContent,
  encodeNoteContent,
  noteContentToPlainText,
} from "@/lib/note-content";
import {
  calendarRecurrencePreview,
  calendarRecurrenceSummary,
  localIsoWeekday,
} from "@/lib/calendar-recurrence";
import type {
  CalendarEventReminderMinutes,
  CalendarRecurrenceEditScope,
  CalendarRecurrenceRule,
} from "../../../../../src/mail/types";
import { ContextMenu } from "../context-menu";
import {
  resolveContextCommands,
  type CalendarEventCommandId,
  type CalendarSlotCommandId,
  type ContextCommandId,
} from "../context-commands";
import { TransientToast } from "../workspace-shared";
import { DateTimeField } from "../ui/date-time-field";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import {
  createClientEntityLink,
  ProjectAssociationControl,
  RelatedContentPanel,
} from "./related-content";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const TASKS_CHANGED_EVENT = "kalender:tasks-changed";
const CALENDAR_SYNCED_EVENT = "kalender:calendar-synced";

const CalendarDescriptionEditor = dynamic(
  () => import("../editor/calendar-description-editor").then((module) => module.CalendarDescriptionEditor),
  { loading: () => <div className="calendar-rich-loading"><LoaderCircle className="spin" size={15} />Editor wird geladen...</div>, ssr: false },
);

const CalendarDescriptionView = dynamic(
  () => import("../editor/calendar-description-editor").then((module) => module.CalendarDescriptionView),
  { loading: () => <div className="calendar-rich-loading"><LoaderCircle className="spin" size={15} />Kommentare lesen...</div>, ssr: false },
);

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
  const day = new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time.format(start)}–${sameDay ? time.format(end) : new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}

function formatTaskEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} Minuten`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} Stunden ${remainder} Minuten` : `${hours} Stunden`;
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
  readonly descriptionContent?: string;
  readonly location?: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone?: string;
  readonly allDay: boolean;
  readonly reminderMinutesBefore?: CalendarEventReminderMinutes;
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
  readonly recurrence?: CalendarRecurrenceRule;
  readonly recurrenceSeriesId?: string;
  readonly recurrenceId?: string;
  readonly recurrenceException?: boolean;
  readonly availability?: "free" | "tentative" | "busy" | "oof" | "working_elsewhere";
  readonly linkedTask?: { readonly id: string; readonly title: string; readonly href: string };
}

interface CalendarEventDraft {
  readonly id?: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description: string;
  readonly descriptionContent: string;
  readonly location: string;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly timeZone: string;
  readonly allDay: boolean;
  readonly reminderMinutesBefore?: CalendarEventReminderMinutes;
  readonly availability?: CalendarViewEvent["availability"];
  readonly recurrence?: CalendarRecurrenceRule;
  readonly recurrenceSeriesId?: string;
  readonly recurrenceId?: string;
  readonly recurrenceScope?: CalendarRecurrenceEditScope;
  readonly conflicts: readonly TaskScheduleConflict[];
}

interface RecurrenceScopePrompt {
  readonly action: "Änderung" | "bewegt" | "Löschen";
  readonly title: string;
}

type CalendarMenuState =
  | { readonly kind: "event"; readonly eventId: string; readonly x: number; readonly y: number }
  | { readonly kind: "slot"; readonly startsAt: string; readonly x: number; readonly y: number };

interface CalendarEventPreviewState {
  readonly eventId: string;
  readonly x: number;
  readonly y: number;
}

const calendarDayNames = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"] as const;
type CalendarViewMode = "week" | "month";
type CalendarDialogMode = "view" | "edit";

function calendarEventWriteDisabledReason(event?: CalendarViewEvent, calendar?: CalendarListItem): string | undefined {
  if (calendar?.readOnly) return "Dieser Kalender ist derzeit nur lesbar";
  if (event?.providerData?.providerId !== "exchange") return undefined;
  if (!event.providerData.itemId) return "Bitte synchronisieren Sie den RWTH-Kalender sofort, bevor Sie versuchen, ihn zu ändern";
  if (event.providerData.isRecurring) return "Wiederholte Kalender-Events werden nicht unterstützt, bitte im RWTH Web-End bearbeiten";
  if (event.providerData.isMeeting) return "Ein Treffen mit Teilnehmern wird nicht unterstützt, um vorerst zurück zu schreiben, um eine missbräuchliche Ankündigung des Treffens zu vermeiden.";
  return undefined;
}

export function CalendarPage({ initialEventId, initialCalendarDate }: { readonly initialEventId?: string; readonly initialCalendarDate?: string }) {
  const router = useRouter();
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
  const [recurrenceOpen, setRecurrenceOpen] = useState(false);
  const [attendeesExpanded, setAttendeesExpanded] = useState(false);
  const [recurrenceScopePrompt, setRecurrenceScopePrompt] = useState<RecurrenceScopePrompt>();
  const [menu, setMenu] = useState<CalendarMenuState>();
  const [eventPreview, setEventPreview] = useState<CalendarEventPreviewState>();
  const [relatedVersion, setRelatedVersion] = useState(0);
  const [calendarTasks, setCalendarTasks] = useState<readonly ClientTask[]>([]);
  const [taskDropBusy, setTaskDropBusy] = useState(false);
  const [calendarMoveBusy, setCalendarMoveBusy] = useState(false);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const recurrenceScopeResolverRef = useRef<((scope: CalendarRecurrenceEditScope | undefined) => void) | undefined>(undefined);
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

  const requestRecurrenceScope = useCallback((
    action: RecurrenceScopePrompt["action"],
    title: string,
  ): Promise<CalendarRecurrenceEditScope | undefined> => new Promise((resolve) => {
    recurrenceScopeResolverRef.current?.(undefined);
    recurrenceScopeResolverRef.current = resolve;
    setRecurrenceScopePrompt({ action, title });
  }), []);

  const resolveRecurrenceScope = (scope: CalendarRecurrenceEditScope | undefined) => {
    const resolver = recurrenceScopeResolverRef.current;
    recurrenceScopeResolverRef.current = undefined;
    setRecurrenceScopePrompt(undefined);
    resolver?.(scope);
  };

  useEffect(() => {
    const storedView = window.localStorage.getItem("kalender.calendar.view");
    if (storedView === "week" || storedView === "month") setViewMode(storedView);
  }, []);

  const loadCalendarTasks = useCallback(async () => {
    const response = await workspaceFetch("/api/tasks", {}, 0);
    const payload = await response.json() as { readonly tasks?: readonly ClientTask[] };
    if (!response.ok) throw new Error("Aufgabenplanung kann nicht gelesen werden");
    setCalendarTasks(payload.tasks ?? []);
  }, []);

  useEffect(() => {
    void loadCalendarTasks().catch(() => setCalendarTasks([]));
  }, [loadCalendarTasks]);

  const changeViewMode = (nextView: CalendarViewMode) => {
    setViewMode(nextView);
    window.localStorage.setItem("kalender.calendar.view", nextView);
  };

  const openWeekForDate = (date: Date) => {
    setAnchorDate(new Date(date));
    changeViewMode("week");
  };

  const loadCalendars = useCallback(async () => {
    const response = await workspaceFetch("/api/calendars");
    const payload = await response.json() as { readonly calendars?: readonly CalendarListItem[]; readonly message?: string };
    if (!response.ok || !payload.calendars) throw new Error(payload.message || "Kalender kann nicht gelesen werden");
    setCalendars(payload.calendars);
    return payload.calendars;
  }, []);

  const loadEvents = useCallback(async ({ background = false }: { readonly background?: boolean } = {}) => {
    if (!background) setLoading(true);
    try {
      const params = new URLSearchParams({ from: visibleRange.start.toISOString(), to: visibleRange.end.toISOString() });
      const response = await workspaceFetch(`/api/calendar-events?${params}`, {}, 0);
      const payload = await response.json() as { readonly events?: readonly CalendarViewEvent[]; readonly message?: string };
      if (!response.ok || !payload.events) throw new Error(payload.message || "es ist nicht möglich, das Kalenderereignis zu lesen");
      setEvents(payload.events);
      if (!background) setFeedback("");
    } catch (error) {
      if (!background) setFeedback(error instanceof Error ? error.message : "es ist nicht möglich, das Kalenderereignis zu lesen");
    } finally {
      if (!background) setLoading(false);
    }
  }, [visibleRange]);

  useEffect(() => {
    void loadCalendars().catch((error: unknown) => {
      setLoading(false);
      setFeedback(error instanceof Error ? error.message : "Kalender kann nicht gelesen werden");
    });
  }, [loadCalendars]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  const refreshVisibleCalendar = useCallback(async () => {
    await Promise.all([
      loadCalendars(),
      loadEvents({ background: true }),
      loadCalendarTasks(),
    ]);
  }, [loadCalendarTasks, loadCalendars, loadEvents]);
  useVisiblePageRefresh(refreshVisibleCalendar);
  useRealtimeRefresh(["calendar", "task", "relation"], refreshVisibleCalendar);
  useEffect(() => {
    const refreshAfterSync = () => { void refreshVisibleCalendar(); };
    window.addEventListener(CALENDAR_SYNCED_EVENT, refreshAfterSync);
    return () => window.removeEventListener(CALENDAR_SYNCED_EVENT, refreshAfterSync);
  }, [refreshVisibleCalendar]);

  const openCreateDraft = useCallback((start = nextCalendarHour(new Date()), title = "", selectedEnd?: Date) => {
    const calendarId = writableLocalCalendar?.id;
    if (!calendarId) {
      setFeedback("Der lokale Kalender ist noch nicht fertig, bitte versuchen Sie es später noch einmal");
      return;
    }
    setMenu(undefined);
    setEventPreview(undefined);
    setRecurrenceOpen(false);
    setAttendeesExpanded(false);
    setDraftMode("edit");
    const defaultEnd = new Date(start.getTime() + 30 * 60 * 1000);
    const end = selectedEnd && selectedEnd > start ? selectedEnd : defaultEnd;
    setDraft({
      calendarId,
      title,
      description: "",
      descriptionContent: EMPTY_PLATE_NOTE_CONTENT,
      location: "",
      startLocal: toLocalDateTimeInput(start),
      endLocal: toLocalDateTimeInput(end),
      timeZone,
      allDay: false,
      reminderMinutesBefore: 0,
      availability: "busy",
      conflicts: [],
    });
  }, [timeZone, writableLocalCalendar]);

  const openEditDraft = useCallback((event: CalendarViewEvent, mode: CalendarDialogMode = "view") => {
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    const inclusiveAllDayEnd = event.allDay ? addCalendarDays(eventEnd, -1) : eventEnd;
    setMenu(undefined);
    setEventPreview(undefined);
    setRecurrenceOpen(false);
    setAttendeesExpanded(false);
    setDraftMode(mode);
    setDraft({
      id: event.id,
      calendarId: event.calendarId,
      title: event.title,
      description: event.description ?? "",
      descriptionContent: calendarDraftDescriptionContent(event.descriptionContent, event.description),
      location: event.location ?? "",
      startLocal: event.allDay ? toCalendarDateKey(eventStart) : toLocalDateTimeInput(eventStart),
      endLocal: event.allDay ? toCalendarDateKey(inclusiveAllDayEnd) : toLocalDateTimeInput(eventEnd),
      timeZone: event.timeZone ?? timeZone,
      allDay: event.allDay,
      reminderMinutesBefore: event.reminderMinutesBefore,
      availability: event.availability,
      recurrence: event.recurrence,
      recurrenceSeriesId: event.recurrenceSeriesId,
      recurrenceId: event.recurrenceId,
      conflicts: [],
    });
  }, [timeZone]);

  const updateCalendarDraft = (changes: Partial<CalendarEventDraft>) => {
    setDraft((current) => current ? { ...current, ...changes, conflicts: [] } : current);
  };

  const openRecurrenceSettings = () => {
    if (!draft) return;
    if (!draft.recurrence) {
      const start = new Date(draft.allDay ? `${draft.startLocal}T00:00` : draft.startLocal);
      const weekday = Number.isNaN(start.getTime())
        ? localIsoWeekday(new Date().toISOString(), draft.timeZone)
        : localIsoWeekday(start.toISOString(), draft.timeZone);
      updateCalendarDraft({
        recurrence: { frequency: "weekly", interval: 1, weekDays: [weekday], end: "never" },
      });
    }
    setRecurrenceOpen(true);
  };

  const updateRecurrence = (changes: Partial<CalendarRecurrenceRule>) => {
    if (!draft?.recurrence) return;
    const next = { ...draft.recurrence, ...changes };
    if (changes.frequency === "weekly" && !next.weekDays?.length) {
      const start = new Date(draft.allDay ? `${draft.startLocal}T00:00` : draft.startLocal);
      next.weekDays = [localIsoWeekday(start.toISOString(), draft.timeZone)];
    }
    updateCalendarDraft({ recurrence: next });
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
    const event = events.find((entry) => entry.id === initialEventId || entry.recurrenceSeriesId === initialEventId);
    openedInitialEvent.current = true;
    if (event) {
      openEditDraft(event);
      setFeedback("Der mit der Aufgabe verknüpfte Termin wurde geöffnet");
    } else {
      setFeedback("Der verknüpfte Termin wurde gelöscht oder liegt außerhalb des angezeigten Zeitraums");
    }
  }, [events, initialEventId, loading, openEditDraft]);

  const saveDraft = async (allowConflicts = false) => {
    if (!draft || busy) return;
    if (calendars.find((calendar) => calendar.id === draft.calendarId)?.readOnly) {
      setFeedback("Dieser Termin gehört zu einem schreibgeschützten Kalender und kann nicht geändert werden");
      return;
    }
    if (!draft.title.trim()) {
      setFeedback("Bitte geben Sie einen Titel für den Termin ein");
      return;
    }
    let start = new Date(draft.allDay ? `${draft.startLocal}T00:00` : draft.startLocal);
    let end = new Date(draft.allDay ? `${draft.endLocal}T00:00` : draft.endLocal);
    if (draft.allDay && !Number.isNaN(end.getTime())) end = addCalendarDays(end, 1);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setFeedback("Die Endzeit muss später als die Startzeit sein.");
      return;
    }
    let recurrenceScope = draft.recurrenceScope;
    if (draft.recurrenceSeriesId && !recurrenceScope) {
      recurrenceScope = await requestRecurrenceScope("Änderung", draft.title);
      if (!recurrenceScope) return;
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
          descriptionContent: draft.descriptionContent,
          location: draft.location.trim() || undefined,
          start: start.toISOString(),
          end: end.toISOString(),
          timeZone: draft.timeZone,
          allDay: draft.allDay,
          reminderMinutesBefore: draft.reminderMinutesBefore,
          recurrence: draft.recurrence ?? null,
          recurrenceSeriesId: draft.recurrenceSeriesId,
          recurrenceId: draft.recurrenceId,
          recurrenceScope,
          allowConflicts,
          idempotencyKey: draft.id ? undefined : `calendar-ui-${globalThis.crypto.randomUUID()}`,
        }),
      });
      const payload = await response.json() as { readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
      if (response.status === 409 && payload.conflicts?.length) {
        setDraft({ ...draft, recurrenceScope, conflicts: payload.conflicts });
        setFeedback("Der ausgewählte Zeitraum überschneidet sich mit einem bestehenden Termin");
        return;
      }
      if (!response.ok || !payload.event) throw new Error(payload.message || "Der Termin konnte nicht gespeichert werden");
      setDraft(undefined);
      setFeedback(draft.id ? "Termin aktualisiert" : "Termin erstellt");
      await loadEvents();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Der Termin konnte nicht gespeichert werden");
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async (event: CalendarViewEvent) => {
    if (calendars.find((calendar) => calendar.id === event.calendarId)?.readOnly) {
      setMenu(undefined);
      setFeedback("Dieser Termin gehört zu einem schreibgeschützten Kalender und kann nicht gelöscht werden");
      return;
    }
    if (busy) return;
    let recurrenceScope: CalendarRecurrenceEditScope | undefined;
    if (event.recurrenceSeriesId && event.recurrenceId) {
      recurrenceScope = await requestRecurrenceScope("Löschen", event.title);
      if (!recurrenceScope) return;
    } else if (!await appConfirm({
      title: `Termin „${event.title}“ löschen?`,
      description: "Dieses Kalenderereignis wird dauerhaft gelöscht.",
      confirmLabel: "Termin löschen",
      tone: "danger",
    })) {
      return;
    }
    setMenu(undefined);
    setBusy(true);
    try {
      const params = new URLSearchParams({ calendarId: event.calendarId });
      if (event.recurrenceSeriesId && event.recurrenceId) {
        params.set("recurrenceSeriesId", event.recurrenceSeriesId);
        params.set("recurrenceId", event.recurrenceId);
        params.set("scope", recurrenceScope ?? "occurrence");
      }
      const response = await fetch(`/api/calendar-events/${encodeURIComponent(event.id)}?${params}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "Kalenderereignis kann nicht gelöscht werden");
      setDraft(undefined);
      setFeedback("Termin gelöscht");
      await loadEvents();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Kalenderereignis kann nicht gelöscht werden");
    } finally {
      setBusy(false);
    }
  };

  const duplicateEvent = (event: CalendarViewEvent) => {
    const targetCalendar = writableLocalCalendar;
    if (!targetCalendar) {
      setMenu(undefined);
      setFeedback("Es ist kein beschreibbarer persönlicher Kalender verfügbar. Der Termin kann derzeit nicht kopiert werden");
      return;
    }
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    setMenu(undefined);
    setEventPreview(undefined);
    setDraftMode("edit");
    setDraft({
      calendarId: targetCalendar.id,
      title: `${event.title}(Kopie)`,
      description: event.description ?? "",
      descriptionContent: calendarDraftDescriptionContent(event.descriptionContent, event.description),
      location: event.location ?? "",
      startLocal: event.allDay ? toCalendarDateKey(eventStart) : toLocalDateTimeInput(eventStart),
      endLocal: event.allDay ? toCalendarDateKey(addCalendarDays(eventEnd, -1)) : toLocalDateTimeInput(eventEnd),
      timeZone: event.timeZone ?? timeZone,
      allDay: event.allDay,
      reminderMinutesBefore: event.reminderMinutesBefore ?? 0,
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
          title: `Sitzungsnotizen:${event.title}`.slice(0, 240),
          content: EMPTY_PLATE_NOTE_CONTENT,
          noteType: "meeting",
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly note?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "Meeting Notes können nicht erstellt werden");
      try {
        await createClientEntityLink({ sourceKind: "calendar", sourceId: event.recurrenceSeriesId ?? event.id, targetKind: "note", targetId: payload.note.id, relation: "meeting-note" });
      } catch (error) {
        await fetch(`/api/notes/${encodeURIComponent(payload.note.id)}`, { method: "DELETE" });
        throw error;
      }
      setRelatedVersion((current) => current + 1);
      openEditDraft(event);
      setFeedback("Meeting Notes werden erstellt und können von relevanten Inhalten aus geöffnet werden");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Meeting Notes können nicht erstellt werden");
    } finally {
      setBusy(false);
    }
  };

  const createEventTask = async (event: CalendarViewEvent, kind: "preparation" | "follow-up") => {
    if (busy) return;
    setMenu(undefined);
    setBusy(true);
    const prefix = kind === "preparation" ? "Vorbereitung" : "Folgemaßnahmen";
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${prefix}: ${event.title}`.slice(0, 240),
          notes: `Veranstaltung des Assoziationskalenders:${event.title}`,
          status: kind === "preparation" ? "next" : "inbox",
          important: false,
          urgencyMode: "auto",
          dueAt: kind === "preparation" ? event.start : undefined,
          estimatedMinutes: kind === "preparation" ? 30 : undefined,
        }),
      });
      const payload = await response.json() as { readonly ok?: boolean; readonly task?: { readonly id: string }; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? `kann nicht erstellt werden${prefix}Aufgabe`);
      try {
        await createClientEntityLink({ sourceKind: "calendar", sourceId: event.recurrenceSeriesId ?? event.id, targetKind: "task", targetId: payload.task.id, relation: kind });
      } catch (error) {
        await fetch(`/api/tasks/${encodeURIComponent(payload.task.id)}`, { method: "DELETE" });
        throw error;
      }
      setRelatedVersion((current) => current + 1);
      openEditDraft(event);
      setFeedback(`${prefix}Aufgabe erstellt und kann von relevanten Inhalten geöffnet werden`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : `kann nicht erstellt werden${prefix}Aufgabe`);
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
      if (slotCommand === "calendar.create-focus") openCreateDraft(start, "Zeit im Fokus");
    }
  };

  const scheduleDroppedTask = async (taskId: string, start: Date) => {
    if (taskDropBusy) return;
    const task = calendarTasks.find((item) => item.id === taskId);
    const calendar = calendars.find((item) => !item.readOnly && item.primary && item.providerData?.providerId === "local-calendar")
      ?? calendars.find((item) => !item.readOnly && item.providerData?.providerId === "local-calendar");
    if (!task || !calendar) {
      setFeedback("kein lokaler Kalender für Aufgabe oder Schreiben gefunden");
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
      if (response.status === 409 && payload.conflicts?.length) throw new Error("Dieser Zeitraum überschneidet sich mit einem Termin. Wählen Sie eine freie Zeit oder bestätigen Sie den Konflikt in den Aufgabendetails");
      if (!response.ok || !payload.task || !payload.event) throw new Error(payload.message ?? "Aufgabe kann nicht geplant werden");
      setCalendarTasks((current) => current.map((item) => item.id === payload.task!.id ? payload.task! : item));
      setEvents((current) => [...current.filter((item) => item.id !== payload.event!.id), payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(`Aufgabe „${task.title}“ eingeplant`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Aufgabe kann nicht geplant werden");
    } finally {
      setTaskDropBusy(false);
    }
  };

  const updateTaskTimeBlock = async (event: CalendarViewEvent, start: Date, end: Date, action: "bewegt" | "Anpassungszeit") => {
    if (taskDropBusy || !event.linkedTask) return;
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
        const conflictNames = result.payload.conflicts.slice(0, 3).map((conflict) => `„${conflict.title}“`).join(", ");
        if (!await appConfirm({
          title: "Zeitkonflikt mit bestehenden Terminen",
          description: `Der neue Zeitraum überschneidet sich mit ${conflictNames}. Soll der Aufgabenblock trotzdem ${action === "bewegt" ? "verschoben" : "angepasst"} werden?`,
          confirmLabel: action === "bewegt" ? "Trotzdem verschieben" : "Trotzdem anpassen",
        })) {
          setFeedback(action === "bewegt" ? "Verschieben abgebrochen" : "Anpassen abgebrochen");
          return;
        }
        result = await requestMove(true);
      }
      if (!result.response.ok || !result.payload.task || !result.payload.event) throw new Error(result.payload.message ?? "Zeitblock kann nicht eingestellt werden");
      setCalendarTasks((current) => current.map((item) => item.id === result.payload.task!.id ? result.payload.task! : item));
      setEvents((current) => [...current.filter((item) => item.id !== result.payload.event!.id), result.payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(action === "bewegt" ? `Aufgabe „${result.payload.task.title}“ verschoben` : `Dauer von „${result.payload.task.title}“ angepasst`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Zeitblock kann nicht eingestellt werden");
    } finally {
      setTaskDropBusy(false);
    }
  };

  const moveTaskTimeBlock = async (event: CalendarViewEvent, start: Date) => {
    const duration = Math.max(5 * 60_000, new Date(event.end).getTime() - new Date(event.start).getTime());
    await updateTaskTimeBlock(event, start, new Date(start.getTime() + duration), "bewegt");
  };

  const resizeTaskTimeBlock = async (event: CalendarViewEvent, end: Date) => {
    const start = new Date(event.start);
    await updateTaskTimeBlock(event, start, new Date(Math.max(start.getTime() + 5 * 60_000, end.getTime())), "Anpassungszeit");
  };

  const moveCalendarEvent = async (event: CalendarViewEvent, start: Date) => {
    if (event.linkedTask) {
      await moveTaskTimeBlock(event, start);
      return;
    }
    if (calendarMoveBusy) return;
    const calendar = calendars.find((item) => item.id === event.calendarId);
    const disabledReason = calendarEventWriteDisabledReason(event, calendar);
    if (disabledReason) {
      setFeedback(disabledReason);
      return;
    }
    const originalStart = new Date(event.start);
    const originalEnd = new Date(event.end);
    const duration = Math.max(5 * 60_000, originalEnd.getTime() - originalStart.getTime());
    const targetStart = new Date(start);
    if (event.allDay) targetStart.setHours(0, 0, 0, 0);
    const targetEnd = new Date(targetStart.getTime() + duration);
    if (targetStart.getTime() === originalStart.getTime()) return;
    let recurrenceScope: CalendarRecurrenceEditScope | undefined;
    if (event.recurrenceSeriesId && event.recurrenceId) {
      recurrenceScope = await requestRecurrenceScope("bewegt", event.title);
      if (!recurrenceScope) return;
    }
    setCalendarMoveBusy(true);
    setEventPreview(undefined);
    try {
      const requestMove = async (allowConflicts: boolean) => {
        const response = await fetch(`/api/calendar-events/${encodeURIComponent(event.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            calendarId: event.calendarId,
            title: event.title,
            description: event.description,
            descriptionContent: event.descriptionContent,
            location: event.location,
            start: targetStart.toISOString(),
            end: targetEnd.toISOString(),
            timeZone: event.timeZone ?? timeZone,
            allDay: event.allDay,
            recurrenceSeriesId: event.recurrenceSeriesId,
            recurrenceId: event.recurrenceId,
            recurrenceScope,
            allowConflicts,
          }),
        });
        const payload = await response.json() as { readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
        return { response, payload };
      };
      let result = await requestMove(false);
      if (result.response.status === 409 && result.payload.conflicts?.length) {
        const conflictNames = result.payload.conflicts.slice(0, 3).map((conflict) => `„${conflict.title}“`).join(", ");
        if (!await appConfirm({
          title: "Zeitkonflikt mit bestehenden Terminen",
          description: `Der neue Zeitraum überschneidet sich mit ${conflictNames}. Soll der Termin trotzdem verschoben werden?`,
          confirmLabel: "Trotzdem verschieben",
        })) {
          setFeedback("Verschieben des Termins abgebrochen");
          return;
        }
        result = await requestMove(true);
      }
      if (!result.response.ok || !result.payload.event) throw new Error(result.payload.message ?? "Kalenderereignis kann nicht verschoben werden");
      setEvents((current) => [...current.filter((item) => item.id !== result.payload.event!.id), result.payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(`Termin „${event.title}“ verschoben`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Kalenderereignis kann nicht verschoben werden");
    } finally {
      setCalendarMoveBusy(false);
    }
  };

  const resizeCalendarEvent = async (event: CalendarViewEvent, end: Date) => {
    if (event.linkedTask) {
      await resizeTaskTimeBlock(event, end);
      return;
    }
    if (calendarMoveBusy || event.allDay) return;
    const calendar = calendars.find((item) => item.id === event.calendarId);
    const disabledReason = calendarEventWriteDisabledReason(event, calendar);
    if (disabledReason) {
      setFeedback(disabledReason);
      return;
    }
    const targetStart = new Date(event.start);
    const originalEnd = new Date(event.end);
    const targetEnd = new Date(Math.max(targetStart.getTime() + 5 * 60_000, end.getTime()));
    if (targetEnd.getTime() === originalEnd.getTime()) return;
    let recurrenceScope: CalendarRecurrenceEditScope | undefined;
    if (event.recurrenceSeriesId && event.recurrenceId) {
      recurrenceScope = await requestRecurrenceScope("Änderung", event.title);
      if (!recurrenceScope) return;
    }
    setCalendarMoveBusy(true);
    setEventPreview(undefined);
    try {
      const requestResize = async (allowConflicts: boolean) => {
        const response = await fetch(`/api/calendar-events/${encodeURIComponent(event.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            calendarId: event.calendarId,
            title: event.title,
            description: event.description,
            descriptionContent: event.descriptionContent,
            location: event.location,
            start: targetStart.toISOString(),
            end: targetEnd.toISOString(),
            timeZone: event.timeZone ?? timeZone,
            allDay: false,
            recurrenceSeriesId: event.recurrenceSeriesId,
            recurrenceId: event.recurrenceId,
            recurrenceScope,
            allowConflicts,
          }),
        });
        const payload = await response.json() as { readonly event?: CalendarViewEvent; readonly conflicts?: readonly TaskScheduleConflict[]; readonly message?: string };
        return { response, payload };
      };
      let result = await requestResize(false);
      if (result.response.status === 409 && result.payload.conflicts?.length) {
        const conflictNames = result.payload.conflicts.slice(0, 3).map((conflict) => `„${conflict.title}“`).join(", ");
        if (!await appConfirm({
          title: "Zeitkonflikt mit bestehenden Terminen",
          description: `Der angepasste Zeitraum überschneidet sich mit ${conflictNames}. Soll die Termindauer trotzdem geändert werden?`,
          confirmLabel: "Trotzdem anpassen",
        })) {
          setFeedback("Terminanpassung abgebrochen");
          return;
        }
        result = await requestResize(true);
      }
      if (!result.response.ok || !result.payload.event) throw new Error(result.payload.message ?? "Die Termindauer konnte nicht angepasst werden");
      setEvents((current) => [...current.filter((item) => item.id !== result.payload.event!.id), result.payload.event!].sort((left, right) => left.start.localeCompare(right.start)));
      setFeedback(`Dauer von „${event.title}“ angepasst`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Die Termindauer konnte nicht angepasst werden");
    } finally {
      setCalendarMoveBusy(false);
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
            <button className="secondary-button" aria-label={viewMode === "week" ? "letzte Woche" : "letzten Monat"} onClick={() => setAnchorDate(moveCalendarPeriod(anchorDate, viewMode, -1))}>‹</button>
            <button className="secondary-button" onClick={() => setAnchorDate(new Date())}>Heute</button>
            <button className="secondary-button" aria-label={viewMode === "week" ? "Nächste Woche" : "nächsten Monat"} onClick={() => setAnchorDate(moveCalendarPeriod(anchorDate, viewMode, 1))}>›</button>
          </div>
          <strong>{viewMode === "week" ? formatCalendarWeekRange(visibleRange.start, visibleRange.end) : formatCalendarMonth(anchorDate)}</strong>
          <div className="calendar-toolbar-actions">
            <div className="calendar-view-switch" role="group" aria-label="Kalenderansicht">
              <button className={viewMode === "week" ? "active" : ""} aria-pressed={viewMode === "week"} onClick={() => changeViewMode("week")}>Woche</button>
              <button className={viewMode === "month" ? "active" : ""} aria-pressed={viewMode === "month"} onClick={() => changeViewMode("month")}>Monat</button>
            </div>
            <button className="primary-button" onClick={() => openCreateDraft()}><Plus size={15} />Neuer Zeitplan</button>
          </div>
        </div>
        <div className="calendar-source-row"><div>{calendars.map((calendar) => <span key={calendar.id}><i style={{ background: calendar.color ?? "#86bdf5" }} />{calendar.name}{calendar.readOnly ? " · Nur lesen" : ""}</span>)}</div><small>{timeZone}</small></div>
        {viewMode === "week" && unscheduledTasks.length > 0 && <section className="calendar-task-shelf" aria-label="noch zu planen"><header><div><ListChecks size={15} /><strong>noch zu planen</strong></div><small>{taskDropBusy ? "Wir arrangieren..." : <><span className="desktop-hint">Ziehen Sie in den Kalender oder klicken Sie auf die Auswahlzeit</span><span className="mobile-hint">Klicken Sie auf Aufgabenauswahlzeit</span></>}</small></header><div>{unscheduledTasks.map((task) => <Link href={`/tasks?schedule=${encodeURIComponent(task.id)}`} draggable={!taskDropBusy} key={task.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-kalender-task", task.id); }}><span>{task.title}</span>{task.estimatedMinutes && <em>{formatTaskEstimate(task.estimatedMinutes)}</em>}</Link>)}</div></section>}
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
            moveBusy={calendarMoveBusy || taskDropBusy}
            onMoveEvent={(event, startsAt) => void moveCalendarEvent(event, startsAt)}
            onResizeEvent={(event, endsAt) => void resizeCalendarEvent(event, endsAt)}
          />
        ) : (
          <CalendarMonthView
            anchorDate={anchorDate}
            calendars={calendars}
            events={events}
            loading={loading}
            rangeStart={visibleRange.start}
            onOpenWeek={openWeekForDate}
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
            moveBusy={calendarMoveBusy || taskDropBusy}
            onMoveEvent={(event, startsAt) => void moveCalendarEvent(event, startsAt)}
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
                <h2 className="calendar-edit-dialog-title" id="calendar-dialog-title">{draft.id ? "Termin bearbeiten" : "Neuer Termin"}</h2>
              ) : (
                <div className="calendar-event-dialog-heading">
                  <span className={`calendar-event-badge ${draftReadOnly ? "protected" : ""}`}>
                    {draftReadOnly ? <ShieldCheck size={14} /> : <CalendarDays size={14} />}
                    {draftReadOnly ? "geschützt" : draftCalendar?.name ?? "Details zur Veranstaltung im Kalender"}
                  </span>
                  <h2 id="calendar-dialog-title">{draft.title}</h2>
                </div>
              )}
              <button aria-label="Schließen" onClick={() => setDraft(undefined)} disabled={busy && draftEditing}><X size={20} /></button>
            </header>
            {draftEditing ? <>
              <div className="calendar-form calendar-modern-form">
                <label className="calendar-title-field">
                  <i className="calendar-title-dot" aria-hidden="true" style={{ background: draftCalendar?.color ?? "#86bdf5" }} />
                  <input aria-label="Titel der Veranstaltung im Kalender" autoFocus value={draft.title} maxLength={200} placeholder="Titel hinzufügen" onChange={(event) => updateCalendarDraft({ title: event.target.value })} />
                </label>
                <div className="calendar-schedule-card">
                  <div className="calendar-schedule-row">
                    <span className="calendar-schedule-icon" aria-hidden="true"><CalendarDays size={18} /></span>
                    <DateTimeField
                      className="calendar-schedule-field"
                      ariaLabel={draft.allDay ? "Anfangsdatum" : "Startzeit"}
                      mode={draft.allDay ? "date" : "datetime"}
                      value={draft.startLocal}
                      onChange={(startLocal) => updateCalendarDraft({ startLocal })}
                    />
                    <ArrowRight className="calendar-schedule-arrow" size={16} strokeWidth={1.7} aria-hidden="true" />
                    <DateTimeField
                      className="calendar-schedule-field"
                      ariaLabel={draft.allDay ? "Enddatum (einschließlich)" : "Endzeit"}
                      mode={draft.allDay ? "date" : "datetime"}
                      min={draft.allDay ? draft.startLocal : undefined}
                      value={draft.endLocal}
                      onChange={(endLocal) => updateCalendarDraft({ endLocal })}
                    />
                    <small className="calendar-schedule-duration"><Clock3 size={12} />{formatCalendarDetailDuration(draft)}</small>
                    <div className="calendar-reminder-control">
                      <Select
                        value={draft.reminderMinutesBefore === undefined ? "default" : String(draft.reminderMinutesBefore)}
                        onValueChange={(value) => updateCalendarDraft({
                          reminderMinutesBefore: value === "default" ? undefined : Number(value) as CalendarEventReminderMinutes,
                        })}
                      >
                        <SelectTrigger className="calendar-reminder-select-trigger" aria-label="Erinnerungszeit">
                          <BellRing size={14} aria-hidden="true" />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="calendar-reminder-select-content" position="popper" align="end" sideOffset={6}>
                          <SelectItem className="calendar-reminder-select-item" value="default">Desktop-Standardeinstellungen verwenden</SelectItem>
                          <SelectItem className="calendar-reminder-select-item" value="0">Keine Erinnerung</SelectItem>
                          <SelectItem className="calendar-reminder-select-item" value="5">5 Minuten im Voraus</SelectItem>
                          <SelectItem className="calendar-reminder-select-item" value="15">15 Minuten im Voraus</SelectItem>
                          <SelectItem className="calendar-reminder-select-item" value="30">30 Minuten im Voraus</SelectItem>
                          <SelectItem className="calendar-reminder-select-item" value="60">1 Stunde im Voraus</SelectItem>
                          <SelectItem className="calendar-reminder-select-item" value="1440">1 Tag im Voraus</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <label className="calendar-all-day-switch">
                      <span>Ganztägig</span>
                      <input aria-label="Ganztags-Kalenderveranstaltung" type="checkbox" checked={draft.allDay} onChange={(event) => changeCalendarAllDay(event.target.checked)} />
                      <i aria-hidden="true"><b /></i>
                    </label>
                  </div>
                </div>
                <div className="calendar-edit-meta">
                  <div className="calendar-meta-field calendar-select-field">
                    <Select disabled={Boolean(draft.id)} value={draft.calendarId} onValueChange={(calendarId) => updateCalendarDraft({ calendarId })}>
                      <SelectTrigger className="calendar-calendar-select-trigger" aria-label="Kalender">
                        <SelectValue>
                          <span className="calendar-calendar-select-value">
                            <i className="calendar-meta-dot" aria-hidden="true" style={{ background: draftCalendar?.color ?? "#86bdf5" }} />
                            <span>{draftCalendar?.name ?? "Kalender auswählen"}</span>
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="calendar-calendar-select-content" position="popper" align="start" sideOffset={6}>
                        {calendars.map((calendar) => (
                          <SelectItem className="calendar-calendar-select-item" value={calendar.id} key={calendar.id}>
                            <span className="calendar-calendar-select-item-content">
                              <i className="calendar-meta-dot" aria-hidden="true" style={{ background: calendar.color ?? "#86bdf5" }} />
                              <span>{calendar.name}</span>
                              {calendar.readOnly && <small>Schreibgeschützt</small>}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="calendar-meta-field">
                    <MapPin size={18} aria-hidden="true" />
                    <input aria-label="Standort" value={draft.location} maxLength={500} placeholder="Standort hinzufügen" onChange={(event) => updateCalendarDraft({ location: event.target.value })} />
                  </label>
                </div>
                {draftCalendar?.providerData?.providerId === "local-calendar" && (
                  <div className="calendar-recurrence-control">
                    <button
                      type="button"
                      className={`calendar-recurrence-trigger ${draft.recurrence ? "active" : ""}`}
                      aria-expanded={recurrenceOpen}
                      onClick={() => draft.recurrence ? setRecurrenceOpen((current) => !current) : openRecurrenceSettings()}
                    >
                      <Repeat2 size={18} />
                      <span>{draft.recurrence ? calendarRecurrenceSummary(draft.recurrence) : "Keine Wiederholung"}</span>
                      <ChevronRight className={recurrenceOpen ? "open" : ""} size={17} />
                    </button>
                    {recurrenceOpen && draft.recurrence && (
                      <section className="calendar-recurrence-panel" aria-label="Doppelte Einstellungen">
                        <header>
                          <strong>Doppelte Einstellungen</strong>
                          <button type="button" onClick={() => setRecurrenceOpen(false)}>Erledigt</button>
                        </header>
                        <div className="calendar-recurrence-row">
                          <span>Häufigkeit</span>
                          <div className="calendar-recurrence-segments">
                            {([
                              ["daily", "täglich"],
                              ["weekly", "wöchentlich"],
                              ["monthly", "monatlich"],
                              ["yearly", "jährlich"],
                            ] as const).map(([frequency, label]) => (
                              <button
                                type="button"
                                className={draft.recurrence!.frequency === frequency ? "active" : ""}
                                onClick={() => updateRecurrence({ frequency })}
                                key={frequency}
                              >{label}</button>
                            ))}
                          </div>
                        </div>
                        <div className="calendar-recurrence-row compact">
                          <span>jeweils</span>
                          <div className="calendar-recurrence-interval">
                            <input
                              aria-label="wiederholte Intervalle"
                              type="number"
                              min={1}
                              max={99}
                              value={draft.recurrence.interval}
                              onChange={(event) => updateRecurrence({ interval: Math.max(1, Math.min(99, Number(event.target.value) || 1)) })}
                            />
                            <span>{recurrenceUnitLabel(draft.recurrence.frequency)}</span>
                          </div>
                        </div>
                        {draft.recurrence.frequency === "weekly" && (
                          <div className="calendar-recurrence-row">
                            <span>Duplikat aus</span>
                            <div className="calendar-recurrence-weekdays">
                              {["I. ENTWICKLUNG DER RECHTSVORSCHRIFTEN", "II.", "III. ENTWICKLUNG DER ENTWICKLUNG DER ENTWICKLUNG DER", "IV", "Fünf", "Sechs", "Tag"].map((label, index) => {
                                const day = index + 1;
                                const active = draft.recurrence!.weekDays?.includes(day);
                                return (
                                  <button
                                    type="button"
                                    className={active ? "active" : ""}
                                    aria-pressed={active}
                                    onClick={() => {
                                      const selected = draft.recurrence!.weekDays ?? [];
                                      const next = active ? selected.filter((item) => item !== day) : [...selected, day].sort();
                                      if (next.length) updateRecurrence({ weekDays: next });
                                    }}
                                    key={day}
                                  >{label}</button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        <div className="calendar-recurrence-row">
                          <span>Ende</span>
                          <div className="calendar-recurrence-end">
                            <label><input type="radio" name="recurrence-end" checked={draft.recurrence.end === "never"} onChange={() => updateRecurrence({ end: "never", until: undefined, count: undefined })} />Niemals</label>
                            <label><input type="radio" name="recurrence-end" checked={draft.recurrence.end === "until"} onChange={() => updateRecurrence({ end: "until", until: recurrenceDefaultUntil(draft), count: undefined })} />Datum angeben</label>
                            <label><input type="radio" name="recurrence-end" checked={draft.recurrence.end === "count"} onChange={() => updateRecurrence({ end: "count", count: 10, until: undefined })} />Anzahl der Wiederholungen</label>
                          </div>
                        </div>
                        {draft.recurrence.end === "until" && (
                          <div className="calendar-recurrence-detail">
                            <span>Enddatum</span>
                            <DateTimeField
                              className="calendar-recurrence-date-field"
                              ariaLabel="Datum des erneuten Endes"
                              mode="date"
                              min={toCalendarDateKey(recurrenceMinimumDate(draft))}
                              value={recurrenceUntilDateKey(draft.recurrence.until)}
                              onChange={(dateValue) => updateRecurrence({ until: recurrenceUntilIso(dateValue) })}
                              placeholder={formatRecurrenceEndDate(draft.recurrence.until)}
                            />
                          </div>
                        )}
                        {draft.recurrence.end === "count" && (
                          <div className="calendar-recurrence-detail">
                            <span>Anzahl der Wiederholungen</span>
                            <input type="number" min={1} max={999} value={draft.recurrence.count ?? 10} onChange={(event) => updateRecurrence({ count: Math.max(1, Math.min(999, Number(event.target.value) || 1)) })} />
                            <small>2-mal</small>
                          </div>
                        )}
                        <div className="calendar-recurrence-preview">
                          <span>Der Nächste:</span>
                          <strong>{formatRecurrencePreview(draft)}</strong>
                        </div>
                        {!draft.recurrenceSeriesId && <button type="button" className="calendar-recurrence-clear" onClick={() => { updateCalendarDraft({ recurrence: undefined }); setRecurrenceOpen(false); }}>ohne Wiederholung ersetzen</button>}
                      </section>
                    )}
                  </div>
                )}
                <div className="calendar-description calendar-rich-description">
                  <NotebookPen size={18} aria-hidden="true" />
                  <CalendarDescriptionEditor
                    eventKey={draft.recurrenceSeriesId ?? draft.id ?? "new-calendar-event"}
                    content={draft.descriptionContent}
                    onChange={(descriptionContent) => updateCalendarDraft({
                      descriptionContent,
                      description: noteContentToPlainText(descriptionContent),
                    })}
                  />
                </div>
                {draft.id && <ProjectAssociationControl kind="calendar" entityId={draft.recurrenceSeriesId ?? draft.id} onChanged={() => setRelatedVersion((current) => current + 1)} />}
                {draft.id && <RelatedContentPanel kind="calendar" entityId={draft.recurrenceSeriesId ?? draft.id} refreshKey={relatedVersion} hideWhenEmpty />}
              </div>
              {draft.conflicts.length > 0 && <div className="task-schedule-conflicts calendar-dialog-conflicts" role="alert"><header><AlertCircle size={16} /><strong>Zeitkonflikt erkannt</strong></header>{draft.conflicts.map((conflict) => <div key={conflict.id}><span>{formatTaskBlockRange(conflict.start, conflict.end)}</span><strong>{conflict.title}</strong></div>)}<p>Sie können entweder die Änderungszeit zurückgeben oder bestätigen, dass Sie sie noch speichern.</p></div>}
            </> : <div className="calendar-detail-content">
              <div className="calendar-detail-time">
                <div><span className="calendar-detail-icon calendar-detail-icon-date"><CalendarDays size={17} /></span><strong>{formatCalendarDetailDate(draft)}</strong></div>
                <div><span className="calendar-detail-icon calendar-detail-icon-time"><Clock3 size={17} /></span><strong>{formatCalendarDetailTime(draft)}</strong><small>{formatCalendarDetailDuration(draft)}</small></div>
              </div>
              <div className="calendar-detail-meta">
                <div><span className="calendar-detail-icon"><CalendarDays size={15} /></span><strong>{draftCalendar?.name ?? "Kalender"}</strong></div>
                {calendarAvailabilityLabel(draft.availability) && <div className={draft.availability === "oof" ? "calendar-detail-availability oof" : "calendar-detail-availability"}><span className="calendar-detail-icon"><Circle size={15} /></span><strong>angezeigt als:{calendarAvailabilityLabel(draft.availability)}</strong></div>}
                {draft.location && <div><span className="calendar-detail-icon"><MapPin size={15} /></span><strong>{draft.location}</strong></div>}
                {draft.recurrence && <div><span className="calendar-detail-icon"><Repeat2 size={15} /></span><strong>{calendarRecurrenceSummary(draft.recurrence)}</strong></div>}
                <div><span className="calendar-detail-icon"><BellRing size={15} /></span><strong>{formatCalendarReminder(draft.reminderMinutesBefore)}</strong></div>
              </div>
              {draftWriteDisabledReason && <div className="calendar-detail-notice" role="note"><ShieldCheck size={14} /><span>{draftWriteDisabledReason}</span></div>}
              {draftEvent?.attendees?.length ? (
                <CalendarAttendeeList
                  attendees={draftEvent.attendees}
                  expanded={attendeesExpanded}
                  onToggle={() => setAttendeesExpanded((current) => !current)}
                  onCompose={(address) => router.push(`/inbox?compose=true&to=${encodeURIComponent(address)}`)}
                  onOpenCorrespondence={(address) => router.push(`/inbox?correspondent=${encodeURIComponent(address)}`)}
                  onFeedback={setFeedback}
                />
              ) : null}
              {draft.description.trim() && (
                <section className="calendar-detail-notes">
                  <h3>Notizen</h3>
                  <CalendarDescriptionView
                    eventKey={draft.recurrenceSeriesId ?? draft.id ?? "calendar-event"}
                    content={draft.descriptionContent}
                  />
                </section>
              )}
              {draft.id && <ProjectAssociationControl kind="calendar" entityId={draft.recurrenceSeriesId ?? draft.id} onChanged={() => setRelatedVersion((current) => current + 1)} />}
              {draft.id && <RelatedContentPanel kind="calendar" entityId={draft.recurrenceSeriesId ?? draft.id} refreshKey={relatedVersion} hideWhenEmpty />}
            </div>}
            {(draftEditing || !draftReadOnly) && <footer className={draftEditing ? "calendar-edit-footer" : "calendar-detail-footer"}>
              {draftEditing && draft.id ? <button className="ghost-button danger-button" disabled={busy} onClick={() => { const event = events.find((item) => item.id === draft.id); if (event) void deleteEvent(event); }}><Trash2 size={15} />Löschen</button> : null}
              <div>{draftEditing ? <>
                <button className="secondary-button" disabled={busy} onClick={() => { if (draftEvent) openEditDraft(draftEvent, "view"); else setDraft(undefined); }}>Abbrechen</button>
                <button className={draft.conflicts.length ? "danger-confirm-button" : "primary-button"} disabled={busy} onClick={() => void saveDraft(draft.conflicts.length > 0)}>{busy && <LoaderCircle className="spin" size={15} />}{draft.conflicts.length ? "Trotzdem speichern" : draft.id ? "Änderungen speichern" : "Termin erstellen"}</button>
              </> : <>
                <button className="secondary-button" onClick={() => setDraftMode("edit")}><Pencil size={14} />Bearbeiten</button>
              </>}</div>
            </footer>}
          </section>
        </div>
      )}

      {recurrenceScopePrompt && (
        <div className="calendar-recurrence-scope-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) resolveRecurrenceScope(undefined); }}>
          <section className="calendar-recurrence-scope-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-recurrence-scope-title">
            <header>
              <div>
                <h2 id="calendar-recurrence-scope-title">{recurrenceScopePrompt.action}Doppelter Zeitplan</h2>
                <p>{recurrenceScopePrompt.title}</p>
              </div>
              <button aria-label="Schließen" onClick={() => resolveRecurrenceScope(undefined)}><X size={18} /></button>
            </header>
            <div className="calendar-recurrence-scope-options">
              <button onClick={() => resolveRecurrenceScope("occurrence")}><strong>nur dies</strong><small>Sonstige Termine bleiben unverändert</small></button>
              <button className="recommended" onClick={() => resolveRecurrenceScope("following")}><strong>dies und darüber hinaus</strong><small>das vorherige Kalenderereignis bleibt unverändert</small></button>
              <button onClick={() => resolveRecurrenceScope("series")}><strong>gesamte Serie</strong><small>Anwenden auf alle Termine dieser Reihe</small></button>
            </div>
            <footer><button className="secondary-button" onClick={() => resolveRecurrenceScope(undefined)}>Abbrechen</button></footer>
          </section>
        </div>
      )}

      {menu && contextCommands.length > 0 && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          ariaLabel={contextEvent ? `Planung:${contextEvent.title}` : "Freizeitbetrieb"}
          commands={contextCommands}
          heading={contextEvent?.title ?? (menu.kind === "slot" ? formatCalendarSlotHeading(menu.startsAt) : "Freizeit")}
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
  readonly onCreate: (start: Date, title?: string, end?: Date) => void;
  readonly onEdit: (event: CalendarViewEvent) => void;
  readonly previewEventId?: string;
  readonly onPreviewEvent: (event: CalendarViewEvent, anchor: HTMLElement) => void;
  readonly onClearEventPreview: () => void;
  readonly onOpenEventMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void;
  readonly onOpenSlotMenu: (startsAt: Date, x: number, y: number, returnFocus: HTMLElement) => void;
  readonly onDropTask?: (taskId: string, startsAt: Date) => void;
  readonly moveBusy?: boolean;
  readonly onMoveEvent?: (event: CalendarViewEvent, startsAt: Date) => void;
  readonly onResizeEvent?: (event: CalendarViewEvent, endsAt: Date) => void;
}

const weekVisibleStartHour = 7;
const weekVisibleEndHour = 22;
const weekHourHeight = 60;
const weekSelectionStepMinutes = 5;

function formatTimelineMinutes(offsetMinutes: number): string {
  const totalMinutes = weekVisibleStartHour * 60 + offsetMinutes;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

interface CalendarTimeSelection {
  readonly anchorDayIndex: number;
  readonly currentDayIndex: number;
  readonly pointerId: number;
  readonly anchorMinutes: number;
  readonly currentMinutes: number;
}

interface CalendarEventDropPreview {
  readonly dayIndex: number;
  readonly startMinutes: number;
  readonly durationMinutes: number;
  readonly title: string;
}

interface CalendarEventResizePreview {
  readonly eventId: string;
  readonly pointerId: number;
  readonly start: Date;
  readonly originalEnd: Date;
  readonly end: Date;
}

interface CalendarSpanPlacement {
  readonly event: CalendarViewEvent;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly lane: number;
}

function layoutCalendarSpanEvents(
  events: readonly CalendarViewEvent[],
  days: readonly Date[],
): readonly CalendarSpanPlacement[] {
  const segments = events.flatMap((event) => {
    const columns = days
      .map((day, index) => calendarEventOverlapsDay(event, day) ? index : -1)
      .filter((index) => index >= 0);
    if (!columns.length) return [];
    return [{ event, startColumn: columns[0]!, endColumn: columns[columns.length - 1]! + 1 }];
  }).sort((left, right) => left.startColumn - right.startColumn || right.endColumn - left.endColumn);
  const laneEnds: number[] = [];
  return segments.map((segment) => {
    let lane = laneEnds.findIndex((endColumn) => endColumn <= segment.startColumn);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = segment.endColumn;
    return { ...segment, lane };
  });
}

function calendarSpanLaneCount(placements: readonly CalendarSpanPlacement[]): number {
  return placements.reduce((count, placement) => Math.max(count, placement.lane + 1), 0);
}

function calendarEventSpansMultipleDays(event: CalendarViewEvent): boolean {
  const start = new Date(event.start);
  const inclusiveEnd = new Date(new Date(event.end).getTime() - 1);
  return start.toDateString() !== inclusiveEnd.toDateString();
}

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
  moveBusy = false,
  onMoveEvent,
  onResizeEvent,
}: CalendarViewCommonProps & { readonly weekStart: Date }) {
  const [currentTime, setCurrentTime] = useState<Date>();
  const [timeSelection, setTimeSelection] = useState<CalendarTimeSelection>();
  const [draggedEventId, setDraggedEventId] = useState("");
  const [draggedEventOffsetMinutes, setDraggedEventOffsetMinutes] = useState(0);
  const [eventDropPreview, setEventDropPreview] = useState<CalendarEventDropPreview>();
  const [eventResizePreview, setEventResizePreview] = useState<CalendarEventResizePreview>();
  const timeSelectionRef = useRef<CalendarTimeSelection | undefined>(undefined);
  const eventResizeRef = useRef<CalendarEventResizePreview | undefined>(undefined);
  const suppressLaneClickRef = useRef(false);
  const suppressEventClickRef = useRef(false);
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(weekStart, index));
  const hours = Array.from({ length: weekVisibleEndHour - weekVisibleStartHour + 1 }, (_, index) => weekVisibleStartHour + index);
  const timelineHeight = (weekVisibleEndHour - weekVisibleStartHour) * weekHourHeight;
  const currentMinutes = currentTime ? currentTime.getHours() * 60 + currentTime.getMinutes() + currentTime.getSeconds() / 60 : undefined;
  const currentTimeTop = currentMinutes === undefined
    ? undefined
    : ((currentMinutes - weekVisibleStartHour * 60) / 60) * weekHourHeight;
  const currentTimeVisible = currentTimeTop !== undefined && currentTimeTop >= 0 && currentTimeTop <= timelineHeight;
  const allDayPlacements = layoutCalendarSpanEvents(events.filter((event) => event.allDay), days);
  const allDayLaneCount = calendarSpanLaneCount(allDayPlacements);
  const oofDayKeys = new Set(
    days
      .filter((day) => events.some((event) => event.allDay && event.availability === "oof" && calendarEventOverlapsDay(event, day)))
      .map(toCalendarDateKey),
  );

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

  const minutesFromPointer = (target: HTMLElement, clientY: number, allowEnd = false) => {
    const bounds = target.getBoundingClientRect();
    const rawMinutes = ((clientY - bounds.top) / weekHourHeight) * 60;
    const roundedMinutes = Math.round(rawMinutes / weekSelectionStepMinutes) * weekSelectionStepMinutes;
    const maximum = (weekVisibleEndHour - weekVisibleStartHour) * 60 - (allowEnd ? 0 : weekSelectionStepMinutes);
    return Math.max(0, Math.min(roundedMinutes, maximum));
  };

  const dateFromTimelineMinutes = (day: Date, minutes: number) => {
    const start = new Date(day);
    start.setHours(weekVisibleStartHour, minutes, 0, 0);
    return start;
  };

  const slotFromPointer = (day: Date, target: HTMLElement, clientY: number) =>
    dateFromTimelineMinutes(day, minutesFromPointer(target, clientY));

  const eventSlotFromPointer = (day: Date, target: HTMLElement, clientY: number) => {
    const pointerMinutes = minutesFromPointer(target, clientY);
    const startMinutes = Math.max(0, pointerMinutes - draggedEventOffsetMinutes);
    return dateFromTimelineMinutes(day, startMinutes);
  };

  const dayIndexFromPointer = (target: HTMLElement, clientX: number) => {
    const grid = target.closest<HTMLElement>(".calendar-week-grid");
    if (!grid) return 0;
    const bounds = grid.getBoundingClientRect();
    const relativeX = Math.max(0, Math.min(clientX - bounds.left, Math.max(0, bounds.width - 1)));
    return Math.max(0, Math.min(6, Math.floor(relativeX / (bounds.width / 7))));
  };

  const selectionRange = (selection: CalendarTimeSelection) => {
    const anchor = dateFromTimelineMinutes(days[selection.anchorDayIndex], selection.anchorMinutes);
    const current = dateFromTimelineMinutes(days[selection.currentDayIndex], selection.currentMinutes);
    if (anchor.getTime() === current.getTime()) {
      return {
        start: anchor,
        end: dateFromTimelineMinutes(
          days[selection.anchorDayIndex],
          Math.min(selection.anchorMinutes + 30, (weekVisibleEndHour - weekVisibleStartHour) * 60),
        ),
      };
    }
    return anchor < current ? { start: anchor, end: current } : { start: current, end: anchor };
  };

  const selectionSegmentForDay = (day: Date, selection: CalendarTimeSelection) => {
    const range = selectionRange(selection);
    const visibleStart = new Date(day);
    visibleStart.setHours(weekVisibleStartHour, 0, 0, 0);
    const visibleEnd = new Date(day);
    visibleEnd.setHours(weekVisibleEndHour, 0, 0, 0);
    const segmentStart = Math.max(range.start.getTime(), visibleStart.getTime());
    const segmentEnd = Math.min(range.end.getTime(), visibleEnd.getTime());
    if (segmentStart >= segmentEnd) return undefined;
    return {
      startMinutes: (segmentStart - visibleStart.getTime()) / 60_000,
      endMinutes: (segmentEnd - visibleStart.getTime()) / 60_000,
      range,
    };
  };

  const setActiveTimeSelection = (selection: CalendarTimeSelection | undefined) => {
    timeSelectionRef.current = selection;
    setTimeSelection(selection);
  };

  const beginTimeSelection = (event: ReactPointerEvent<HTMLDivElement>, dayIndex: number) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".calendar-week-event")) return;
    const anchorMinutes = minutesFromPointer(event.currentTarget, event.clientY);
    const selection = { anchorDayIndex: dayIndex, currentDayIndex: dayIndex, pointerId: event.pointerId, anchorMinutes, currentMinutes: anchorMinutes };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressLaneClickRef.current = false;
    onClearEventPreview();
    setActiveTimeSelection(selection);
  };

  const updateTimeSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = timeSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const viewport = event.currentTarget.closest<HTMLElement>(".calendar-week-viewport");
    if (viewport) {
      const viewportBounds = viewport.getBoundingClientRect();
      if (event.clientY < viewportBounds.top + 34) viewport.scrollTop -= 12;
      else if (event.clientY > viewportBounds.bottom - 34) viewport.scrollTop += 12;
    }
    const nextDayIndex = dayIndexFromPointer(event.currentTarget, event.clientX);
    const nextMinutes = minutesFromPointer(event.currentTarget, event.clientY, true);
    if (nextMinutes === current.currentMinutes && nextDayIndex === current.currentDayIndex) return;
    setActiveTimeSelection({ ...current, currentDayIndex: nextDayIndex, currentMinutes: nextMinutes });
  };

  const finishTimeSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = timeSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const finalDayIndex = dayIndexFromPointer(event.currentTarget, event.clientX);
    const finalMinutes = minutesFromPointer(event.currentTarget, event.clientY, true);
    const finalSelection = { ...current, currentDayIndex: finalDayIndex, currentMinutes: finalMinutes };
    const range = selectionRange(finalSelection);
    suppressLaneClickRef.current = true;
    window.setTimeout(() => { suppressLaneClickRef.current = false; }, 0);
    setActiveTimeSelection(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (range.end > range.start) onCreate(range.start, "", range.end);
  };

  const cancelTimeSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = timeSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    suppressLaneClickRef.current = true;
    window.setTimeout(() => { suppressLaneClickRef.current = false; }, 0);
    setActiveTimeSelection(undefined);
  };

  const setActiveEventResize = (preview: CalendarEventResizePreview | undefined) => {
    eventResizeRef.current = preview;
    setEventResizePreview(preview);
  };

  const beginEventResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>, calendarEvent: CalendarViewEvent) => {
    if (!onResizeEvent || moveBusy || calendarEventSpansMultipleDays(calendarEvent)) return;
    if (pointerEvent.pointerType === "mouse" && pointerEvent.button !== 0) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
    suppressEventClickRef.current = true;
    onClearEventPreview();
    setActiveEventResize({
      eventId: calendarEvent.id,
      pointerId: pointerEvent.pointerId,
      start: new Date(calendarEvent.start),
      originalEnd: new Date(calendarEvent.end),
      end: new Date(calendarEvent.end),
    });
  };

  const updateEventResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>, day: Date) => {
    const current = eventResizeRef.current;
    if (!current || current.pointerId !== pointerEvent.pointerId) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const lane = pointerEvent.currentTarget.closest<HTMLElement>(".calendar-time-lane");
    if (!lane) return;
    const viewport = lane.closest<HTMLElement>(".calendar-week-viewport");
    if (viewport) {
      const viewportBounds = viewport.getBoundingClientRect();
      if (pointerEvent.clientY < viewportBounds.top + 34) viewport.scrollTop -= 12;
      else if (pointerEvent.clientY > viewportBounds.bottom - 34) viewport.scrollTop += 12;
    }
    const candidateEnd = dateFromTimelineMinutes(day, minutesFromPointer(lane, pointerEvent.clientY, true));
    const minimumEnd = current.start.getTime() + weekSelectionStepMinutes * 60_000;
    const next = { ...current, end: new Date(Math.max(minimumEnd, candidateEnd.getTime())) };
    setActiveEventResize(next);
  };

  const finishEventResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>, day: Date) => {
    updateEventResize(pointerEvent, day);
    const current = eventResizeRef.current;
    if (!current || current.pointerId !== pointerEvent.pointerId) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    if (pointerEvent.currentTarget.hasPointerCapture(pointerEvent.pointerId)) pointerEvent.currentTarget.releasePointerCapture(pointerEvent.pointerId);
    setActiveEventResize(undefined);
    if (current.end.getTime() !== current.originalEnd.getTime()) {
      const resizedEvent = events.find((item) => item.id === current.eventId);
      if (resizedEvent) onResizeEvent?.(resizedEvent, current.end);
    }
    window.setTimeout(() => { suppressEventClickRef.current = false; }, 0);
  };

  const cancelEventResize = (pointerEvent: ReactPointerEvent<HTMLSpanElement>) => {
    const current = eventResizeRef.current;
    if (!current || current.pointerId !== pointerEvent.pointerId) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    setActiveEventResize(undefined);
    window.setTimeout(() => { suppressEventClickRef.current = false; }, 0);
  };

  return (
    <section className={`calendar-week panel ${timeSelection ? "selecting-time" : ""}`} aria-label="wöchentliche Ansicht" data-testid="calendar-week-view">
      <div className="calendar-week-mobile-agenda" aria-label="Zusammenfassung des Veranstaltungskalenders dieser Woche">
        {days.map((day, index) => {
          const dayEvents = events
            .filter((event) => calendarEventOverlapsDay(event, day))
            .sort((left, right) => Number(right.allDay) - Number(left.allDay) || new Date(left.start).getTime() - new Date(right.start).getTime());
          const isToday = calendarDatesMatch(day, new Date());
          const createAt = new Date(day);
          createAt.setHours(9, 0, 0, 0);
          return <section className={isToday ? "today" : undefined} key={day.toISOString()}>
            <header>
              <span><strong>{calendarDayNames[index]}</strong><time dateTime={toCalendarDateKey(day)}>{day.getMonth() + 1}Monat{day.getDate()}Tag</time>{isToday && <em>Heute</em>}</span>
              <button type="button" aria-label={`in der${calendarDayNames[index]}Neuer Zeitplan`} onClick={() => onCreate(createAt)}><Plus size={15} /></button>
            </header>
            <div>
              {dayEvents.map((event) => {
                const calendar = calendars.find((item) => item.id === event.calendarId);
                return <button type="button" className={calendarAvailabilityClass(event)} key={event.id} onClick={() => onEdit(event)}>
                  <i style={{ background: calendar?.color ?? "#86bdf5" }} />
                  <span>
                    <strong>{event.title}</strong>
                    <small>{event.allDay ? "Ganztägig" : `${formatCalendarEventTime(event.start)}–${formatCalendarEventTime(event.end)}`}{event.location ? ` · ${event.location}` : ""}</small>
                  </span>
                  {event.recurrence && <Repeat2 size={12} aria-label="Wiederkehrender Termin" />}
                </button>;
              })}
              {!loading && dayEvents.length === 0 && <small className="calendar-mobile-day-empty">Keine Vereinbarung</small>}
            </div>
          </section>;
        })}
        {loading && <div className="calendar-view-loading"><LoaderCircle className="spin" size={17} />Termine werden geladen</div>}
      </div>
      <div className="calendar-week-viewport">
        <div className="calendar-week-sticky">
          <div className="calendar-week-header">
            <div className="calendar-week-corner">GMT{formatTimezoneOffset(new Date())}</div>
            {days.map((day, index) => (
              <div className={`calendar-week-day-heading ${isCalendarWeekend(day) ? "calendar-weekend" : ""} ${calendarDatesMatch(day, new Date()) ? "today" : ""} ${oofDayKeys.has(toCalendarDateKey(day)) ? "calendar-day-oof" : ""}`} key={day.toISOString()}>
                <span>{calendarDayNames[index]}</span><b>{day.getDate()}</b>
              </div>
            ))}
          </div>
          <div className="calendar-all-day-row" style={{ minHeight: Math.max(38, 8 + allDayLaneCount * 28) }}>
            <div className="calendar-all-day-label">Ganztägig</div>
            {days.map((day) => (
              <div
                className={`calendar-all-day-cell ${isCalendarWeekend(day) ? "calendar-weekend" : ""} ${oofDayKeys.has(toCalendarDateKey(day)) ? "calendar-day-oof" : ""}`}
                key={day.toISOString()}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes("application/x-kalender-calendar-event")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  event.currentTarget.classList.add("calendar-drop-target");
                }}
                onDragLeave={(event) => event.currentTarget.classList.remove("calendar-drop-target")}
                onDrop={(event) => {
                  event.preventDefault();
                  event.currentTarget.classList.remove("calendar-drop-target");
                  const eventId = event.dataTransfer.getData("application/x-kalender-calendar-event");
                  const movedEvent = events.find((item) => item.id === eventId);
                  if (movedEvent) onMoveEvent?.(movedEvent, calendarEventStartOnDay(movedEvent, day));
                }}
              />
            ))}
            <div className="calendar-week-span-layer">
              {allDayPlacements.map((placement) => {
                const calendar = calendars.find((item) => item.id === placement.event.calendarId);
                return <CalendarSpanningEvent
                  calendar={calendar}
                  placement={placement}
                  key={placement.event.id}
                  movable={!moveBusy && !calendarEventWriteDisabledReason(placement.event, calendar)}
                  onBeginMove={(eventId) => {
                    suppressEventClickRef.current = true;
                    setDraggedEventId(eventId);
                    setDraggedEventOffsetMinutes(0);
                    onClearEventPreview();
                  }}
                  onEndMove={() => {
                    setDraggedEventId("");
                    setDraggedEventOffsetMinutes(0);
                    window.setTimeout(() => { suppressEventClickRef.current = false; }, 0);
                  }}
                  suppressClick={() => suppressEventClickRef.current}
                  onEdit={onEdit}
                  previewed={previewEventId === placement.event.id}
                  onPreview={onPreviewEvent}
                  onClearPreview={onClearEventPreview}
                  onOpenMenu={onOpenEventMenu}
                />;
              })}
            </div>
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
              const isOofDay = oofDayKeys.has(toCalendarDateKey(day));
              return (
                <div
                  className={`calendar-time-lane ${isCalendarWeekend(day) ? "calendar-weekend" : ""} ${isToday ? "today" : ""} ${isOofDay ? "calendar-day-oof" : ""}`}
                  data-testid={`calendar-week-day-${index}`}
                  key={day.toISOString()}
                onPointerDown={(event) => beginTimeSelection(event, index)}
                onPointerMove={updateTimeSelection}
                onPointerUp={finishTimeSelection}
                onPointerCancel={cancelTimeSelection}
                onDragOver={(event) => {
                  const movingCalendarEvent = event.dataTransfer.types.includes("application/x-kalender-calendar-event");
                  if (!movingCalendarEvent && !event.dataTransfer.types.includes("application/x-kalender-task") && !event.dataTransfer.types.includes("application/x-kalender-task-block")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  event.currentTarget.classList.add(movingCalendarEvent ? "calendar-drop-target" : "task-drop-target");
                  if (movingCalendarEvent && draggedEventId) {
                    const draggedEvent = events.find((item) => item.id === draggedEventId);
                    if (draggedEvent) {
                      const startMinutes = Math.max(0, minutesFromPointer(event.currentTarget, event.clientY) - draggedEventOffsetMinutes);
                      setEventDropPreview({
                        dayIndex: index,
                        startMinutes,
                        durationMinutes: Math.max(weekSelectionStepMinutes, (new Date(draggedEvent.end).getTime() - new Date(draggedEvent.start).getTime()) / 60_000),
                        title: draggedEvent.title,
                      });
                    }
                  }
                }}
                onDragLeave={(event) => {
                  event.currentTarget.classList.remove("task-drop-target", "calendar-drop-target");
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEventDropPreview(undefined);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.currentTarget.classList.remove("task-drop-target", "calendar-drop-target");
                  setEventDropPreview(undefined);
                  const eventId = event.dataTransfer.getData("application/x-kalender-calendar-event");
                  const calendarEvent = eventId ? events.find((item) => item.id === eventId) : undefined;
                  if (calendarEvent) {
                    onMoveEvent?.(calendarEvent, eventSlotFromPointer(day, event.currentTarget, event.clientY));
                    return;
                  }
                  const blockId = event.dataTransfer.getData("application/x-kalender-task-block");
                  const movedEvent = blockId ? events.find((item) => item.id === blockId) : undefined;
                  if (movedEvent) {
                    onMoveEvent?.(movedEvent, slotFromPointer(day, event.currentTarget, event.clientY));
                    return;
                  }
                  const taskId = event.dataTransfer.getData("application/x-kalender-task");
                  if (taskId) onDropTask?.(taskId, slotFromPointer(day, event.currentTarget, event.clientY));
                }}
                onClick={(event) => {
                  if (suppressLaneClickRef.current) {
                    suppressLaneClickRef.current = false;
                    return;
                  }
                  if ((event.target as HTMLElement).closest(".calendar-week-event")) return;
                  onCreate(slotFromPointer(day, event.currentTarget, event.clientY));
                }}
                onContextMenu={(event) => {
                  if (event.shiftKey || (event.target as HTMLElement).closest(".calendar-week-event")) return;
                  event.preventDefault();
                  onOpenSlotMenu(slotFromPointer(day, event.currentTarget, event.clientY), event.clientX, event.clientY, event.currentTarget);
                }}
              >
                {timeSelection && (() => {
                  const segment = selectionSegmentForDay(day, timeSelection);
                  if (!segment) return null;
                  return <div
                    className={`calendar-time-selection ${segment.endMinutes - segment.startMinutes < 25 ? "compact" : ""} ${timeSelection.anchorDayIndex !== timeSelection.currentDayIndex ? "cross-day" : ""}`}
                    data-testid="calendar-time-selection"
                    style={{
                      top: segment.startMinutes / 60 * weekHourHeight,
                      height: Math.max(weekSelectionStepMinutes / 60 * weekHourHeight, (segment.endMinutes - segment.startMinutes) / 60 * weekHourHeight),
                    }}
                    aria-hidden="true"
                  >
                    <span>{formatTimelineMinutes(segment.startMinutes)}–{formatTimelineMinutes(segment.endMinutes)}</span>
                  </div>;
                })()}
                {eventDropPreview?.dayIndex === index && (
                  <div
                    className="calendar-event-drop-preview"
                    style={{
                      top: eventDropPreview.startMinutes / 60 * weekHourHeight,
                      height: Math.max(24, Math.min(eventDropPreview.durationMinutes, (weekVisibleEndHour - weekVisibleStartHour) * 60 - eventDropPreview.startMinutes) / 60 * weekHourHeight),
                    }}
                    aria-hidden="true"
                  >
                    <time>{formatTimelineMinutes(eventDropPreview.startMinutes)}</time>
                    <strong>{eventDropPreview.title}</strong>
                  </div>
                )}
                {isToday && currentTimeVisible && currentTimeTop !== undefined && currentTime && (
                  <div
                    className="calendar-current-time"
                    style={{ top: currentTimeTop }}
                    role="timer"
                    aria-label={`Aktuelle Zeit ${formatCalendarCurrentTime(currentTime)}`}
                  >
                    <time dateTime={currentTime.toISOString()}>{formatCalendarCurrentTime(currentTime)}</time>
                  </div>
                )}
                {laidOutEvents.map((placed) => {
                  const calendar = calendars.find((item) => item.id === placed.event.calendarId);
                  const movable = !moveBusy && !calendarEventWriteDisabledReason(placed.event, calendar);
                  const resizable = movable && !calendarEventSpansMultipleDays(placed.event) && Boolean(onResizeEvent);
                  const resizePreview = eventResizePreview?.eventId === placed.event.id ? eventResizePreview : undefined;
                  const visibleDayStart = new Date(day);
                  visibleDayStart.setHours(weekVisibleStartHour, 0, 0, 0);
                  const resizedHeight = resizePreview
                    ? Math.max(24, Math.min(timelineHeight - placed.top, (resizePreview.end.getTime() - visibleDayStart.getTime()) / 60_000 / 60 * weekHourHeight - placed.top))
                    : placed.height;
                  return (
                    <button
                      className={`calendar-week-event ${calendarAvailabilityClass(placed.event)} ${movable ? "calendar-event-draggable" : ""} ${resizePreview ? "resizing" : ""}`}
                      data-testid="calendar-event"
                      draggable={movable && !resizePreview}
                      key={placed.event.id}
                      style={{
                        top: placed.top,
                        height: resizedHeight,
                        left: `${placed.leftPercent}%`,
                        width: `${placed.widthPercent}%`,
                        borderLeftColor: calendar?.color ?? "#86bdf5",
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!suppressEventClickRef.current) onEdit(placed.event);
                      }}
                      onMouseEnter={(event) => onPreviewEvent(placed.event, event.currentTarget)}
                      onMouseLeave={onClearEventPreview}
                      onFocus={(event) => onPreviewEvent(placed.event, event.currentTarget)}
                      onBlur={onClearEventPreview}
                      onDragStart={(event) => {
                        if (!movable) {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("application/x-kalender-calendar-event", placed.event.id);
                        const bounds = event.currentTarget.getBoundingClientRect();
                        const offsetMinutes = Math.round(((event.clientY - bounds.top) / weekHourHeight * 60) / weekSelectionStepMinutes) * weekSelectionStepMinutes;
                        const durationMinutes = Math.max(weekSelectionStepMinutes, (new Date(placed.event.end).getTime() - new Date(placed.event.start).getTime()) / 60_000);
                        setDraggedEventOffsetMinutes(Math.max(0, Math.min(offsetMinutes, durationMinutes - weekSelectionStepMinutes)));
                        suppressEventClickRef.current = true;
                        setDraggedEventId(placed.event.id);
                        onClearEventPreview();
                        event.currentTarget.classList.add("dragging");
                      }}
                      onDragEnd={(event) => {
                        event.currentTarget.classList.remove("dragging");
                        setDraggedEventId("");
                        setDraggedEventOffsetMinutes(0);
                        setEventDropPreview(undefined);
                        document.querySelectorAll(".calendar-drop-target, .task-drop-target").forEach((target) => target.classList.remove("calendar-drop-target", "task-drop-target"));
                        window.setTimeout(() => { suppressEventClickRef.current = false; }, 0);
                      }}
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
                        {placed.event.recurrence && <Repeat2 size={11} aria-label="Wiederkehrender Termin" />}
                      </span>
                      {resizedHeight >= 42 && (placed.event.linkedTask ? <small className="calendar-event-task"><ListChecks size={10} />Aufgabe . {placed.event.linkedTask.title}</small> : placed.event.location && <small>{placed.event.location}</small>)}
                      {resizable && <span
                        className="calendar-event-resize-handle"
                        title="Länge des Ziehens und Wechselns"
                        onPointerDown={(event) => beginEventResize(event, placed.event)}
                        onPointerMove={(event) => updateEventResize(event, day)}
                        onPointerUp={(event) => finishEventResize(event, day)}
                        onPointerCancel={cancelEventResize}
                        onClick={(event) => event.stopPropagation()}
                      />}
                    </button>
                  );
                })}
                </div>
              );
            })}
            {loading && <div className="calendar-view-loading"><LoaderCircle className="spin" size={17} />Termine werden geladen</div>}
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
  onOpenWeek,
  onCreate,
  onEdit,
  previewEventId,
  onPreviewEvent,
  onClearEventPreview,
  onOpenEventMenu,
  onOpenSlotMenu,
  moveBusy = false,
  onMoveEvent,
}: CalendarViewCommonProps & { readonly anchorDate: Date; readonly rangeStart: Date; readonly onOpenWeek: (date: Date) => void }) {
  const [expandedDay, setExpandedDay] = useState("");
  const suppressEventClickRef = useRef(false);
  const days = Array.from({ length: 42 }, (_, index) => addCalendarDays(rangeStart, index));
  const weeks = Array.from({ length: 6 }, (_, index) => days.slice(index * 7, index * 7 + 7));
  const spanningEvents = events.filter(calendarEventSpansMultipleDays);

  return (
    <section className="calendar-month panel" aria-label="Monatsansicht" data-testid="calendar-month-view">
      <div className="calendar-month-weekdays">
        {calendarDayNames.map((name, index) => <div className={index >= 5 ? "calendar-weekend" : undefined} key={name}>{name}</div>)}
      </div>
      <div className="calendar-month-grid">
        {weeks.map((week, weekIndex) => {
          const placements = layoutCalendarSpanEvents(spanningEvents, week);
          const laneCount = calendarSpanLaneCount(placements);
          return <div
            className="calendar-month-week"
            style={{ "--calendar-month-span-lanes": laneCount } as CSSProperties}
            key={weekIndex}
          >
            {week.map((day, dayIndex) => {
              const index = weekIndex * 7 + dayIndex;
              const dayKey = toCalendarDateKey(day);
              const dayEvents = events
                .filter((event) => !calendarEventSpansMultipleDays(event) && calendarEventOverlapsDay(event, day))
                .sort((left, right) => Number(right.allDay) - Number(left.allDay) || new Date(left.start).getTime() - new Date(right.start).getTime());
              const expanded = expandedDay === dayKey;
              const visibleEvents = expanded ? dayEvents : dayEvents.slice(0, 3);
              const slotStart = calendarSlotStart(day);
              return <div
                className={`calendar-month-day ${isCalendarWeekend(day) ? "calendar-weekend" : ""} ${day.getMonth() !== anchorDate.getMonth() ? "outside" : ""} ${calendarDatesMatch(day, new Date()) ? "today" : ""} ${events.some((event) => event.allDay && event.availability === "oof" && calendarEventOverlapsDay(event, day)) ? "calendar-day-oof" : ""}`}
                data-testid={`calendar-month-day-${index}`}
                key={dayKey}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes("application/x-kalender-calendar-event")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  event.currentTarget.classList.add("calendar-drop-target");
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.classList.remove("calendar-drop-target");
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.currentTarget.classList.remove("calendar-drop-target");
                  const eventId = event.dataTransfer.getData("application/x-kalender-calendar-event");
                  const movedEvent = events.find((item) => item.id === eventId);
                  if (movedEvent) onMoveEvent?.(movedEvent, calendarEventStartOnDay(movedEvent, day));
                }}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(".calendar-month-event, .calendar-spanning-event, .calendar-more-events")) return;
                  if (window.matchMedia("(max-width: 760px)").matches) {
                    onOpenWeek(day);
                    return;
                  }
                  onCreate(slotStart);
                }}
                onContextMenu={(event) => {
                  if (event.shiftKey || (event.target as HTMLElement).closest(".calendar-month-event, .calendar-spanning-event")) return;
                  event.preventDefault();
                  onOpenSlotMenu(slotStart, event.clientX, event.clientY, event.currentTarget);
                }}
              >
                <header><span>{day.getDate()}</span>{day.getDate() === 1 && <small>{day.getMonth() + 1}Monat</small>}</header>
                <div className="calendar-month-events">
                  {visibleEvents.map((event) => (
                    <CalendarCompactEvent
                      calendar={calendars.find((item) => item.id === event.calendarId)}
                      event={event}
                      key={event.id}
                      month
                      movable={!moveBusy && !calendarEventWriteDisabledReason(event, calendars.find((item) => item.id === event.calendarId))}
                      onBeginMove={() => {
                        suppressEventClickRef.current = true;
                        onClearEventPreview();
                      }}
                      onEndMove={() => {
                        document.querySelectorAll(".calendar-drop-target").forEach((target) => target.classList.remove("calendar-drop-target"));
                        window.setTimeout(() => { suppressEventClickRef.current = false; }, 0);
                      }}
                      suppressClick={() => suppressEventClickRef.current}
                      onEdit={onEdit}
                      previewed={previewEventId === event.id}
                      onPreview={onPreviewEvent}
                      onClearPreview={onClearEventPreview}
                      onOpenMenu={onOpenEventMenu}
                    />
                  ))}
                  {dayEvents.length > 3 && (
                    <button className="calendar-more-events" onClick={(event) => {
                      event.stopPropagation();
                      if (window.matchMedia("(max-width: 760px)").matches) onOpenWeek(day);
                      else setExpandedDay(expanded ? "" : dayKey);
                    }}>
                      {expanded ? "schließen" : `und ${dayEvents.length - 3} Eintrag`}
                    </button>
                  )}
                </div>
                {loading && index === 0 && <div className="calendar-loading"><LoaderCircle className="spin" size={14} /></div>}
              </div>;
            })}
            <div className="calendar-month-span-layer">
              {placements.map((placement) => {
                const calendar = calendars.find((item) => item.id === placement.event.calendarId);
                return <CalendarSpanningEvent
                  calendar={calendar}
                  placement={placement}
                  month
                  key={placement.event.id}
                  movable={!moveBusy && !calendarEventWriteDisabledReason(placement.event, calendar)}
                  onBeginMove={() => {
                    suppressEventClickRef.current = true;
                    onClearEventPreview();
                  }}
                  onEndMove={() => {
                    document.querySelectorAll(".calendar-drop-target").forEach((target) => target.classList.remove("calendar-drop-target"));
                    window.setTimeout(() => { suppressEventClickRef.current = false; }, 0);
                  }}
                  suppressClick={() => suppressEventClickRef.current}
                  onEdit={onEdit}
                  previewed={previewEventId === placement.event.id}
                  onPreview={onPreviewEvent}
                  onClearPreview={onClearEventPreview}
                  onOpenMenu={onOpenEventMenu}
                />;
              })}
            </div>
          </div>;
        })}
      </div>
    </section>
  );
}

function CalendarCompactEvent({
  calendar,
  event,
  month = false,
  movable = false,
  onBeginMove,
  onEndMove,
  suppressClick,
  onEdit,
  previewed = false,
  onPreview,
  onClearPreview,
  onOpenMenu,
}: {
  readonly calendar?: CalendarListItem;
  readonly event: CalendarViewEvent;
  readonly month?: boolean;
  readonly movable?: boolean;
  readonly onBeginMove?: (eventId: string) => void;
  readonly onEndMove?: () => void;
  readonly suppressClick?: () => boolean;
  readonly onEdit: (event: CalendarViewEvent) => void;
  readonly previewed?: boolean;
  readonly onPreview: (event: CalendarViewEvent, anchor: HTMLElement) => void;
  readonly onClearPreview: () => void;
  readonly onOpenMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void;
}) {
  return (
    <button
      className={`${month ? "calendar-month-event" : "calendar-all-day-event"} ${calendarAvailabilityClass(event)} ${movable ? "calendar-event-draggable" : ""}`}
      draggable={movable}
      style={{ borderLeftColor: calendar?.color ?? "#86bdf5" }}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        if (!suppressClick?.()) onEdit(event);
      }}
      onMouseEnter={(hoverEvent) => onPreview(event, hoverEvent.currentTarget)}
      onMouseLeave={onClearPreview}
      onFocus={(focusEvent) => onPreview(event, focusEvent.currentTarget)}
      onBlur={onClearPreview}
      onDragStart={(dragEvent) => {
        if (!movable) {
          dragEvent.preventDefault();
          return;
        }
        dragEvent.dataTransfer.effectAllowed = "move";
        dragEvent.dataTransfer.setData("application/x-kalender-calendar-event", event.id);
        dragEvent.currentTarget.classList.add("dragging");
        onBeginMove?.(event.id);
      }}
      onDragEnd={(dragEvent) => {
        dragEvent.currentTarget.classList.remove("dragging");
        onEndMove?.();
      }}
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
      {event.recurrence && <Repeat2 className="calendar-compact-recurrence-icon" size={10} aria-label="Wiederkehrender Termin" />}
      {event.linkedTask && <ListChecks className="calendar-compact-task-icon" size={10} aria-label="Zugehörige Aufgaben" />}
    </button>
  );
}

function CalendarSpanningEvent({
  calendar,
  placement,
  month = false,
  movable = false,
  onBeginMove,
  onEndMove,
  suppressClick,
  onEdit,
  previewed = false,
  onPreview,
  onClearPreview,
  onOpenMenu,
}: {
  readonly calendar?: CalendarListItem;
  readonly placement: CalendarSpanPlacement;
  readonly month?: boolean;
  readonly movable?: boolean;
  readonly onBeginMove?: (eventId: string) => void;
  readonly onEndMove?: () => void;
  readonly suppressClick?: () => boolean;
  readonly onEdit: (event: CalendarViewEvent) => void;
  readonly previewed?: boolean;
  readonly onPreview: (event: CalendarViewEvent, anchor: HTMLElement) => void;
  readonly onClearPreview: () => void;
  readonly onOpenMenu: (event: CalendarViewEvent, x: number, y: number, returnFocus: HTMLElement) => void;
}) {
  const event = placement.event;
  return <button
    className={`calendar-spanning-event ${month ? "calendar-month-span-event" : "calendar-week-span-event"} ${calendarAvailabilityClass(event)} ${movable ? "calendar-event-draggable" : ""}`}
    draggable={movable}
    style={{
      gridColumn: `${placement.startColumn + 1} / ${placement.endColumn + 1}`,
      gridRow: placement.lane + 1,
      borderLeftColor: calendar?.color ?? "#86bdf5",
    }}
    onClick={(clickEvent) => {
      clickEvent.stopPropagation();
      if (!suppressClick?.()) onEdit(event);
    }}
    onMouseEnter={(hoverEvent) => onPreview(event, hoverEvent.currentTarget)}
    onMouseLeave={onClearPreview}
    onFocus={(focusEvent) => onPreview(event, focusEvent.currentTarget)}
    onBlur={onClearPreview}
    onDragStart={(dragEvent) => {
      if (!movable) {
        dragEvent.preventDefault();
        return;
      }
      dragEvent.dataTransfer.effectAllowed = "move";
      dragEvent.dataTransfer.setData("application/x-kalender-calendar-event", event.id);
      dragEvent.currentTarget.classList.add("dragging");
      onBeginMove?.(event.id);
    }}
    onDragEnd={(dragEvent) => {
      dragEvent.currentTarget.classList.remove("dragging");
      onEndMove?.();
    }}
    onContextMenu={(contextEvent) => {
      if (contextEvent.shiftKey) return;
      contextEvent.preventDefault();
      contextEvent.stopPropagation();
      onOpenMenu(event, contextEvent.clientX, contextEvent.clientY, contextEvent.currentTarget);
    }}
    onKeyDown={(keyEvent) => openCalendarEventKeyboardMenu(keyEvent, event, onOpenMenu)}
    aria-describedby={previewed ? "calendar-event-tooltip" : undefined}
  >
    <span>{event.title}</span>
    {event.availability === "oof" && <em>Ausflug</em>}
    {event.recurrence && <Repeat2 size={10} aria-label="Wiederkehrender Termin" />}
  </button>;
}

function CalendarAttendeeList({
  attendees,
  expanded,
  onToggle,
  onCompose,
  onOpenCorrespondence,
  onFeedback,
}: {
  readonly attendees: readonly { readonly address: string; readonly name?: string }[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onCompose: (address: string) => void;
  readonly onOpenCorrespondence: (address: string) => void;
  readonly onFeedback: (message: string) => void;
}) {
  const uniqueAttendees = deduplicateCalendarAttendees(attendees);
  const visibleAttendees = expanded ? uniqueAttendees : uniqueAttendees.slice(0, 4);
  return (
    <section className="calendar-detail-attendees">
      <header>
        <div><Users size={15} /><h3>Teilnehmer</h3><span>{uniqueAttendees.length}</span></div>
        {uniqueAttendees.length > 4 && (
          <button type="button" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "schließen" : `Alle anzeigen ${uniqueAttendees.length} Person`}
            <ChevronDown className={expanded ? "expanded" : ""} size={15} />
          </button>
        )}
      </header>
      <div className="calendar-attendee-grid">
        {visibleAttendees.map((attendee) => {
          return (
            <CalendarAttendeeCard
              attendee={attendee}
              key={attendee.address.toLocaleLowerCase()}
              onCompose={onCompose}
              onOpenCorrespondence={onOpenCorrespondence}
              onFeedback={onFeedback}
            />
          );
        })}
      </div>
    </section>
  );
}

interface CalendarCorrespondenceSummary {
  readonly totalCount: number;
  readonly unreadCount: number;
  readonly lastContactAt?: string;
}

function CalendarAttendeeCard({
  attendee,
  onCompose,
  onOpenCorrespondence,
  onFeedback,
}: {
  readonly attendee: { readonly address: string; readonly name?: string };
  readonly onCompose: (address: string) => void;
  readonly onOpenCorrespondence: (address: string) => void;
  readonly onFeedback: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [summary, setSummary] = useState<CalendarCorrespondenceSummary>();
  const [loading, setLoading] = useState(false);
  const loadedAddressRef = useRef("");
  const name = calendarAttendeeName(attendee);
  const domain = attendee.address.split("@")[1]?.toLocaleLowerCase();

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && pinned) return;
    setOpen(nextOpen);
    if (!nextOpen || loadedAddressRef.current === attendee.address) return;
    loadedAddressRef.current = attendee.address;
    setLoading(true);
    const params = new URLSearchParams({ limit: "20", correspondent: attendee.address });
    void fetch(`/api/inbox?${params}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as {
          readonly correspondence?: CalendarCorrespondenceSummary;
          readonly message?: string;
        };
        if (!response.ok) throw new Error(payload.message || "Transaktionsstatistiken können nicht gelesen werden");
        setSummary(payload.correspondence);
      })
      .catch(() => setSummary(undefined))
      .finally(() => setLoading(false));
  };

  const closeCard = () => {
    setPinned(false);
    setOpen(false);
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(attendee.address);
      onFeedback("Postfach-Adresse kopiert");
    } catch {
      onFeedback("Postfachadresse kann nicht kopiert werden");
    }
  };

  return (
    <HoverCard open={open} openDelay={250} closeDelay={160} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="calendar-attendee"
          aria-label={`Informationen zum Teilnehmer anzeigen:${name}`}
          aria-expanded={open}
          onClick={() => {
            const nextPinned = !pinned;
            setPinned(nextPinned);
            setOpen(nextPinned || open);
          }}
        >
          <i aria-hidden="true" style={{ background: calendarAttendeeAvatarColor(attendee.address, name) }}>{calendarAttendeeInitials(name)}</i>
          <span>
            <strong>{name}</strong>
            <small>{attendee.address}</small>
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        className="calendar-attendee-card"
        align="start"
        side="bottom"
        sideOffset={7}
        collisionPadding={12}
        onEscapeKeyDown={closeCard}
      >
        <header>
          <i aria-hidden="true" style={{ background: calendarAttendeeAvatarColor(attendee.address, name) }}>{calendarAttendeeInitials(name)}</i>
          <div><strong>{name}</strong><small>{attendee.address}</small></div>
          <span>Teilnehmer</span>
          {pinned && <button type="button" aria-label="enge Teilnehmerinformationen" title="Schließen" onClick={closeCard}><X size={14} /></button>}
        </header>
        <div className="calendar-attendee-card-meta">
          <span><b>{summary?.totalCount ?? (loading ? "…" : "0")}</b> E-Mails</span>
          <span><b>{summary?.unreadCount ?? (loading ? "…" : "0")}</b> ungelesen</span>
          <span><b>{summary?.lastContactAt ? formatCalendarContactTime(summary.lastContactAt) : "—"}</b> letzter Kontakt</span>
        </div>
        {domain && <p>{domain}</p>}
        <footer>
          <button type="button" onClick={() => onCompose(attendee.address)}><Pencil size={14} />E-Mail schreiben</button>
          <button type="button" onClick={() => onOpenCorrespondence(attendee.address)}><MailOpen size={14} />Korrespondenz anzeigen</button>
          <button type="button" aria-label="Mailbox-Adressen kopieren" title="Mailbox-Adressen kopieren" onClick={() => void copyAddress()}><Copy size={14} /></button>
        </footer>
      </HoverCardContent>
    </HoverCard>
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
  const statusLabel = event.status === "tentative" ? "vorläufig" : event.status === "cancelled" ? "Annulliert" : undefined;
  const availabilityLabel = calendarAvailabilityLabel(event.availability);
  return (
    <aside
      id="calendar-event-tooltip"
      className="calendar-event-tooltip"
      role="tooltip"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <header>
        <span><i style={{ background: calendar?.color ?? "#86bdf5" }} />{calendar?.name ?? "Kalender"}{calendar?.readOnly ? " · Nur lesen" : ""}</span>
        {(availabilityLabel || statusLabel) && <em className={event.availability === "oof" ? "availability-oof" : `status-${event.status}`}>{availabilityLabel ?? statusLabel}</em>}
      </header>
      <strong>{event.title}</strong>
      <div className="calendar-event-tooltip-meta">
        <span><Clock3 size={13} />{formatCalendarEventRange(event)}</span>
        {event.recurrence && <span><Repeat2 size={13} />{calendarRecurrenceSummary(event.recurrence)}</span>}
        {event.location && <span><MapPin size={13} />{event.location}</span>}
        {event.meetingUrl && <span><Link2 size={13} />{formatCalendarMeetingHost(event.meetingUrl)}</span>}
      </div>
      {event.description && <p>{event.description}</p>}
      {event.attendees?.length ? <small>{event.attendees.length} nach Teilnehmer</small> : null}
      {event.linkedTask && <small><ListChecks size={12} />Zugehörige Aufgaben:{event.linkedTask.title}</small>}
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

function calendarEventStartOnDay(event: CalendarViewEvent, day: Date): Date {
  const originalStart = new Date(event.start);
  const result = new Date(day);
  if (event.allDay) result.setHours(0, 0, 0, 0);
  else result.setHours(originalStart.getHours(), originalStart.getMinutes(), originalStart.getSeconds(), originalStart.getMilliseconds());
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

function isCalendarWeekend(value: Date): boolean {
  return value.getDay() === 0 || value.getDay() === 6;
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

function recurrenceUnitLabel(frequency: CalendarRecurrenceRule["frequency"]): string {
  if (frequency === "daily") return "Tage";
  if (frequency === "weekly") return "Woche";
  if (frequency === "monthly") return "Monate";
  return "Jahr";
}

function recurrenceUntilIso(dateValue: string): string | undefined {
  if (!dateValue) return undefined;
  const value = new Date(`${dateValue}T23:59:59.999`);
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
}

function recurrenceDefaultUntil(draft: CalendarEventDraft): string {
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00` : draft.startLocal);
  const until = Number.isNaN(start.getTime()) ? new Date() : new Date(start);
  until.setMonth(until.getMonth() + 3);
  until.setHours(23, 59, 59, 999);
  return until.toISOString();
}

function recurrenceDateValue(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function recurrenceUntilDateKey(value?: string): string {
  const date = recurrenceDateValue(value);
  if (!date) return "";
  return toCalendarDateKey(date);
}

function recurrenceMinimumDate(draft: CalendarEventDraft): Date {
  const value = new Date(`${draft.startLocal.slice(0, 10)}T00:00:00`);
  return Number.isNaN(value.getTime()) ? new Date() : value;
}

function formatRecurrenceEndDate(value?: string): string {
  const date = recurrenceDateValue(value);
  if (!date) return "Datum der Auswahl";
  return `${date.getFullYear()}Jahr${date.getMonth() + 1}Monat${date.getDate()}Tag`;
}

function formatRecurrencePreview(draft: CalendarEventDraft): string {
  if (!draft.recurrence) return "";
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00` : draft.startLocal);
  if (Number.isNaN(start.getTime())) return "Bitte legen Sie zuerst eine gültige Startzeit fest";
  try {
    const preview = calendarRecurrencePreview({
      start: start.toISOString(),
      timeZone: draft.timeZone,
      allDay: draft.allDay,
      recurrence: draft.recurrence,
      count: 4,
    });
    if (!preview.length) return "die aktuelle Regel hat kein Datum zu folgen";
    return preview.map((value) => {
      const date = new Date(value);
      return `${date.getMonth() + 1}Monat${date.getDate()}Tag`;
    }).join(", ");
  } catch {
    return "Verfeinern Sie bitte die Duplikat-Regeln";
  }
}

function formatCalendarEventTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatCalendarReminder(value?: CalendarEventReminderMinutes): string {
  if (value === undefined) return "Desktop-Standardalarme verwenden";
  if (value === 0) return "Keine Erinnerung";
  if (value === 60) return "1 Stunde im Voraus";
  if (value === 1440) return "1 Tag im Voraus";
  return `Vorschuss ${value} eine Minute Erinnerung`;
}

function calendarAvailabilityClass(event: CalendarViewEvent): string {
  return event.availability === "oof" ? "calendar-availability-oof" : "";
}

function calendarAvailabilityLabel(value?: CalendarViewEvent["availability"]): string | undefined {
  if (value === "free") return "frei";
  if (value === "tentative") return "vorläufig";
  if (value === "oof") return "Ausflug";
  if (value === "working_elsewhere") return "Sonstige Orte";
  return undefined;
}

function calendarDraftDescriptionContent(content?: string, plainText?: string): string {
  return encodeNoteContent(decodeNoteContent(content || plainText || ""));
}

function deduplicateCalendarAttendees(
  attendees: readonly { readonly address: string; readonly name?: string }[],
): readonly { readonly address: string; readonly name?: string }[] {
  const unique = new Map<string, { readonly address: string; readonly name?: string }>();
  for (const attendee of attendees) {
    const address = attendee.address.trim();
    if (!address) continue;
    const key = address.toLocaleLowerCase();
    const existing = unique.get(key);
    if (!existing || (!existing.name && attendee.name?.trim())) {
      unique.set(key, { address, name: attendee.name?.trim() || undefined });
    }
  }
  return [...unique.values()];
}

function calendarAttendeeName(attendee: { readonly address: string; readonly name?: string }): string {
  if (attendee.name?.trim()) return attendee.name.trim();
  const localPart = attendee.address.split("@")[0] ?? attendee.address;
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.length > 1 ? `${part[0]!.toLocaleUpperCase()}${part.slice(1)}` : part.toLocaleUpperCase())
    .join(" ") || attendee.address;
}

function calendarAttendeeInitials(name: string): string {
  const compact = name.trim();
  if (!compact) return "?";
  if (/[\u3400-\u9fff]/u.test(compact)) return [...compact.replace(/\s+/g, "")].slice(-2).join("");
  const words = compact.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : compact.slice(0, 2)).toLocaleUpperCase();
}

function calendarAttendeeAvatarColor(address: string, name: string): string {
  const identity = (address.trim() || name.trim() || "calendar-attendee").normalize("NFKC").toLocaleLowerCase();
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const unsignedHash = hash >>> 0;
  const hue = unsignedHash / 0xffff_ffff * 360;
  const chroma = 0.08 + (unsignedHash >>> 8) % 5 * 0.008;
  const lightness = 0.74 + (unsignedHash >>> 16) % 5 * 0.01;
  return `oklch(${lightness.toFixed(2)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`;
}

function formatCalendarContactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat("de-DE", { year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

function formatCalendarDetailDate(draft: CalendarEventDraft): string {
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00:00` : draft.startLocal);
  const end = new Date(draft.allDay ? `${draft.endLocal}T00:00:00` : draft.endLocal);
  const format = (value: Date) => new Intl.DateTimeFormat("de-DE", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
  if (Number.isNaN(start.getTime())) return draft.startLocal;
  if (Number.isNaN(end.getTime()) || calendarDatesMatch(start, end)) return format(start);
  return `${format(start)} — ${format(end)}`;
}

function formatCalendarDetailTime(draft: CalendarEventDraft): string {
  if (draft.allDay) return "Ganztägig";
  const start = new Date(draft.startLocal);
  const end = new Date(draft.endLocal);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${draft.startLocal} — ${draft.endLocal}`;
  const format = (value: Date) => new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
  return calendarDatesMatch(start, end) ? `${format(start)} — ${format(end)}` : `${format(start)} — ${new Intl.DateTimeFormat("de-DE", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}

function formatCalendarDetailDuration(draft: CalendarEventDraft): string {
  const start = new Date(draft.allDay ? `${draft.startLocal}T00:00:00` : draft.startLocal);
  const end = new Date(draft.allDay ? `${draft.endLocal}T00:00:00` : draft.endLocal);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  if (draft.allDay) {
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    return days === 1 ? "Ganztägig" : `${days} Tage`;
  }
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} Minuten`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} Stunden ${remainingMinutes} Minuten` : `${hours} Stunden`;
}

function formatCalendarEventRange(event: CalendarViewEvent): string {
  const start = new Date(event.start);
  const end = event.allDay ? new Date(new Date(event.end).getTime() - 1) : new Date(event.end);
  const sameDay = calendarDatesMatch(start, end);
  const date = (value: Date, includeWeekday = false) => {
    const weekday = includeWeekday ? new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(value) : "";
    return `${value.getMonth() + 1}Monat${value.getDate()}Tag${weekday}`;
  };
  if (event.allDay) return sameDay ? `${date(start, true)} . . . . . . . . . . .` : `${date(start)} – ${date(end)} . . . . . . . . . . .`;
  const time = (value: Date) => new Intl.DateTimeFormat("de-DE", {
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
    return "Online-Sitzungen";
  }
}

function formatCalendarCurrentTime(value: Date): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
}

function formatCalendarWeekRange(start: Date, end: Date): string {
  const inclusiveEnd = addCalendarDays(end, -1);
  const startLabel = new Intl.DateTimeFormat("de-DE", { month: "short", day: "numeric" }).format(start);
  const endLabel = new Intl.DateTimeFormat("de-DE", { month: "short", day: "numeric", year: start.getFullYear() === inclusiveEnd.getFullYear() ? undefined : "numeric" }).format(inclusiveEnd);
  return `${startLabel} – ${endLabel}`;
}

function formatCalendarMonth(value: Date): string {
  return new Intl.DateTimeFormat("de-DE", { year: "numeric", month: "long" }).format(value);
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
  return new Intl.DateTimeFormat("de-DE", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
