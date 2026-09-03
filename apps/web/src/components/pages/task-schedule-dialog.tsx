"use client";

import { AlertCircle, ListChecks, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { AppSelect } from "../app-select";
import { DateTimeField } from "../ui/date-time-field";

interface WritableCalendar {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: { readonly providerId?: string };
}

export interface SchedulableTask {
  readonly id: string;
  readonly title: string;
  readonly estimatedMinutes?: number;
}

export interface TaskScheduleBlock {
  readonly eventId: string;
  readonly calendarId: string;
  readonly start: string;
  readonly end: string;
}

interface TaskScheduleConflict {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

interface TaskScheduleDraft {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly eventId?: string;
  calendarId: string;
  startLocal: string;
  endLocal: string;
  conflicts: readonly TaskScheduleConflict[];
}

export function TaskScheduleDialog<TTask extends SchedulableTask>({
  task,
  block,
  onClose,
  onSaved,
  onFeedback,
}: {
  readonly task: TTask;
  readonly block?: TaskScheduleBlock;
  readonly onClose: () => void;
  readonly onSaved: (task: TTask) => void;
  readonly onFeedback: (message: string) => void;
}) {
  const [calendars, setCalendars] = useState<readonly WritableCalendar[]>([]);
  const [loadingCalendars, setLoadingCalendars] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<TaskScheduleDraft>(() => createScheduleDraft(task, block));

  useEffect(() => {
    let active = true;
    void workspaceFetch("/api/calendars", {}, 0)
      .then(async (response) => {
        const payload = await response.json() as { readonly calendars?: readonly WritableCalendar[]; readonly message?: string };
        if (!response.ok || !payload.calendars) throw new Error(payload.message ?? "无法读取日历");
        const writable = payload.calendars.filter((calendar) => (
          !calendar.readOnly && calendar.providerData?.providerId === "local-calendar"
        ));
        if (!active) return;
        setCalendars(writable);
        setDraft((current) => ({
          ...current,
          calendarId: writable.some((calendar) => calendar.id === current.calendarId)
            ? current.calendarId
            : (writable.find((calendar) => calendar.primary) ?? writable[0])?.id ?? "",
        }));
      })
      .catch((error: unknown) => {
        if (active) onFeedback(error instanceof Error ? error.message : "无法读取日历");
      })
      .finally(() => { if (active) setLoadingCalendars(false); });
    return () => { active = false; };
  }, [onFeedback]);

  const changeStart = (value: string) => {
    setDraft((current) => {
      const previousStart = new Date(current.startLocal);
      const previousEnd = new Date(current.endLocal);
      const nextStart = new Date(value);
      const duration = Math.max(5 * 60 * 1000, previousEnd.getTime() - previousStart.getTime());
      return {
        ...current,
        startLocal: value,
        endLocal: Number.isNaN(nextStart.getTime())
          ? current.endLocal
          : toLocalDateTimeInput(new Date(nextStart.getTime() + duration)),
        conflicts: [],
      };
    });
  };

  const save = async (allowConflicts = false) => {
    if (busy || !draft.calendarId) return;
    const start = new Date(draft.startLocal);
    const end = new Date(draft.endLocal);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      onFeedback("结束时间必须晚于开始时间");
      return;
    }
    setBusy(true);
    try {
      const endpoint = draft.eventId
        ? `/api/tasks/${encodeURIComponent(draft.taskId)}/schedule/${encodeURIComponent(draft.eventId)}`
        : `/api/tasks/${encodeURIComponent(draft.taskId)}/schedule`;
      const response = await fetch(endpoint, {
        method: draft.eventId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarId: draft.calendarId,
          start: start.toISOString(),
          end: end.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin",
          allowConflicts,
        }),
      });
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly task?: TTask;
        readonly conflicts?: readonly TaskScheduleConflict[];
        readonly message?: string;
      };
      if (response.status === 409 && payload.conflicts?.length) {
        setDraft((current) => ({ ...current, conflicts: payload.conflicts! }));
        onFeedback("所选时间与现有日程冲突");
        return;
      }
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法安排任务");
      onSaved(payload.task);
      onFeedback(draft.eventId ? "任务时间块已更新" : "任务已安排到日历");
      onClose();
    } catch (error) {
      onFeedback(error instanceof Error ? error.message : "无法安排任务");
    } finally {
      setBusy(false);
    }
  };

  return <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="calendar-dialog task-schedule-dialog panel" role="dialog" aria-modal="true" aria-labelledby="task-schedule-title">
      <header><div><h2 id="task-schedule-title">{draft.eventId ? "调整安排" : "安排到日历"}</h2></div><button aria-label="关闭" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="task-schedule-summary"><ListChecks size={17} /><strong>{draft.taskTitle}</strong></div>
      <div className="calendar-form task-schedule-form">
        <DateTimeField label="开始" value={draft.startLocal} onChange={changeStart} />
        <DateTimeField label="结束" value={draft.endLocal} onChange={(endLocal) => setDraft((current) => ({ ...current, endLocal, conflicts: [] }))} />
        <label className="calendar-title-field"><span>日历</span><AppSelect ariaLabel="安排到日历" value={draft.calendarId} disabled={loadingCalendars} onValueChange={(calendarId) => setDraft((current) => ({ ...current, calendarId, conflicts: [] }))} options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))} /></label>
      </div>
      {!loadingCalendars && calendars.length === 0 && <div className="task-schedule-conflicts" role="alert"><header><AlertCircle size={16} /><strong>没有可写的本地日历</strong></header><p>请先在日历页面创建一个本地日历。</p></div>}
      {draft.conflicts.length > 0 && <div className="task-schedule-conflicts" role="alert"><header><AlertCircle size={16} /><strong>发现时间冲突</strong></header>{draft.conflicts.map((conflict) => <div key={conflict.id}><span>{formatTaskBlockRange(conflict.start, conflict.end)}</span><strong>{conflict.title}</strong></div>)}<p>你可以修改时间，或者确认仍然安排。</p></div>}
      <footer><div><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className={draft.conflicts.length ? "danger-confirm-button" : "primary-button"} disabled={busy || loadingCalendars || !draft.calendarId} onClick={() => void save(draft.conflicts.length > 0)}>{busy && <LoaderCircle className="spin" size={15} />}{draft.conflicts.length ? "仍然安排" : draft.eventId ? "保存时间" : "创建时间块"}</button></div></footer>
    </section>
  </div>;
}

function createScheduleDraft(task: SchedulableTask, block?: TaskScheduleBlock): TaskScheduleDraft {
  const start = block ? new Date(block.start) : nextCalendarHour(new Date());
  const end = block ? new Date(block.end) : new Date(start.getTime() + (task.estimatedMinutes ?? 60) * 60 * 1000);
  return {
    taskId: task.id,
    taskTitle: task.title,
    eventId: block?.eventId,
    calendarId: block?.calendarId ?? "",
    startLocal: toLocalDateTimeInput(start),
    endLocal: toLocalDateTimeInput(end),
    conflicts: [],
  };
}

function nextCalendarHour(value: Date): Date {
  const result = new Date(value);
  result.setMinutes(0, 0, 0);
  result.setHours(result.getHours() + 1);
  return result;
}

function toLocalDateTimeInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function formatTaskBlockRange(startValue: string, endValue: string): string {
  const start = new Date(startValue);
  const end = new Date(endValue);
  const sameDay = start.toDateString() === end.toDateString();
  const day = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time.format(start)}–${sameDay ? time.format(end) : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}
