"use client";

import { CalendarDays, CheckCircle2, FileText, Folder, ListChecks, LoaderCircle, Mail, Menu, NotebookPen, PanelRightClose, PanelRightOpen, Plus, Search, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

import { ContextMenu } from "./context-menu";
import type { ContextCommandId, ResolvedContextCommand } from "./context-commands";
import { AppSelect } from "./app-select";
import { DesktopWindowControls } from "./desktop-window-titlebar";
import { DateTimeField } from "./ui/date-time-field";

interface SearchResult {
  readonly id: string;
  readonly kind: "mail" | "task" | "calendar" | "note" | "project" | "ai";
  readonly title: string;
  readonly subtitle: string;
  readonly snippet?: string;
  readonly href: string;
}

interface SearchContextMenuState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

type CaptureKind = "task" | "note" | "calendar";

interface WritableCalendar {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: { readonly providerId?: string };
}

export function GlobalCommandBar({
  onOpenSidebar,
  assistantAvailable = false,
  assistantOpen = false,
  onToggleAssistant,
}: {
  readonly onOpenSidebar: () => void;
  readonly assistantAvailable?: boolean;
  readonly assistantOpen?: boolean;
  readonly onToggleAssistant?: () => void;
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [error, setError] = useState("");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<SearchContextMenuState>();

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
          if (!response.ok || !payload.results) throw new Error(payload.message ?? "Suche ist vorerst nicht verfügbar");
          setResults(payload.results);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Suche ist vorerst nicht verfügbar");
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

  const contextResult = contextMenu ? results.find((result) => result.id === contextMenu.id) : undefined;
  const searchCommands: readonly ResolvedContextCommand[] = contextResult ? [
    { id: "search.open", label: "Offenes Ergebnis", group: "primary", risk: "read", icon: "open" },
    { id: "search.copy-link", label: "Kopieren von Links", group: "primary", risk: "read", icon: "copy" },
    { id: "search.copy-title", label: "Titel kopieren", group: "primary", risk: "read", icon: "info" },
  ] : [];

  const openSearchMenu = (event: ReactMouseEvent<HTMLElement>, result: SearchResult) => {
    event.preventDefault();
    setContextMenu({ id: result.id, x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
  };

  const openSearchMenuFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>, result: SearchResult) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setContextMenu({ id: result.id, x: bounds.right - 12, y: bounds.top + 28, returnFocus: event.currentTarget });
  };

  const selectSearchCommand = (commandId: ContextCommandId) => {
    if (!contextResult) return;
    if (commandId === "search.open") openResult(contextResult);
    if (commandId === "search.copy-link") void copyCommandText(`${window.location.origin}${contextResult.href}`);
    if (commandId === "search.copy-title") void copyCommandText(contextResult.title);
  };

  return (
    <>
      <header className="command-bar">
        <button className="mobile-menu" aria-label="Navigator öffnen" onClick={onOpenSidebar}><Menu /></button>
        <div className="global-command" ref={rootRef}>
          <label className={`command-input ${open ? "active" : ""}`}>
            <Search size={17} />
            <input ref={inputRef} value={query} onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} placeholder="E-Mails, Aufgaben, Termine und Notizen durchsuchen …" />
            {query ? <button type="button" aria-label="Suchen löschen" onClick={() => setQuery("")}><X size={14} /></button> : <kbd>⌘ K</kbd>}
          </label>
          {open && (
            <section className="command-palette panel" aria-label="globale Suchergebnisse">
              {query.trim().length < 2 ? (
                <div className="command-empty"><Search size={20} /><div><strong>Durchsuchen Sie die gesamte Workstation</strong><span>Geben Sie mindestens zwei Zeichen ein, um E-Mail, Aufgaben, Kalenderereignisse und Notizen zu finden.</span></div></div>
              ) : loading ? (
                <div className="command-empty"><LoaderCircle className="spin" size={18} />Suchen...</div>
              ) : error ? (
                <div className="command-empty error">{error}</div>
              ) : results.length ? (
                <div className="command-results">
                  {results.map((result) => {
                    const Icon = result.kind === "mail" ? Mail : result.kind === "task" ? ListChecks : result.kind === "calendar" ? CalendarDays : result.kind === "project" ? Folder : result.kind === "ai" ? Sparkles : NotebookPen;
                    return (
                      <button
                        key={`${result.kind}:${result.id}`}
                        onClick={() => openResult(result)}
                        onContextMenu={(event) => openSearchMenu(event, result)}
                        onKeyDown={(event) => openSearchMenuFromKeyboard(event, result)}
                      >
                        <span className={`command-result-icon ${result.kind}`}><Icon size={16} /></span><span><strong>{result.title}</strong><small>{result.subtitle}</small>{result.snippet && <em>{result.snippet}</em>}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="command-empty"><FileText size={19} /><div><strong>keine Ergebnisse gefunden</strong><span>Versuchen Sie einen neuen Titel, Absender oder Projektnamen.</span></div></div>
              )}
              <footer><span><kbd>Enter</kbd> Offenes Ergebnis</span><span><kbd>Esc</kbd> Schließen</span></footer>
            </section>
          )}
          {contextMenu && contextResult && (
            <ContextMenu
              anchor={{ x: contextMenu.x, y: contextMenu.y }}
              ariaLabel={`Suchergebnis-Operation:${contextResult.title}`}
              commands={searchCommands}
              heading={contextResult.title}
              returnFocus={contextMenu.returnFocus}
              testId="search-context-menu"
              onClose={() => setContextMenu(undefined)}
              onSelect={selectSearchCommand}
            />
          )}
        </div>
        <button className="quick-add" onClick={() => setCaptureOpen(true)}><Plus size={17} />Schnelle Aufzeichnung</button>
        {assistantAvailable && <button
          className={`assistant-toggle ${assistantOpen ? "active" : ""}`}
          type="button"
          aria-label={assistantOpen ? "Kontext-Assistent zum Drop" : "Kontext-Assistent öffnen"}
          aria-pressed={assistantOpen}
          title={assistantOpen ? "Kontext-Assistent zum Drop" : "Kontext-Assistent öffnen"}
          onClick={onToggleAssistant}
        >
          {assistantOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </button>}
        <DesktopWindowControls />
      </header>
      {captureOpen && <QuickCaptureDialog onClose={() => setCaptureOpen(false)} onCreated={(href) => { setCaptureOpen(false); router.push(href); }} />}
    </>
  );
}

async function copyCommandText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value).catch(() => undefined);
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
        if (!calendarId) throw new Error("kein lokaler Kalender zum Schreiben");
        const start = new Date(startLocal);
        if (Number.isNaN(start.getTime())) throw new Error("ungültige Startzeit");
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        response = await fetch("/api/calendar-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calendarId, title, description: details || undefined, start: start.toISOString(), end: end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin", allDay: false }) });
      }
      const payload = await response.json() as { readonly task?: { readonly id: string }; readonly note?: { readonly id: string }; readonly event?: { readonly id: string; readonly start: string }; readonly message?: string };
      if (!response.ok) throw new Error(payload.message ?? "kein schneller Datensatz gespeichert werden kann");
      if (kind === "task" && payload.task) onCreated(`/tasks?task=${encodeURIComponent(payload.task.id)}`);
      else if (kind === "note" && payload.note) onCreated(`/notes?note=${encodeURIComponent(payload.note.id)}`);
      else if (kind === "calendar" && payload.event) onCreated(`/calendar?event=${encodeURIComponent(payload.event.id)}&date=${encodeURIComponent(payload.event.start)}`);
      else throw new Error("erfolgreich gespeichert, aber unvollständige Daten zurückgegeben");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "kein schneller Datensatz gespeichert werden kann");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-capture-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="quick-capture panel" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title" onSubmit={(event) => void submit(event)}>
        <header><div><h2 id="quick-capture-title">Schnelle Aufzeichnung</h2></div><button type="button" aria-label="Schließen" disabled={busy} onClick={onClose}><X size={18} /></button></header>
        <nav aria-label="Art des Datensatzes">
          {(["task", "note", "calendar"] as const).map((item) => {
            const Icon = item === "task" ? CheckCircle2 : item === "note" ? NotebookPen : CalendarDays;
            return <button type="button" className={kind === item ? "active" : ""} key={item} onClick={() => setKind(item)}><Icon size={15} />{item === "task" ? "Aufgabe" : item === "note" ? "Notiz" : "Termin"}</button>;
          })}
        </nav>
        <label><span>Titel</span><input autoFocus value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "task" ? "Was willst du erreichen?" : kind === "note" ? "nächste Idee schreiben" : "Warenbezeichnung"} /></label>
        {kind === "calendar" && <div className="quick-capture-row"><DateTimeField label="Startzeit" value={startLocal} onChange={setStartLocal} /><label><span>Kalender</span><AppSelect ariaLabel="Schnellaufzeichnungs-Kalender" value={calendarId} onValueChange={setCalendarId} options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))} /></label></div>}
        <label><span>{kind === "task" ? "Notizen" : kind === "note" ? "Körper" : "Beschreibung"}</span><textarea value={details} maxLength={10_000} onChange={(event) => setDetails(event.target.value)} placeholder="fakultativ" /></label>
        {error && <div className="quick-capture-error" role="alert">{error}</div>}
        <footer><div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Abbrechen</button><button className="primary-button" disabled={busy || !title.trim()}>{busy && <LoaderCircle className="spin" size={14} />}Speichern</button></div></footer>
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
