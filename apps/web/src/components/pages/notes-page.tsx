"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle, ArrowRight, Check, ChevronDown, ChevronLeft, FileText, Folder,
  FolderPlus, Inbox, Link2, LoaderCircle, MoreHorizontal, NotebookPen, Pencil,
  Pin, Plus, Search, Trash2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EMPTY_PLATE_NOTE_CONTENT, noteContentToPlainText } from "@/lib/note-content";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { appConfirm } from "@/components/app-dialog-provider";
import { useRealtimeRefresh } from "@/components/realtime-context";
import { AppSelect } from "../app-select";
import { ContextMenu } from "../context-menu";
import { resolveContextCommands, type ContextCommandId, type NoteCommandId } from "../context-commands";
import { TransientToast } from "../workspace-shared";
import { RelatedContentPanel } from "./related-content";

type ClientNoteType = "general" | "meeting" | "email" | "project" | "daily";
type NoteFilter = "all" | "pinned" | "unfiled" | string;
type NoteSaveState = "saved" | "saving" | "error";

interface ClientProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly areaName?: string;
  readonly color: string;
  readonly status: "active" | "archived";
  readonly noteCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectDraft {
  readonly name: string;
  readonly description: string;
  readonly areaName: string;
  readonly color: string;
}

interface ClientLinkedNoteTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly href: string;
}

interface ClientNote {
  readonly id: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectColor?: string;
  readonly title: string;
  readonly content: string;
  readonly noteType: ClientNoteType;
  readonly pinned: boolean;
  readonly linkedTasks: readonly ClientLinkedNoteTask[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ClientTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

interface NoteContextMenuState {
  readonly noteId: string;
  readonly x: number;
  readonly y: number;
  readonly returnFocus?: HTMLElement | null;
}

const noteTypeLabels: Record<ClientNoteType, string> = {
  general: "normale Noten",
  meeting: "Sitzungsprotokolle",
  email: "Briefbriefe",
  project: "Projektdokument",
  daily: "Tagesnoten",
};

const PROJECTS_CHANGED_EVENT = "kalender:projects-changed";
const OPEN_PROJECT_DIALOG_EVENT = "kalender:open-project-dialog";

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

const PlateNoteEditor = dynamic(
  () => import("../editor/plate-editor").then((module) => module.PlateNoteEditor),
  { loading: () => <EditorLoading label="Notizeditor wird geladen..." />, ssr: false },
);

export function NotesPage({
  initialNoteId,
  initialFilter,
  initialProjectId,
}: {
  readonly initialNoteId?: string;
  readonly initialFilter?: "pinned" | "unfiled";
  readonly initialProjectId?: string;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<readonly ClientProject[]>([]);
  const [notes, setNotes] = useState<readonly ClientNote[]>([]);
  const [filter, setFilter] = useState<NoteFilter>(initialProjectId ?? initialFilter ?? "all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ClientNote>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [saveState, setSaveState] = useState<NoteSaveState>("saved");
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>();
  const [noteMenu, setNoteMenu] = useState<NoteContextMenuState>();
  const [relatedVersion, setRelatedVersion] = useState(0);
  const [mobileNoteDetail, setMobileNoteDetail] = useState(Boolean(initialNoteId));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingNote = useRef<ClientNote | undefined>(undefined);
  const selectedNoteId = useRef<string | undefined>(undefined);
  const openedInitialNote = useRef(false);
  const noteTitleRef = useRef<HTMLInputElement>(null);

  selectedNoteId.current = draft?.id;

  const selectFilter = useCallback((nextFilter: NoteFilter) => {
    setFilter(nextFilter);
    const href = nextFilter === "all"
      ? "/notes"
      : nextFilter === "pinned" || nextFilter === "unfiled"
        ? `/notes?filter=${nextFilter}`
        : `/notes?project=${encodeURIComponent(nextFilter)}`;
    router.replace(href, { scroll: false });
  }, [router]);

  const loadWorkspace = useCallback(async ({ background = false }: { readonly background?: boolean } = {}) => {
    if (!background) setLoading(true);
    try {
      const [projectsResponse, notesResponse] = await Promise.all([
      workspaceFetch("/api/projects"),
      workspaceFetch("/api/notes"),
      ]);
      const projectsPayload = await projectsResponse.json() as { readonly ok: boolean; readonly projects?: readonly ClientProject[]; readonly message?: string };
      const notesPayload = await notesResponse.json() as { readonly ok: boolean; readonly notes?: readonly ClientNote[]; readonly message?: string };
      if (!projectsResponse.ok || !projectsPayload.ok) throw new Error(projectsPayload.message ?? "Projekt kann nicht gelesen werden");
      if (!notesResponse.ok || !notesPayload.ok) throw new Error(notesPayload.message ?? "Noten können nicht gelesen werden");
      const loadedNotes = notesPayload.notes ?? [];
      setProjects(projectsPayload.projects ?? []);
      setNotes(loadedNotes);
      const requestedId = background ? selectedNoteId.current : initialNoteId;
      const target = requestedId
        ? loadedNotes.find((note) => note.id === requestedId)
        : initialProjectId
          ? loadedNotes.find((note) => note.projectId === initialProjectId)
          : loadedNotes[0];
      if (!background || !pendingNote.current) setDraft(target);
      if (!background) {
        if (initialNoteId && !target) setFeedback("Assoziationshinweise gelöscht");
        else setFeedback(undefined);
      }
    } catch (error) {
      if (!background) setFeedback(error instanceof Error ? error.message : "es ist nicht möglich, den Notiz-Workspace zu lesen");
    } finally {
      if (!background) setLoading(false);
    }
  }, [initialNoteId, initialProjectId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useRealtimeRefresh(["note", "project", "task", "relation"], () => (
    pendingNote.current ? undefined : loadWorkspace({ background: true })
  ));
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  useEffect(() => {
    setFilter(initialProjectId ?? initialFilter ?? "all");
    if (!initialProjectId || loading) return;
    setDraft((current) => current?.projectId === initialProjectId
      ? current
      : notes.find((note) => note.projectId === initialProjectId));
  }, [initialFilter, initialProjectId, loading, notes]);
  useEffect(() => {
    const openProjectDialog = (event: Event) => {
      const areaName = (event as CustomEvent<{ readonly areaName?: string }>).detail?.areaName ?? "";
      setProjectDraft({ name: "", description: "", areaName, color: "#86bdf5" });
    };
    window.addEventListener(OPEN_PROJECT_DIALOG_EVENT, openProjectDialog);
    return () => window.removeEventListener(OPEN_PROJECT_DIALOG_EVENT, openProjectDialog);
  }, []);

  const persistNote = useCallback(async (snapshot: ClientNote): Promise<ClientNote | undefined> => {
    setSaveState("saving");
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(snapshot.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.projectId,
          title: snapshot.title.trim() || "nicht betitelte Notizen",
          content: snapshot.content,
          noteType: snapshot.noteType,
          pinned: snapshot.pinned,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "keine Notizen gespeichert werden können");
      const saved = payload.note;
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note));
      if (pendingNote.current === snapshot) {
        pendingNote.current = undefined;
        setDraft((current) => current?.id === saved.id ? saved : current);
        setSaveState("saved");
      }
      return saved;
    } catch (error) {
      if (pendingNote.current === snapshot) setSaveState("error");
      setFeedback(error instanceof Error ? error.message : "keine Notizen gespeichert werden können");
      return undefined;
    }
  }, []);

  const flushPendingNote = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const pending = pendingNote.current;
    return pending ? persistNote(pending) : draft;
  }, [draft, persistNote]);

  const updateDraft = (changes: Partial<Pick<ClientNote, "title" | "content" | "projectId" | "projectName" | "projectColor" | "noteType" | "pinned">>) => {
    if (!draft) return;
    const next = { ...draft, ...changes, updatedAt: new Date().toISOString() };
    setDraft(next);
    setNotes((current) => current.map((note) => note.id === next.id ? next : note));
    pendingNote.current = next;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persistNote(next); }, 700);
  };

  const createNote = useCallback(async () => {
    setBusy(true);
    try {
      await flushPendingNote();
      const projectId = projects.some((project) => project.id === filter) ? filter : undefined;
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "nicht betitelte Notizen", content: EMPTY_PLATE_NOTE_CONTENT, noteType: "general", pinned: false }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "Noten können nicht erstellt werden");
      setNotes((current) => [payload.note!, ...current]);
      setDraft(payload.note);
      setMobileNoteDetail(true);
      setFeedback("Notizen erstellt, um Eingabe direkt zu starten");
      setSaveState("saved");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Noten können nicht erstellt werden");
    } finally {
      setBusy(false);
    }
  }, [filter, flushPendingNote, projects]);

  useEffect(() => {
    if (!initialNoteId || openedInitialNote.current || loading) return;
    openedInitialNote.current = true;
    const target = notes.find((note) => note.id === initialNoteId);
      if (target) {
      setFilter(target.projectId ?? "all");
      setDraft(target);
      setFeedback("Notizen offen für Task-Assoziation");
    }
  }, [initialNoteId, loading, notes]);

  const selectNote = (note: ClientNote) => {
    setMobileNoteDetail(true);
    if (note.id !== draft?.id) {
      void flushPendingNote();
      setDraft(note);
      setSaveState("saved");
    }
  };

  const deleteNote = async (target = draft) => {
    if (!target || !await appConfirm({
      title: `Notiz „${target.title}“ löschen?`,
      description: "Die zugehörige Aufgabe bleibt erhalten, aber diese Notiz wird nicht mehr angezeigt.",
      confirmLabel: "Notiz löschen",
      tone: "danger",
    })) return;
    setBusy(true);
    try {
      if (target.id === draft?.id) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        pendingNote.current = undefined;
      }
      const response = await fetch(`/api/notes/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Notizen können nicht entfernt werden");
      const remaining = notes.filter((note) => note.id !== target.id);
      setNotes(remaining);
      setDraft((current) => current?.id === target.id ? remaining[0] : current);
      setFeedback("Notiz gelöscht");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Notizen können nicht entfernt werden");
    } finally {
      setBusy(false);
    }
  };

  const toggleNotePinned = async (note: ClientNote) => {
    setBusy(true);
    try {
      const source = note.id === draft?.id ? await flushPendingNote() ?? note : note;
      const snapshot = { ...source, pinned: !source.pinned, updatedAt: new Date().toISOString() };
      const response = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.projectId,
          title: snapshot.title.trim() || "nicht betitelte Notizen",
          content: snapshot.content,
          noteType: snapshot.noteType,
          pinned: snapshot.pinned,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "Notizen können nicht aktualisiert werden");
      setNotes((current) => current.map((entry) => entry.id === payload.note!.id ? payload.note! : entry));
      setDraft((current) => current?.id === payload.note!.id ? payload.note : current);
      setSaveState("saved");
      setFeedback(payload.note.pinned ? "Gemerkt" : "aufgedeckt");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Notizen können nicht aktualisiert werden");
    } finally {
      setBusy(false);
    }
  };

  const duplicateNote = async (note: ClientNote) => {
    setBusy(true);
    try {
      const source = note.id === draft?.id ? await flushPendingNote() ?? note : note;
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: source.projectId,
          title: `${source.title.slice(0, 237)} Kopie`,
          content: source.content,
          noteType: source.noteType,
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "kann keine Kopie von Notizen erstellen");
      setNotes((current) => [payload.note!, ...current]);
      setDraft(payload.note);
      setSaveState("saved");
      setFeedback("eine Kopie der Notizen erstellt wurde");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "kann keine Kopie von Notizen erstellen");
    } finally {
      setBusy(false);
    }
  };

  const openNoteMenu = (note: ClientNote, x: number, y: number, returnFocus?: HTMLElement | null) => {
    selectNote(note);
    setNoteMenu({ noteId: note.id, x, y, returnFocus });
  };

  const handleNoteCommand = (commandId: ContextCommandId) => {
    const note = notes.find((entry) => entry.id === noteMenu?.noteId);
    if (!note) return;
    if (commandId === "note.open") selectNote(note);
    if (commandId === "note.rename") {
      selectNote(note);
      window.requestAnimationFrame(() => {
        noteTitleRef.current?.focus();
        noteTitleRef.current?.select();
      });
    }
    if (commandId === "note.toggle-pin") void toggleNotePinned(note);
    if (commandId === "note.duplicate") void duplicateNote(note);
    if (commandId === "note.delete") void deleteNote(note);
  };

  const createLinkedTask = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const note = await flushPendingNote() ?? draft;
      const plainText = noteContentToPlainText(note.content);
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Folgemaßnahmen:${note.title}`,
          notes: plainText.slice(0, 1_500) || undefined,
          status: "inbox",
          projectName: note.projectName,
          sourceReferences: [{ kind: "note", sourceId: note.id, label: note.title, href: `/notes?note=${encodeURIComponent(note.id)}` }],
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly task?: ClientTask; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "Verbindungsaufgabe kann nicht erstellt werden");
      const linkedTask: ClientLinkedNoteTask = { id: payload.task.id, title: payload.task.title, status: payload.task.status, href: `/tasks?task=${encodeURIComponent(payload.task.id)}` };
      const withTask = { ...note, linkedTasks: [linkedTask, ...note.linkedTasks.filter((task) => task.id !== linkedTask.id)] };
      setDraft(withTask);
      setNotes((current) => current.map((entry) => entry.id === note.id ? withTask : entry));
      setRelatedVersion((current) => current + 1);
      setFeedback("Assoziierte Aufgaben werden erstellt und können aus Notizen oder Aufgaben in beide Richtungen zurückgegeben werden");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Verbindungsaufgabe kann nicht erstellt werden");
    } finally {
      setBusy(false);
    }
  };

  const saveProject = async () => {
    if (!projectDraft?.name.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectDraft),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly project?: ClientProject; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.project) throw new Error(payload.message ?? "Projekt kann nicht erstellt werden");
      setProjects((current) => [payload.project!, ...current]);
      selectFilter(payload.project.id);
      setProjectDraft(undefined);
      setFeedback(`Projekt "${payload.project.name}"Erstellt`);
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Projekt kann nicht erstellt werden");
    } finally {
      setBusy(false);
    }
  };

  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return notes.filter((note) => {
      if (filter === "pinned" && !note.pinned) return false;
      if (filter === "unfiled" && note.projectId) return false;
      if (filter !== "all" && filter !== "pinned" && filter !== "unfiled" && note.projectId !== filter) return false;
      return !normalizedQuery || `${note.title}\n${noteContentToPlainText(note.content)}\n${note.projectName ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [filter, notes, query]);
  const activeFilterLabel = filter === "all"
    ? "Alle Notizen"
    : filter === "pinned"
      ? "mit einer Dicke von mehr als 2 mm"
      : filter === "unfiled"
        ? "nicht archiviert"
        : projects.find((project) => project.id === filter)?.name ?? "Hinweis zum Projekt";
  const menuNote = notes.find((note) => note.id === noteMenu?.noteId);

  return (
    <div className={`notes-page ${mobileNoteDetail ? "mobile-detail-open" : ""}`}>
      <section className="notes-filter-bar" aria-label="Notizraum">
        <nav className="notes-filter-scroll" aria-label="Notizfilter">
          <button className={filter === "all" ? "active" : ""} onClick={() => selectFilter("all")}><FileText size={15} /><span>Alle</span><em>{notes.length}</em></button>
          <button className={filter === "pinned" ? "active" : ""} onClick={() => selectFilter("pinned")}><Pin size={15} /><span>nach oben</span><em>{notes.filter((note) => note.pinned).length}</em></button>
          <button className={filter === "unfiled" ? "active" : ""} onClick={() => selectFilter("unfiled")}><Inbox size={15} /><span>nicht archiviert</span><em>{notes.filter((note) => !note.projectId).length}</em></button>
          {projects.length > 0 && <span className="notes-filter-divider" aria-hidden="true" />}
          {projects.map((project) => <button className={`project-filter ${filter === project.id ? "active" : ""}`} key={project.id} onClick={() => selectFilter(project.id)}><i style={{ background: project.color }} /><span>{project.name}</span><em>{notes.filter((note) => note.projectId === project.id).length}</em></button>)}
        </nav>
        <button className="notes-new-project" aria-label="Neues Projekt" title="Neues Projekt" onClick={() => setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5" })}><FolderPlus size={16} /><span>Neues Projekt</span></button>
      </section>

      <div className={`notes-workspace ${mobileNoteDetail ? "mobile-detail-open" : ""}`}>
        <section className="notes-list-column">
        <header>
          <div className="notes-list-heading"><span><strong>{activeFilterLabel}</strong><small>{filteredNotes.length} Notiz(en)</small></span><div>{filter !== "all" && filter !== "pinned" && filter !== "unfiled" && <Link className="notes-open-project" href={`/projects?project=${encodeURIComponent(filter)}`} aria-label={`Projektseite öffnen: ${activeFilterLabel}`} title="Projektseite öffnen"><ArrowRight size={15} /></Link>}<button aria-label="Neue Notiz" title="Neue Notiz" disabled={busy} onClick={() => void createNote()}><Plus size={17} /></button></div></div>
          <label><Search size={16} /><input aria-label="Suchnotizen" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Suche Titel oder Körper..." /></label>
        </header>
        {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
        <div className="notes-list">
          {loading ? <div className="notes-list-empty"><LoaderCircle className="spin" size={17} />Noten lesen...</div> : filteredNotes.map((note) => (
            <div
              className={`note-list-item ${draft?.id === note.id ? "active" : ""}`}
              key={note.id}
              onContextMenu={(event) => {
                event.preventDefault();
                openNoteMenu(note, event.clientX, event.clientY, event.currentTarget.querySelector<HTMLButtonElement>(".note-list-main"));
              }}
            >
              <button
                className="note-list-main"
                onClick={() => selectNote(note)}
                onKeyDown={(event) => {
                  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openNoteMenu(note, bounds.right - 12, bounds.top + 28, event.currentTarget);
                }}
              >
                <span className="note-list-title-row"><strong>{note.title}</strong>{note.pinned && <Pin size={11} fill="currentColor" />}</span>
                <p>{noteContentToPlainText(note.content).trim().replace(/\s+/g, " ") || "Leerzeichen"}</p>
                <span className="note-list-meta">
                  <span>{note.projectColor && <i style={{ background: note.projectColor }} />}{note.projectName ?? noteTypeLabels[note.noteType]}</span>
                  <time dateTime={note.updatedAt}>{formatNoteUpdated(note.updatedAt)}</time>
                </span>
              </button>
              <button
                className="note-menu-trigger"
                aria-label={`mehr Operationen:${note.title}`}
                aria-expanded={noteMenu?.noteId === note.id}
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openNoteMenu(note, bounds.right, bounds.bottom + 4, event.currentTarget);
                }}
              ><MoreHorizontal size={16} /></button>
            </div>
          ))}
          {!loading && !filteredNotes.length && <div className="notes-list-empty"><NotebookPen size={20} /><span>{query ? "keine passenden Notizen" : "dieser Standort wurde nicht festgestellt"}</span><button onClick={() => void createNote()}>Erstellen Sie den ersten Eintrag</button></div>}
        </div>
        </section>

        <article className="note-editor">
        {draft ? <>
          <header className="note-editor-toolbar">
            <div className="note-editor-main-controls">
              <button className="mobile-detail-back" aria-label="gibt die Liste der Notizen zurück" onClick={() => setMobileNoteDetail(false)}><ChevronLeft size={20} /></button>
              <AppSelect ariaLabel="beachten Sie Projekte" className="note-toolbar-project-select" size="compact" value={draft.projectId ?? ""} onValueChange={(projectId) => {
                const project = projects.find((entry) => entry.id === projectId);
                updateDraft({ projectId: project?.id, projectName: project?.name, projectColor: project?.color });
              }} options={[{ value: "", label: "nicht archiviert" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
              <AppSelect ariaLabel="Art der Notiz" className="note-toolbar-type-select" size="compact" value={draft.noteType} onValueChange={(noteType) => updateDraft({ noteType: noteType as ClientNoteType })} options={Object.entries(noteTypeLabels).map(([value, label]) => ({ value, label }))} />
              <input ref={noteTitleRef} className="note-title-inline" aria-label="Titel des Vermerks" value={draft.title} maxLength={240} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="nicht betitelte Notizen" />
            </div>
            <div className="note-editor-actions">
              <span className={`note-save-state ${saveState}`}><i />{saveState === "saving" ? "Speichern" : saveState === "error" ? "Speichern fehlgeschlagen" : "gespeichert"}</span>
              <button className={draft.pinned ? "active" : ""} aria-label={draft.pinned ? "TIP" : "Nach oben-Notizen"} title={draft.pinned ? "TIP" : "Nach oben-Notizen"} onClick={() => updateDraft({ pinned: !draft.pinned })}><Pin size={15} fill={draft.pinned ? "currentColor" : "none"} /></button>
              <button className="danger-button" aria-label="Notiz löschen" title="Notiz löschen" disabled={busy} onClick={() => void deleteNote()}><Trash2 size={15} /></button>
            </div>
          </header>
          <div className="note-editor-body">
            <PlateNoteEditor noteId={draft.id} content={draft.content} onChange={(content) => updateDraft({ content })} />
          </div>
          <footer className="note-relations">
            <div className="note-relations-heading"><span><Link2 size={14} />Zugehörige Aufgaben</span><button className="secondary-button" disabled={busy} onClick={() => void createLinkedTask()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}Umwandlung in Aufgabe</button></div>
            <RelatedContentPanel kind="note" entityId={draft.id} refreshKey={relatedVersion} hideHeading emptyText="es gibt keinen relevanten Inhalt. Erzeugt die Aufgabe oder zeigt die Notizen aus dem Setup-Meeting hier an." />
          </footer>
        </> : <div className="note-editor-empty"><NotebookPen size={28} /><h3>Wählen Sie eine Notiz aus</h3><p>Notizen werden automatisch gespeichert, können Projekten zugeordnet und in Aufgaben umgewandelt werden.</p><button className="primary-button" onClick={() => void createNote()}><Plus size={14} />Neue Notiz</button></div>}
        </article>
      </div>

      {noteMenu && menuNote && <ContextMenu
        anchor={{ x: noteMenu.x, y: noteMenu.y }}
        ariaLabel="beachten Sie Projekte"
        heading={menuNote.title}
        commands={resolveContextCommands({ kind: "note", id: menuNote.id, title: menuNote.title, busy, pinned: menuNote.pinned })}
        returnFocus={noteMenu.returnFocus}
        testId="note-context-menu"
        onClose={() => setNoteMenu(undefined)}
        onSelect={(commandId) => handleNoteCommand(commandId as NoteCommandId)}
      />}

      {projectDraft && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setProjectDraft(undefined); }}>
        <section className="calendar-dialog note-project-dialog panel" role="dialog" aria-modal="true" aria-labelledby="note-project-dialog-title">
          <header><div><h2 id="note-project-dialog-title">Neues Projekt</h2></div><button aria-label="Schließen" onClick={() => setProjectDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="note-project-form">
            <label><span>Projektname</span><input autoFocus value={projectDraft.name} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="z.B. Dayline-Entwicklung" /></label>
            <label><span>Bereich</span><input value={projectDraft.areaName} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, areaName: event.target.value })} placeholder="z.B. Arbeit/Einzelperson" /></label>
            <label className="note-project-color"><span>Farbe</span><input type="color" value={projectDraft.color} onChange={(event) => setProjectDraft({ ...projectDraft, color: event.target.value })} /></label>
            <label className="note-project-description"><span>Projektbeschreibung</span><textarea value={projectDraft.description} maxLength={2_000} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} placeholder="Was wird das Projekt erreichen?" /></label>
          </div>
          <footer><div><button className="secondary-button" disabled={busy} onClick={() => setProjectDraft(undefined)}>Abbrechen</button><button className="primary-button" disabled={busy || !projectDraft.name.trim()} onClick={() => void saveProject()}>{busy && <LoaderCircle className="spin" size={14} />}Projekt erstellen</button></div></footer>
        </section>
      </div>}
    </div>
  );
}

function formatNoteUpdated(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("de-DE", sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }).format(date);
}
