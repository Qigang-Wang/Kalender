"use client";

import { CalendarDays, CheckCircle2, FileText, Inbox, ListChecks, LoaderCircle, Mail, Menu, NotebookPen, Plus, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

interface SearchResult {
  readonly id: string;
  readonly kind: "mail" | "task" | "calendar" | "note";
  readonly title: string;
  readonly subtitle: string;
  readonly snippet?: string;
  readonly href: string;
}

type CaptureKind = "task" | "note" | "calendar";

interface WritableCalendar {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: { readonly providerId?: string };
}

export function GlobalCommandBar({ onOpenSidebar }: { readonly onOpenSidebar: () => void }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [error, setError] = useState("");
  const [captureOpen, setCaptureOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void fetch(`/api/search?query=${encodeURIComponent(normalized)}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const payload = await response.json() as { readonly results?: readonly SearchResult[]; readonly message?: string };
          if (!response.ok || !payload.results) throw new Error(payload.message ?? "搜索暂时不可用");
          setResults(payload.results);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "搜索暂时不可用");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const openResult = (result: SearchResult) => {
    setOpen(false);
    setQuery("");
    router.push(result.href);
  };

  return (
    <>
      <header className="command-bar">
        <button className="mobile-menu" aria-label="打开导航" onClick={onOpenSidebar}><Menu /></button>
        <div className="global-command" ref={rootRef}>
          <label className={`command-input ${open ? "active" : ""}`}>
            <Search size={17} />
            <input ref={inputRef} value={query} onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} placeholder="搜索邮件、任务、日程和笔记…" />
            {query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button> : <kbd>⌘ K</kbd>}
          </label>
          {open && (
            <section className="command-palette panel" aria-label="全局搜索结果">
              {query.trim().length < 2 ? (
                <div className="command-empty"><Search size={20} /><div><strong>搜索整个工作台</strong><span>输入至少两个字符，查找邮件、任务、日程和笔记。</span></div></div>
              ) : loading ? (
                <div className="command-empty"><LoaderCircle className="spin" size={18} />正在搜索…</div>
              ) : error ? (
                <div className="command-empty error">{error}</div>
              ) : results.length ? (
                <div className="command-results">
                  {results.map((result) => {
                    const Icon = result.kind === "mail" ? Mail : result.kind === "task" ? ListChecks : result.kind === "calendar" ? CalendarDays : NotebookPen;
                    return <button key={`${result.kind}:${result.id}`} onClick={() => openResult(result)}><span className={`command-result-icon ${result.kind}`}><Icon size={16} /></span><span><strong>{result.title}</strong><small>{result.subtitle}</small>{result.snippet && <em>{result.snippet}</em>}</span></button>;
                  })}
                </div>
              ) : (
                <div className="command-empty"><FileText size={19} /><div><strong>没有找到结果</strong><span>换一个标题、发件人或项目名称试试。</span></div></div>
              )}
              <footer><span><kbd>Enter</kbd> 打开结果</span><span><kbd>Esc</kbd> 关闭</span></footer>
            </section>
          )}
        </div>
        <button className="quick-add" onClick={() => setCaptureOpen(true)}><Plus size={17} />快速记录</button>
      </header>
      {captureOpen && <QuickCaptureDialog onClose={() => setCaptureOpen(false)} onCreated={(href) => { setCaptureOpen(false); router.push(href); }} />}
    </>
  );
}

function QuickCaptureDialog({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (href: string) => void }) {
  const [kind, setKind] = useState<CaptureKind>("task");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [startLocal, setStartLocal] = useState(() => defaultStartLocal());
  const [calendars, setCalendars] = useState<readonly WritableCalendar[]>([]);
  const [calendarId, setCalendarId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/calendars", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { readonly calendars?: readonly WritableCalendar[] };
      const writable = (payload.calendars ?? []).filter((calendar) => !calendar.readOnly && calendar.providerData?.providerId === "local-calendar");
      setCalendars(writable);
      setCalendarId((writable.find((calendar) => calendar.primary) ?? writable[0])?.id ?? "");
    }).catch(() => setCalendars([]));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      let response: Response;
      if (kind === "task") {
        response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, notes: details || undefined, status: "inbox", important: false, urgencyMode: "auto" }) });
      } else if (kind === "note") {
        response = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content: details, noteType: "general", pinned: false }) });
      } else {
        if (!calendarId) throw new Error("没有可写的本地日历");
        const start = new Date(startLocal);
        if (Number.isNaN(start.getTime())) throw new Error("开始时间无效");
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        response = await fetch("/api/calendar-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calendarId, title, description: details || undefined, start: start.toISOString(), end: end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin", allDay: false }) });
      }
      const payload = await response.json() as { readonly task?: { readonly id: string }; readonly note?: { readonly id: string }; readonly event?: { readonly id: string; readonly start: string }; readonly message?: string };
      if (!response.ok) throw new Error(payload.message ?? "无法保存快速记录");
      if (kind === "task" && payload.task) onCreated(`/tasks?task=${encodeURIComponent(payload.task.id)}`);
      else if (kind === "note" && payload.note) onCreated(`/notes?note=${encodeURIComponent(payload.note.id)}`);
      else if (kind === "calendar" && payload.event) onCreated(`/calendar?event=${encodeURIComponent(payload.event.id)}&date=${encodeURIComponent(payload.event.start)}`);
      else throw new Error("保存成功，但返回的数据不完整");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存快速记录");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-capture-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="quick-capture panel" onSubmit={(event) => void submit(event)}>
        <header><div><span>不用离开当前页面</span><h2>快速记录</h2></div><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></header>
        <nav aria-label="记录类型">
          {(["task", "note", "calendar"] as const).map((item) => {
            const Icon = item === "task" ? CheckCircle2 : item === "note" ? NotebookPen : CalendarDays;
            return <button type="button" className={kind === item ? "active" : ""} key={item} onClick={() => setKind(item)}><Icon size={15} />{item === "task" ? "任务" : item === "note" ? "笔记" : "日程"}</button>;
          })}
        </nav>
        <label><span>标题</span><input autoFocus value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "task" ? "要完成什么？" : kind === "note" ? "记下一个想法" : "日程名称"} /></label>
        {kind === "calendar" && <div className="quick-capture-row"><label><span>开始时间</span><input type="datetime-local" value={startLocal} onChange={(event) => setStartLocal(event.target.value)} /></label><label><span>日历</span><select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>{calendars.map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}</select></label></div>}
        <label><span>{kind === "task" ? "备注" : kind === "note" ? "正文" : "说明"}</span><textarea value={details} maxLength={10_000} onChange={(event) => setDetails(event.target.value)} placeholder="可选" /></label>
        {error && <div className="quick-capture-error" role="alert">{error}</div>}
        <footer><small>{kind === "task" ? "任务会进入 Inbox，稍后再设置优先级。" : kind === "note" ? "笔记创建后会直接打开编辑器。" : "快速日程默认持续 1 小时。"}</small><div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !title.trim()}>{busy && <LoaderCircle className="spin" size={14} />}保存</button></div></footer>
      </form>
    </div>
  );
}

function defaultStartLocal(): string {
  const value = new Date();
  value.setMinutes(0, 0, 0);
  value.setHours(value.getHours() + 1);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
