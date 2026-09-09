export interface CalendarDraftTimeRange {
  readonly startLocal: string;
  readonly endLocal: string;
  readonly allDay: boolean;
}

const MINUTE_MS = 60_000;

export function calendarDraftDuration(range: CalendarDraftTimeRange): number {
  const start = parseDraftTime(range.startLocal, range.allDay);
  const end = parseDraftTime(range.endLocal, range.allDay);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (!range.allDay) return Math.max(0, Math.round((end.getTime() - start.getTime()) / MINUTE_MS));
  return Math.max(1, calendarDayNumber(end) - calendarDayNumber(start) + 1);
}

export function shiftCalendarDraftStart(
  range: CalendarDraftTimeRange,
  startLocal: string,
): Pick<CalendarDraftTimeRange, "startLocal" | "endLocal"> {
  const nextStart = parseDraftTime(startLocal, range.allDay);
  if (Number.isNaN(nextStart.getTime())) return { startLocal, endLocal: range.endLocal };

  const currentDuration = calendarDraftDuration(range);
  const duration = range.allDay ? Math.max(1, currentDuration) : Math.max(5, currentDuration);
  return { startLocal, endLocal: calendarDraftEndForDuration({ ...range, startLocal }, duration) };
}

export function calendarDraftEndForDuration(range: CalendarDraftTimeRange, duration: number): string {
  const start = parseDraftTime(range.startLocal, range.allDay);
  if (Number.isNaN(start.getTime())) return range.endLocal;
  const normalizedDuration = Number.isFinite(duration) ? Math.round(duration) : 0;
  if (range.allDay) {
    start.setDate(start.getDate() + Math.max(1, normalizedDuration) - 1);
    return formatDate(start);
  }
  return formatDateTime(new Date(start.getTime() + Math.max(5, normalizedDuration) * MINUTE_MS));
}

function parseDraftTime(value: string, allDay: boolean): Date {
  return new Date(allDay ? `${value}T00:00:00` : value);
}

function calendarDayNumber(value: Date): number {
  return Math.round(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000);
}

function formatDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function formatDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${formatDate(value)}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
