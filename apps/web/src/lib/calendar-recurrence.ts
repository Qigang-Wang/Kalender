import { TZDate } from "@date-fns/tz";
import ICAL from "ical.js";

import type {
  CalendarRecurrenceRule,
  CalendarRecurrenceFrequency,
} from "../../../../src/mail/types";

const weekdayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const weekdayLabels = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"] as const;
const maximumExpansionIterations = 50_000;

export function normalizeCalendarRecurrence(
  value: CalendarRecurrenceRule,
): CalendarRecurrenceRule {
  const frequency = recurrenceFrequency(value.frequency);
  const interval = integerInRange(value.interval, 1, 99, "wiederholte Intervalle");
  const end = value.end === "until" || value.end === "count" ? value.end : "never";
  const weekDays = frequency === "weekly"
    ? [...new Set((value.weekDays ?? []).map((day) => integerInRange(day, 1, 7, "Wiederholungswoche")))].sort()
    : undefined;
  if (frequency === "weekly" && !weekDays?.length) {
    throw new Error("wöchentliche Wiederholung dauert mindestens einen Tag");
  }
  if (end === "until") {
    if (!value.until || Number.isNaN(new Date(value.until).getTime())) {
      throw new Error("Bitte wählen Sie ein Wiederholungsendedatum");
    }
    return { frequency, interval, weekDays, end, until: new Date(value.until).toISOString() };
  }
  if (end === "count") {
    return {
      frequency,
      interval,
      weekDays,
      end,
      count: integerInRange(value.count ?? 0, 1, 999, "Anzahl der Wiederholungen"),
    };
  }
  return { frequency, interval, weekDays, end };
}

export function expandCalendarRecurrenceStarts(input: {
  readonly start: string;
  readonly timeZone: string;
  readonly allDay: boolean;
  readonly recurrence: CalendarRecurrenceRule;
  readonly from: string;
  readonly to: string;
  readonly limit?: number;
}): readonly string[] {
  const rule = normalizeCalendarRecurrence(input.recurrence);
  const start = new Date(input.start);
  const from = new Date(input.from);
  const to = new Date(input.to);
  if ([start, from, to].some((date) => Number.isNaN(date.getTime())) || to <= from) return [];

  const localStart = TZDate.tz(input.timeZone, start);
  const recurrenceStart = ICAL.Time.fromData({
    year: localStart.getFullYear(),
    month: localStart.getMonth() + 1,
    day: localStart.getDate(),
    hour: input.allDay ? 0 : localStart.getHours(),
    minute: input.allDay ? 0 : localStart.getMinutes(),
    second: input.allDay ? 0 : localStart.getSeconds(),
    isDate: input.allDay,
  });
  const iterator = ICAL.Recur.fromString(toRrule(rule)).iterator(recurrenceStart);
  const result: string[] = [];
  const limit = Math.max(1, Math.min(input.limit ?? 1_000, 5_000));
  const until = rule.end === "until" && rule.until ? new Date(rule.until).getTime() : undefined;

  for (let iteration = 0; iteration < maximumExpansionIterations; iteration += 1) {
    const occurrence = iterator.next();
    if (!occurrence) break;
    const occurrenceDate = TZDate.tz(
      input.timeZone,
      occurrence.year,
      occurrence.month - 1,
      occurrence.day,
      input.allDay ? 0 : occurrence.hour,
      input.allDay ? 0 : occurrence.minute,
      input.allDay ? 0 : occurrence.second,
      0,
    );
    const timestamp = occurrenceDate.getTime();
    if (until !== undefined && timestamp > until) break;
    if (timestamp >= to.getTime()) break;
    if (timestamp >= from.getTime()) {
      result.push(occurrenceDate.toISOString());
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function calendarRecurrenceSummary(ruleValue: CalendarRecurrenceRule): string {
  const rule = normalizeCalendarRecurrence(ruleValue);
  const interval = rule.interval === 1 ? "" : `jeweils ${rule.interval} `;
  let summary: string;
  if (rule.frequency === "daily") summary = rule.interval === 1 ? "täglich" : `${interval}Tage`;
  else if (rule.frequency === "weekly") {
    const days = (rule.weekDays ?? []).map((day) => weekdayLabels[day - 1]).join(", ");
    summary = rule.interval === 1 ? `jeweils${days}` : `${interval}wöchentlich${days}`;
  } else if (rule.frequency === "monthly") summary = rule.interval === 1 ? "monatlich" : `${interval}Monate`;
  else summary = rule.interval === 1 ? "jährlich" : `${interval}Jahr`;

  if (rule.end === "count") return `${summary}Insgesamt ${rule.count} 2-mal`;
  if (rule.end === "until" && rule.until) {
    const date = new Date(rule.until);
    return `${summary}zu ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return `${summary}Wiederholen`;
}

export function calendarRecurrencePreview(input: {
  readonly start: string;
  readonly timeZone: string;
  readonly allDay: boolean;
  readonly recurrence: CalendarRecurrenceRule;
  readonly count?: number;
}): readonly string[] {
  const start = new Date(input.start);
  const horizon = new Date(start);
  horizon.setFullYear(horizon.getFullYear() + 10);
  return expandCalendarRecurrenceStarts({
    ...input,
    from: start.toISOString(),
    to: horizon.toISOString(),
    limit: input.count ?? 4,
  });
}

export function localIsoWeekday(value: string, timeZone: string): number {
  const date = TZDate.tz(timeZone, new Date(value));
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

export function shiftRecurrenceWeekDays(
  ruleValue: CalendarRecurrenceRule,
  dayDelta: number,
): CalendarRecurrenceRule {
  const rule = normalizeCalendarRecurrence(ruleValue);
  if (rule.frequency !== "weekly" || !rule.weekDays?.length || dayDelta % 7 === 0) return rule;
  return {
    ...rule,
    weekDays: rule.weekDays.map((day) => ((day - 1 + dayDelta) % 7 + 7) % 7 + 1).sort(),
  };
}

function toRrule(rule: CalendarRecurrenceRule): string {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`, `INTERVAL=${rule.interval}`];
  if (rule.frequency === "weekly" && rule.weekDays?.length) {
    parts.push(`BYDAY=${rule.weekDays.map((day) => weekdayCodes[day - 1]).join(",")}`);
  }
  if (rule.end === "count") parts.push(`COUNT=${rule.count}`);
  return parts.join(";");
}

function recurrenceFrequency(value: unknown): CalendarRecurrenceFrequency {
  if (value === "daily" || value === "weekly" || value === "monthly" || value === "yearly") return value;
  throw new Error("Häufigkeit duplizieren ungültig");
}

function integerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label}ungültig`);
  }
  return Number(value);
}
