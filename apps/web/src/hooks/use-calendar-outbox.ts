"use client";
import { useCallback, useEffect, useState } from "react";

export interface CalendarQueuedOperation {
  id: string;
  url: string;
  method: string;
  body?: string;
  event: Record<string, unknown> & { id: string };
  error?: string;
}

export function useCalendarOutbox(userId: string) {
  const key = `dayline:calendar-outbox:${userId}`;
  const [operations, setOperations] = useState<CalendarQueuedOperation[]>([]);
  const read = useCallback((): CalendarQueuedOperation[] => {
    try {
      const entries: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.id === "string" && /^[a-zA-Z0-9-]{8,100}$/.test(entry.id) && typeof entry.url === "string" && /^\/api\/calendar-events(?:\/[^/?#]+(?:\/response)?)?(?:\?[^#]*)?$/.test(entry.url) && ["POST", "PATCH", "DELETE"].includes(entry.method) && entry.event && typeof entry.event.id === "string" && (entry.body === undefined || typeof entry.body === "string")).slice(0, 100) : [];
    } catch { return []; }
  }, [key]);
  const save = useCallback((next: CalendarQueuedOperation[]) => {
    localStorage.setItem(key, JSON.stringify(next));
    setOperations(next);
  }, [key]);
  useEffect(() => {
    setOperations(read());
    let running = false;
    let stopped = false;
    const replay = async () => {
      if (running || stopped || !navigator.onLine) return;
      running = true;
      try {
        for (const operation of read()) {
          if (stopped || operation.error) continue;
          try {
            const response = await fetch(operation.url, { method: operation.method, headers: { "Content-Type": "application/json", "x-calendar-operation-id": operation.id }, body: operation.body });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.message ?? "离线修改同步失败");
            if (stopped) return;
            save(read().filter((item) => item.id !== operation.id));
            window.dispatchEvent(new Event("kalender:calendar-synced"));
          } catch (error) {
            if (stopped) return;
            save(read().map((item) => item.id === operation.id ? { ...item, error: error instanceof Error ? error.message : "同步结果未确认，请重试或核对日历" } : item));
            break;
          }
        }
      } finally { running = false; }
    };
    const run = () => { void replay(); };
    window.addEventListener("online", run);
    window.addEventListener("calendar-outbox-retry", run);
    run();
    return () => { stopped = true; window.removeEventListener("online", run); window.removeEventListener("calendar-outbox-retry", run); };
  }, [read, save]);

  const request = async (url: string, init: RequestInit, original?: Record<string, unknown>) => {
    if (navigator.onLine) return fetch(url, init);
    const id = crypto.randomUUID();
    const body = typeof init.body === "string" ? init.body : undefined;
    const fields = body ? JSON.parse(body) : {};
    const event = { status: "confirmed", allDay: false, ...original, ...fields, id: String(original?.id ?? `offline:${id}`), providerData: { ...original?.providerData as object, pendingSync: true } };
    const current = read();
    if (current.length >= 100) throw new Error("待同步修改已达 100 条，请先联网同步");
    save([...current, { id, url, method: init.method ?? "POST", body, event }]);
    return Response.json({ ok: true, queued: true, event }, { status: 202 });
  };
  const discard = (id: string) => { save(read().filter((item) => item.id !== id)); window.dispatchEvent(new Event("kalender:calendar-synced")); };
  const retry = (id: string) => { save(read().map((item) => item.id === id ? { ...item, error: undefined } : item)); window.dispatchEvent(new Event("calendar-outbox-retry")); };
  return { operations, request, discard, retry };
}
