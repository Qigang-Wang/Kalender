"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  AlertCircle, ArrowRight, Check, ChevronDown, ChevronLeft, FileText, Folder,
  FolderPlus, Inbox, Link2, LoaderCircle, MoreHorizontal, NotebookPen, Pencil,
  Pin, Plus, Search, Trash2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EMPTY_PLATE_NOTE_CONTENT, noteContentToPlainText } from "@/lib/note-content";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";
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
  general: "普通笔记",
  meeting: "会议记录",
  email: "邮件笔记",
  project: "项目文档",
  daily: "每日笔记",
};

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

const PlateNoteEditor = dynamic(
  () => import("../editor/plate-editor").then((module) => module.PlateNoteEditor),
  { loading: () => <EditorLoading label="正在加载笔记编辑器…" />, ssr: false },
);

export function NotesPage({ initialNoteId }: { readonly initialNoteId?: string }) {
  const [projects, setProjects] = useState<readonly ClientProject[]>([]);
  const [notes, setNotes] = useState<readonly ClientNote[]>([]);
  const [filter, setFilter] = useState<NoteFilter>("all");
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
  const openedInitialNote = useRef(false);
  const noteTitleRef = useRef<HTMLInputElement>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const [projectsResponse, notesResponse] = await Promise.all([
      workspaceFetch("/api/projects"),
      workspaceFetch("/api/notes"),
      ]);
      const projectsPayload = await projectsResponse.json() as { readonly ok: boolean; readonly projects?: readonly ClientProject[]; readonly message?: string };
      const notesPayload = await notesResponse.json() as { readonly ok: boolean; readonly notes?: readonly ClientNote[]; readonly message?: string };
      if (!projectsResponse.ok || !projectsPayload.ok) throw new Error(projectsPayload.message ?? "无法读取项目");
      if (!notesResponse.ok || !notesPayload.ok) throw new Error(notesPayload.message ?? "无法读取笔记");
      const loadedNotes = notesPayload.notes ?? [];
      setProjects(projectsPayload.projects ?? []);
      setNotes(loadedNotes);
      const target = initialNoteId ? loadedNotes.find((note) => note.id === initialNoteId) : loadedNotes[0];
      setDraft(target);
      if (initialNoteId && !target) setFeedback("关联笔记已删除");
      else setFeedback(undefined);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取笔记工作区");
    } finally {
      setLoading(false);
    }
  }, [initialNoteId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const persistNote = useCallback(async (snapshot: ClientNote): Promise<ClientNote | undefined> => {
    setSaveState("saving");
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(snapshot.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.projectId,
          title: snapshot.title.trim() || "无标题笔记",
          content: snapshot.content,
          noteType: snapshot.noteType,
          pinned: snapshot.pinned,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法保存笔记");
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
      setFeedback(error instanceof Error ? error.message : "无法保存笔记");
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
        body: JSON.stringify({ projectId, title: "无标题笔记", content: EMPTY_PLATE_NOTE_CONTENT, noteType: "general", pinned: false }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建笔记");
      setNotes((current) => [payload.note!, ...current]);
      setDraft(payload.note);
      setMobileNoteDetail(true);
      setFeedback("笔记已创建，可以直接开始输入");
      setSaveState("saved");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建笔记");
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
      setFeedback("已打开任务关联的笔记");
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
    if (!target || !window.confirm(`删除笔记“${target.title}”？关联任务会保留，但不再显示此来源。`)) return;
    setBusy(true);
    try {
      if (target.id === draft?.id) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        pendingNote.current = undefined;
      }
      const response = await fetch(`/api/notes/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly ok: boolean; readonly message?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法删除笔记");
      const remaining = notes.filter((note) => note.id !== target.id);
      setNotes(remaining);
      setDraft((current) => current?.id === target.id ? remaining[0] : current);
      setFeedback("笔记已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除笔记");
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
          title: snapshot.title.trim() || "无标题笔记",
          content: snapshot.content,
          noteType: snapshot.noteType,
          pinned: snapshot.pinned,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法更新笔记");
      setNotes((current) => current.map((entry) => entry.id === payload.note!.id ? payload.note! : entry));
      setDraft((current) => current?.id === payload.note!.id ? payload.note : current);
      setSaveState("saved");
      setFeedback(payload.note.pinned ? "笔记已置顶" : "已取消置顶");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法更新笔记");
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
          title: `${source.title.slice(0, 237)} 副本`,
          content: source.content,
          noteType: source.noteType,
          pinned: false,
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly note?: ClientNote; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.note) throw new Error(payload.message ?? "无法创建笔记副本");
      setNotes((current) => [payload.note!, ...current]);
      setDraft(payload.note);
      setSaveState("saved");
      setFeedback("笔记副本已创建");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建笔记副本");
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
          title: `跟进：${note.title}`,
          notes: plainText.slice(0, 1_500) || undefined,
          status: "inbox",
          projectName: note.projectName,
          sourceReferences: [{ kind: "note", sourceId: note.id, label: note.title, href: `/notes?note=${encodeURIComponent(note.id)}` }],
        }),
      });
      const payload = await response.json() as { readonly ok: boolean; readonly task?: ClientTask; readonly message?: string };
      if (!response.ok || !payload.ok || !payload.task) throw new Error(payload.message ?? "无法创建关联任务");
      const linkedTask: ClientLinkedNoteTask = { id: payload.task.id, title: payload.task.title, status: payload.task.status, href: `/tasks?task=${encodeURIComponent(payload.task.id)}` };
      const withTask = { ...note, linkedTasks: [linkedTask, ...note.linkedTasks.filter((task) => task.id !== linkedTask.id)] };
      setDraft(withTask);
      setNotes((current) => current.map((entry) => entry.id === note.id ? withTask : entry));
      setRelatedVersion((current) => current + 1);
      setFeedback("关联任务已创建，可从笔记或任务双向返回");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建关联任务");
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
      if (!response.ok || !payload.ok || !payload.project) throw new Error(payload.message ?? "无法创建项目");
      setProjects((current) => [payload.project!, ...current]);
      setFilter(payload.project.id);
      setProjectDraft(undefined);
      setFeedback(`项目“${payload.project.name}”已创建`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法创建项目");
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
    ? "全部笔记"
    : filter === "pinned"
      ? "已置顶"
      : filter === "unfiled"
        ? "未归档"
        : projects.find((project) => project.id === filter)?.name ?? "项目笔记";
  const menuNote = notes.find((note) => note.id === noteMenu?.noteId);

  return (
    <div className={`notes-page ${mobileNoteDetail ? "mobile-detail-open" : ""}`}>
      <section className="notes-filter-bar" aria-label="笔记空间">
        <nav className="notes-filter-scroll" aria-label="笔记筛选">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}><FileText size={15} /><span>全部</span><em>{notes.length}</em></button>
          <button className={filter === "pinned" ? "active" : ""} onClick={() => setFilter("pinned")}><Pin size={15} /><span>置顶</span><em>{notes.filter((note) => note.pinned).length}</em></button>
          <button className={filter === "unfiled" ? "active" : ""} onClick={() => setFilter("unfiled")}><Inbox size={15} /><span>未归档</span><em>{notes.filter((note) => !note.projectId).length}</em></button>
          {projects.length > 0 && <span className="notes-filter-divider" aria-hidden="true" />}
          {projects.map((project) => <button className={`project-filter ${filter === project.id ? "active" : ""}`} key={project.id} onClick={() => setFilter(project.id)}><i style={{ background: project.color }} /><span>{project.name}</span><em>{notes.filter((note) => note.projectId === project.id).length}</em></button>)}
        </nav>
        <button className="notes-new-project" aria-label="新建项目" title="新建项目" onClick={() => setProjectDraft({ name: "", description: "", areaName: "", color: "#86bdf5" })}><FolderPlus size={16} /><span>新建项目</span></button>
      </section>

      <div className={`notes-workspace ${mobileNoteDetail ? "mobile-detail-open" : ""}`}>
        <section className="notes-list-column">
        <header>
          <div className="notes-list-heading"><span><strong>{activeFilterLabel}</strong><small>{filteredNotes.length} 篇</small></span><div>{filter !== "all" && filter !== "pinned" && filter !== "unfiled" && <Link className="notes-open-project" href={`/projects?project=${encodeURIComponent(filter)}`} aria-label={`打开项目主页：${activeFilterLabel}`} title="打开项目主页"><ArrowRight size={15} /></Link>}<button aria-label="新建笔记" title="新建笔记" disabled={busy} onClick={() => void createNote()}><Plus size={17} /></button></div></div>
          <label><Search size={16} /><input aria-label="搜索笔记" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或正文…" /></label>
        </header>
        {feedback && <TransientToast message={feedback} onClose={() => setFeedback(undefined)} />}
        <div className="notes-list">
          {loading ? <div className="notes-list-empty"><LoaderCircle className="spin" size={17} />正在读取笔记…</div> : filteredNotes.map((note) => (
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
                <p>{noteContentToPlainText(note.content).trim().replace(/\s+/g, " ") || "空白笔记"}</p>
                <span className="note-list-meta">
                  <span>{note.projectColor && <i style={{ background: note.projectColor }} />}{note.projectName ?? noteTypeLabels[note.noteType]}</span>
                  <time dateTime={note.updatedAt}>{formatNoteUpdated(note.updatedAt)}</time>
                </span>
              </button>
              <button
                className="note-menu-trigger"
                aria-label={`更多操作：${note.title}`}
                aria-expanded={noteMenu?.noteId === note.id}
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openNoteMenu(note, bounds.right, bounds.bottom + 4, event.currentTarget);
                }}
              ><MoreHorizontal size={16} /></button>
            </div>
          ))}
          {!loading && !filteredNotes.length && <div className="notes-list-empty"><NotebookPen size={20} /><span>{query ? "没有匹配的笔记" : "这个位置还没有笔记"}</span><button onClick={() => void createNote()}>创建第一篇</button></div>}
        </div>
        </section>

        <article className="note-editor">
        {draft ? <>
          <header className="note-editor-toolbar">
            <div>
              <button className="mobile-detail-back" aria-label="返回笔记列表" onClick={() => setMobileNoteDetail(false)}><ChevronLeft size={20} /></button>
              <select aria-label="笔记所属项目" value={draft.projectId ?? ""} onChange={(event) => {
                const project = projects.find((entry) => entry.id === event.target.value);
                updateDraft({ projectId: project?.id, projectName: project?.name, projectColor: project?.color });
              }}><option value="">未归档</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
              <select aria-label="笔记类型" value={draft.noteType} onChange={(event) => updateDraft({ noteType: event.target.value as ClientNoteType })}>{Object.entries(noteTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
              <input ref={noteTitleRef} className="note-title-inline" aria-label="笔记标题" value={draft.title} maxLength={240} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="无标题笔记" />
            </div>
            <div>
              <span className={`note-save-state ${saveState}`}><i />{saveState === "saving" ? "正在保存" : saveState === "error" ? "保存失败" : "已保存"}</span>
              <button className={draft.pinned ? "active" : ""} aria-label={draft.pinned ? "取消置顶" : "置顶笔记"} title={draft.pinned ? "取消置顶" : "置顶笔记"} onClick={() => updateDraft({ pinned: !draft.pinned })}><Pin size={15} fill={draft.pinned ? "currentColor" : "none"} /></button>
              <button className="danger-button" aria-label="删除笔记" title="删除笔记" disabled={busy} onClick={() => void deleteNote()}><Trash2 size={15} /></button>
            </div>
          </header>
          <div className="note-editor-body">
            <PlateNoteEditor noteId={draft.id} content={draft.content} onChange={(content) => updateDraft({ content })} />
          </div>
          <footer className="note-relations">
            <div className="note-relations-heading"><span><Link2 size={14} />关联任务</span><button className="secondary-button" disabled={busy} onClick={() => void createLinkedTask()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}转为任务</button></div>
            <RelatedContentPanel kind="note" entityId={draft.id} refreshKey={relatedVersion} hideHeading emptyText="还没有相关内容。创建任务或从日程建立会议笔记后会显示在这里。" />
          </footer>
        </> : <div className="note-editor-empty"><NotebookPen size={28} /><h3>选择一篇笔记开始</h3><p>笔记会自动保存，并可以归入项目或转为任务。</p><button className="primary-button" onClick={() => void createNote()}><Plus size={14} />新建笔记</button></div>}
        </article>
      </div>

      {noteMenu && menuNote && <ContextMenu
        anchor={{ x: noteMenu.x, y: noteMenu.y }}
        ariaLabel="笔记操作"
        heading={menuNote.title}
        commands={resolveContextCommands({ kind: "note", id: menuNote.id, title: menuNote.title, busy, pinned: menuNote.pinned })}
        returnFocus={noteMenu.returnFocus}
        testId="note-context-menu"
        onClose={() => setNoteMenu(undefined)}
        onSelect={(commandId) => handleNoteCommand(commandId as NoteCommandId)}
      />}

      {projectDraft && <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setProjectDraft(undefined); }}>
        <section className="calendar-dialog note-project-dialog panel" role="dialog" aria-modal="true" aria-labelledby="note-project-dialog-title">
          <header><div><span>让笔记、任务和日程共享一个上下文</span><h2 id="note-project-dialog-title">新建项目</h2></div><button aria-label="关闭" onClick={() => setProjectDraft(undefined)} disabled={busy}><X size={18} /></button></header>
          <div className="note-project-form">
            <label><span>项目名称</span><input autoFocus value={projectDraft.name} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="例如 Kalender 开发" /></label>
            <label><span>领域</span><input value={projectDraft.areaName} maxLength={100} onChange={(event) => setProjectDraft({ ...projectDraft, areaName: event.target.value })} placeholder="例如 工作 / 个人" /></label>
            <label className="note-project-color"><span>颜色</span><input type="color" value={projectDraft.color} onChange={(event) => setProjectDraft({ ...projectDraft, color: event.target.value })} /></label>
            <label className="note-project-description"><span>项目说明</span><textarea value={projectDraft.description} maxLength={2_000} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} placeholder="这个项目要达成什么？" /></label>
          </div>
          <footer><small>后续邮件、日历和任务也会使用同一个项目对象。</small><div><button className="secondary-button" disabled={busy} onClick={() => setProjectDraft(undefined)}>取消</button><button className="primary-button" disabled={busy || !projectDraft.name.trim()} onClick={() => void saveProject()}>{busy && <LoaderCircle className="spin" size={14} />}创建项目</button></div></footer>
        </section>
      </div>}
    </div>
  );
}

function formatNoteUpdated(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }).format(date);
}
