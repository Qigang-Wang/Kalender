"use client";

import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type DateTimeFieldMode = "date" | "datetime";
type DateTimeCalendarLevel = "day" | "month" | "year";

interface DateTimeFieldProps {
  readonly label?: string;
  readonly ariaLabel?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly mode?: DateTimeFieldMode;
  readonly className?: string;
  readonly placeholder?: string;
  readonly min?: string;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly clearable?: boolean;
  readonly minuteStep?: number;
}

const WEEKDAYS = ["I. ENTWICKLUNG DER RECHTSVORSCHRIFTEN", "II.", "III. ENTWICKLUNG DER ENTWICKLUNG DER ENTWICKLUNG DER", "IV", "Fünf", "Sechs", "Tag"] as const;
const MONTHS = ["Januar", "Tagungswoche", "März", "ENTWICKLUNG", "Mai", "Juni", "Juli", "ZEITSCHRIFTEN", "ENTWICKLUNG", "Tagungswoche", "ENTWICKLUNG", "Dezember"] as const;

export function DateTimeField({
  label,
  ariaLabel,
  value,
  onChange,
  mode = "datetime",
  className,
  placeholder,
  min,
  disabled = false,
  readOnly = false,
  clearable = true,
  minuteStep = 1,
}: DateTimeFieldProps) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<DateTimeCalendarLevel>("day");
  const [viewDate, setViewDate] = useState(() => valueToDate(value) ?? valueToDate(min) ?? new Date());
  const [draftDate, setDraftDate] = useState(() => valueToDateKey(value) ?? valueToDateKey(min) ?? todayDateKey());
  const [draftTime, setDraftTime] = useState(() => valueToTime(value) ?? defaultTime());
  const minDateKey = valueToDateKey(min);
  const selectedDateKey = valueToDateKey(value);
  const interactive = !disabled && !readOnly;
  const hourValue = Number(draftTime.slice(0, 2));
  const minuteValue = Number(draftTime.slice(3, 5));
  const minuteChoices = useMemo(() => minuteOptions(minuteStep, minuteValue), [minuteStep, minuteValue]);

  useEffect(() => {
    if (!open) return;
    const nextDate = valueToDate(value) ?? valueToDate(min) ?? new Date();
    setViewDate(nextDate);
    setDraftDate(valueToDateKey(value) ?? valueToDateKey(min) ?? todayDateKey());
    setDraftTime(valueToTime(value) ?? defaultTime());
    setLevel("day");
  }, [min, open, value]);

  const commitDate = (dateKey: string, time = draftTime) => {
    if (!interactive || isBeforeMin(dateKey, minDateKey)) return;
    setDraftDate(dateKey);
    setViewDate(valueToDate(dateKey) ?? viewDate);
    if (mode === "date") {
      onChange(dateKey);
      setOpen(false);
      return;
    }
    onChange(`${dateKey}T${normalizeTime(time, minuteStep)}`);
  };

  const commitTime = (nextHour: number, nextMinute: number) => {
    if (!interactive) return;
    const nextTime = normalizeTime(`${pad(nextHour)}:${pad(nextMinute)}`, minuteStep);
    setDraftTime(nextTime);
    onChange(`${draftDate}T${nextTime}`);
  };

  const shiftView = (direction: -1 | 1) => {
    setViewDate((current) => {
      const next = new Date(current);
      if (level === "day") next.setMonth(next.getMonth() + direction);
      else if (level === "month") next.setFullYear(next.getFullYear() + direction);
      else next.setFullYear(next.getFullYear() + direction * 12);
      return next;
    });
  };

  const advanceLevel = () => {
    setLevel((current) => current === "day" ? "month" : "year");
  };

  const clearValue = () => {
    if (!interactive) return;
    onChange("");
    setOpen(false);
  };

  const setToday = () => {
    const today = new Date();
    const dateKey = toDateKey(today);
    setViewDate(today);
    setLevel("day");
    commitDate(dateKey, draftTime);
  };

  const displayValue = formatDisplayValue(value, mode);

  return (
    <div className={cn("date-time-field", className)} data-empty={!value || undefined} data-disabled={disabled || undefined}>
      {label && <span>{label}</span>}
      <Popover open={open} onOpenChange={(nextOpen) => setOpen(interactive ? nextOpen : false)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="date-time-field-trigger"
            aria-label={ariaLabel ?? label}
            aria-expanded={open}
            disabled={disabled}
          >
            <CalendarDays size={15} />
            <span>{displayValue || placeholder || (mode === "date" ? "Datum der Auswahl" : "Datum und Uhrzeit der Auswahl")}</span>
            {readOnly ? null : <ChevronDown size={14} />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="date-time-popover z-[160] w-auto gap-0 p-0"
          align="start"
          sideOffset={7}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="date-time-popover-shell">
            <section className="date-time-calendar-pane">
              <header className="date-time-calendar-header">
                <button type="button" aria-label="vorheriger" onClick={() => shiftView(-1)}><ChevronLeft size={16} /></button>
                <button type="button" className="date-time-calendar-title" onClick={advanceLevel}>
                  {calendarTitle(viewDate, level)}
                </button>
                <button type="button" aria-label="Nächster" onClick={() => shiftView(1)}><ChevronRight size={16} /></button>
              </header>
              {level === "day" && (
                <DayGrid
                  minDateKey={minDateKey}
                  selectedDateKey={selectedDateKey}
                  viewDate={viewDate}
                  onSelect={commitDate}
                />
              )}
              {level === "month" && (
                <MonthGrid
                  minDateKey={minDateKey}
                  selectedDateKey={selectedDateKey}
                  viewDate={viewDate}
                  onSelect={(month) => {
                    setViewDate(new Date(viewDate.getFullYear(), month, 1));
                    setLevel("day");
                  }}
                />
              )}
              {level === "year" && (
                <YearGrid
                  minDateKey={minDateKey}
                  selectedDateKey={selectedDateKey}
                  viewDate={viewDate}
                  onSelect={(year) => {
                    setViewDate(new Date(year, viewDate.getMonth(), 1));
                    setLevel("month");
                  }}
                />
              )}
            </section>
            <aside className="date-time-popover-panel">
              <header>
                <span>{mode === "date" ? "Zeitpunkt" : "Zeit"}</span>
                <strong>{formatSelectedSummary(draftDate, mode === "datetime" ? draftTime : undefined)}</strong>
              </header>
              {mode === "datetime" && (
                <div className="date-time-wheel-wrap" aria-label="Zeit für die Auswahl der Folie">
                  <WheelColumn
                    ariaLabel="Stunden"
                    max={23}
                    value={hourValue}
                    onChange={(hour) => commitTime(hour, minuteValue)}
                  />
                  <span className="date-time-wheel-colon">:</span>
                  <WheelColumn
                    ariaLabel="Minuten"
                    values={minuteChoices}
                    value={minuteValue}
                    onChange={(minute) => commitTime(hourValue, minute)}
                  />
                </div>
              )}
              <footer>
                <button type="button" onClick={setToday}><RotateCcw size={13} />Heute</button>
                {clearable && <button type="button" onClick={clearValue}><X size={13} />Löschen</button>}
                <button type="button" className="primary" onClick={() => setOpen(false)}><Check size={13} />Erledigt</button>
              </footer>
            </aside>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function DayGrid({
  viewDate,
  selectedDateKey,
  minDateKey,
  onSelect,
}: {
  readonly viewDate: Date;
  readonly selectedDateKey?: string;
  readonly minDateKey?: string;
  readonly onSelect: (dateKey: string) => void;
}) {
  const days = calendarDays(viewDate);
  return (
    <>
      <div className="date-time-weekdays">
        {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="date-time-day-grid">
        {days.map((day) => {
          const dateKey = toDateKey(day);
          const outside = day.getMonth() !== viewDate.getMonth();
          const disabled = isBeforeMin(dateKey, minDateKey);
          return (
            <button
              type="button"
              className={cn(outside && "outside", selectedDateKey === dateKey && "selected")}
              disabled={disabled}
              key={dateKey}
              onClick={() => onSelect(dateKey)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </>
  );
}

function MonthGrid({
  viewDate,
  selectedDateKey,
  minDateKey,
  onSelect,
}: {
  readonly viewDate: Date;
  readonly selectedDateKey?: string;
  readonly minDateKey?: string;
  readonly onSelect: (month: number) => void;
}) {
  const selected = valueToDate(selectedDateKey);
  return (
    <div className="date-time-month-grid">
      {MONTHS.map((month, index) => {
        const disabled = minDateKey ? `${viewDate.getFullYear()}-${pad(index + 1)}-31` < minDateKey : false;
        return (
          <button
            type="button"
            className={selected?.getFullYear() === viewDate.getFullYear() && selected.getMonth() === index ? "selected" : undefined}
            disabled={disabled}
            key={month}
            onClick={() => onSelect(index)}
          >
            {month}
          </button>
        );
      })}
    </div>
  );
}

function YearGrid({
  viewDate,
  selectedDateKey,
  minDateKey,
  onSelect,
}: {
  readonly viewDate: Date;
  readonly selectedDateKey?: string;
  readonly minDateKey?: string;
  readonly onSelect: (year: number) => void;
}) {
  const start = yearRangeStart(viewDate.getFullYear());
  const selected = valueToDate(selectedDateKey);
  const minYear = valueToDate(minDateKey)?.getFullYear();
  return (
    <div className="date-time-year-grid">
      {Array.from({ length: 12 }, (_, offset) => start + offset).map((year) => (
        <button
          type="button"
          className={selected?.getFullYear() === year ? "selected" : undefined}
          disabled={minYear !== undefined && year < minYear}
          key={year}
          onClick={() => onSelect(year)}
        >
          {year}
        </button>
      ))}
    </div>
  );
}

function WheelColumn({
  ariaLabel,
  value,
  onChange,
  max,
  values,
}: {
  readonly ariaLabel: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly max?: number;
  readonly values?: readonly number[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const items = values ?? Array.from({ length: (max ?? 0) + 1 }, (_, item) => item);

  useEffect(() => {
    const root = rootRef.current;
    const active = root?.querySelector<HTMLButtonElement>("[data-active='true']");
    active?.scrollIntoView({ block: "center" });
  }, [items, value]);

  return (
    <div className="date-time-wheel" aria-label={ariaLabel} ref={rootRef} role="listbox">
      {items.map((item) => (
        <button
          type="button"
          aria-selected={item === value}
          data-active={item === value || undefined}
          key={item}
          onClick={() => onChange(item)}
          role="option"
        >
          {pad(item)}
        </button>
      ))}
    </div>
  );
}

function calendarDays(viewDate: Date): Date[] {
  const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const firstIsoWeekday = first.getDay() === 0 ? 7 : first.getDay();
  const start = new Date(first);
  start.setDate(first.getDate() - firstIsoWeekday + 1);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function calendarTitle(viewDate: Date, level: DateTimeCalendarLevel): string {
  if (level === "day") return `${viewDate.getFullYear()}Jahr${pad(viewDate.getMonth() + 1)}Monat`;
  if (level === "month") return `${viewDate.getFullYear()}Jahr`;
  const start = yearRangeStart(viewDate.getFullYear());
  return `${start}-${start + 11}`;
}

function yearRangeStart(year: number): number {
  return Math.floor(year / 12) * 12;
}

function isBeforeMin(dateKey: string, minDateKey?: string): boolean {
  return Boolean(minDateKey && dateKey < minDateKey);
}

function valueToDateKey(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match?.[0];
}

function valueToTime(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /T(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

function valueToDate(value?: string): Date | undefined {
  const key = valueToDateKey(value);
  if (!key) return undefined;
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayDateKey(): string {
  return toDateKey(new Date());
}

function defaultTime(): string {
  const date = new Date();
  date.setSeconds(0, 0);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeTime(value: string, minuteStep: number): string {
  const [rawHour, rawMinute] = value.split(":").map(Number);
  const hour = Math.max(0, Math.min(23, Number.isFinite(rawHour) ? rawHour : 0));
  const step = Math.max(1, Math.min(30, minuteStep));
  const minute = Math.max(0, Math.min(59, Number.isFinite(rawMinute) ? rawMinute : 0));
  const roundedMinute = Math.round(minute / step) * step;
  const normalizedHour = roundedMinute >= 60 ? (hour + 1) % 24 : hour;
  const normalizedMinute = roundedMinute >= 60 ? 0 : roundedMinute;
  return `${pad(normalizedHour)}:${pad(normalizedMinute)}`;
}

function minuteOptions(step: number, selectedMinute: number): number[] {
  const normalizedStep = Math.max(1, Math.min(30, step));
  const options = new Set<number>();
  for (let minute = 0; minute < 60; minute += normalizedStep) {
    options.add(minute);
  }
  if (Number.isInteger(selectedMinute) && selectedMinute >= 0 && selectedMinute < 60) {
    options.add(selectedMinute);
  }
  return [...options].sort((left, right) => left - right);
}

function formatDisplayValue(value: string, mode: DateTimeFieldMode): string {
  const dateKey = valueToDateKey(value);
  if (!dateKey) return "";
  if (mode === "date") return dateKey;
  return `${dateKey} ${valueToTime(value) ?? "00:00"}`;
}

function formatSelectedSummary(dateKey: string, time?: string): string {
  return time ? `${dateKey} ${time}` : dateKey;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
