import type { UpsertCalendarEventInput } from "../../../../src/mail/types";

export interface CalendarEventRequestBody {
  readonly id?: unknown;
  readonly calendarId?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly location?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly timeZone?: unknown;
  readonly allDay?: unknown;
  readonly idempotencyKey?: unknown;
  readonly allowConflicts?: unknown;
}

export function parseCalendarEventInput(body: CalendarEventRequestBody | null): UpsertCalendarEventInput {
  if (!body || typeof body.calendarId !== "string" || typeof body.title !== "string") {
    throw new CalendarValidationError("请填写日历和日程标题");
  }
  const title = body.title.trim();
  if (!title || title.length > 200) throw new CalendarValidationError("日程标题需要 1–200 个字符");
  const start = parseDate(body.start, "开始时间");
  const end = parseDate(body.end, "结束时间");
  if (end.getTime() <= start.getTime()) throw new CalendarValidationError("结束时间必须晚于开始时间");
  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new CalendarValidationError("单个日程不能超过 366 天");
  }
  const timeZone = typeof body.timeZone === "string" && body.timeZone.trim()
    ? body.timeZone.trim()
    : "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(start);
  } catch {
    throw new CalendarValidationError("时区无效");
  }
  return {
    id: typeof body.id === "string" && body.id ? body.id : undefined,
    calendarId: body.calendarId,
    title,
    description: optionalText(body.description, 100_000, "说明"),
    location: optionalText(body.location, 500, "地点"),
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone,
    allDay: body.allDay === true,
    attendees: [],
    idempotencyKey: typeof body.idempotencyKey === "string" && body.idempotencyKey
      ? body.idempotencyKey.slice(0, 200)
      : undefined,
  };
}

export function parseCalendarRange(url: URL): { from: string; to: string; calendarIds?: readonly string[] } {
  const from = parseDate(url.searchParams.get("from"), "开始日期");
  const to = parseDate(url.searchParams.get("to"), "结束日期");
  if (to.getTime() <= from.getTime()) throw new CalendarValidationError("查询结束日期必须晚于开始日期");
  if (to.getTime() - from.getTime() > 370 * 24 * 60 * 60 * 1000) {
    throw new CalendarValidationError("单次最多查询 370 天");
  }
  const calendarIds = url.searchParams.getAll("calendarId").filter(Boolean);
  return { from: from.toISOString(), to: to.toISOString(), calendarIds: calendarIds.length ? calendarIds : undefined };
}

export class CalendarValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "CalendarValidationError";
  }
}

function parseDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || !value) throw new CalendarValidationError(`请填写${label}`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new CalendarValidationError(`${label}无效`);
  return date;
}

function optionalText(value: unknown, maximum: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new CalendarValidationError(`${label}内容过长`);
  }
  return value.trim() || undefined;
}
