import { listStoredCalendarEvents } from "./calendar-repository";

export interface McpFreeSlot {
  readonly status: "free";
  readonly availability: "free";
  readonly blockers: readonly [];
  readonly start: string;
  readonly end: string;
  readonly durationMinutes: number;
}

export async function listMcpCalendarFreeSlots(input: {
  readonly calendarIds?: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly minimumDurationMinutes?: number;
  readonly timeZone?: string;
}): Promise<readonly McpFreeSlot[]> {
  const from = validDate(input.from, "开始时间");
  const to = validDate(input.to, "结束时间");
  if (to <= from) throw new McpCalendarAvailabilityError("结束时间必须晚于开始时间");
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1_000) throw new McpCalendarAvailabilityError("时间范围不能超过 366 天");
  const minimumDurationMinutes = input.minimumDurationMinutes ?? 30;
  if (!Number.isInteger(minimumDurationMinutes) || minimumDurationMinutes < 1 || minimumDurationMinutes > 1_440) {
    throw new McpCalendarAvailabilityError("minimumDurationMinutes 必须在 1–1440 之间");
  }
  if (input.timeZone) {
    try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(from); } catch { throw new McpCalendarAvailabilityError("时区无效"); }
  }
  const events = await listStoredCalendarEvents({ calendarIds: input.calendarIds, from: from.toISOString(), to: to.toISOString(), limit: 1_000 });
  const busy = events
    .filter((event) => event.status !== "cancelled" && ["tentative", "busy", "oof", "working_elsewhere"].includes(event.availability ?? "busy"))
    .map((event) => ({ start: Math.max(from.getTime(), Date.parse(event.start)), end: Math.min(to.getTime(), Date.parse(event.end)) }))
    .filter((event) => event.end > event.start)
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const item of busy) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  const slots: McpFreeSlot[] = [];
  let cursor = from.getTime();
  for (const item of merged) {
    if (item.start - cursor >= minimumDurationMinutes * 60_000) slots.push(slot(cursor, item.start, input.timeZone));
    cursor = Math.max(cursor, item.end);
  }
  if (to.getTime() - cursor >= minimumDurationMinutes * 60_000) slots.push(slot(cursor, to.getTime(), input.timeZone));
  return slots;
}

export class McpCalendarAvailabilityError extends Error { constructor(message: string) { super(message); this.name = "McpCalendarAvailabilityError"; } }
function validDate(value: string, label: string): Date { const date = new Date(value); if (Number.isNaN(date.getTime())) throw new McpCalendarAvailabilityError(`${label}无效`); return date; }
function slot(start: number, end: number, timeZone = "UTC"): McpFreeSlot {
  return { status: "free", availability: "free", blockers: [], start: formatInZone(start, timeZone), end: formatInZone(end, timeZone), durationMinutes: Math.floor((end - start) / 60_000) };
}

function formatInZone(timestamp: number, timeZone: string): string {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const offset = value("timeZoneName").replace("GMT", "") || "+00:00";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}.${String(date.getUTCMilliseconds()).padStart(3, "0")}${offset === "Z" ? "+00:00" : offset}`;
}
