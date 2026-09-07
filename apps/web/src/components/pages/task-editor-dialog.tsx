"use client";

import { List, ListOrdered, ListTodo, LoaderCircle, Star, X } from "lucide-react";
import { useRef } from "react";

import { AppSelect } from "../app-select";
import { DateTimeField } from "../ui/date-time-field";
import { formatTaskNotesList, type TaskNotesListKind } from "../../lib/task-notes";
import { RelatedContentPanel } from "./related-content";

type EditorTaskStatus = "inbox" | "next" | "waiting" | "someday" | "done";
type EditorUrgencyMode = "auto" | "urgent" | "not_urgent";

interface EditorTaskSource {
  readonly id: string;
  readonly kind: "mail" | "calendar" | "note";
  readonly sourceId: string;
  readonly label: string;
  readonly href?: string;
}

export interface SharedTaskEditorDraft {
  readonly id?: string;
  readonly sourceReferences: readonly EditorTaskSource[];
  title: string;
  notes: string;
  status: EditorTaskStatus;
  important: boolean;
  urgencyMode: EditorUrgencyMode;
  dueAt: string;
  estimatedMinutes: string;
  projectId: string;
  planItemId: string;
  projectName: string;
  areaName: string;
  assigneeUserId: string;
}

interface EditorProject {
  readonly id: string;
  readonly name: string;
  readonly areaName?: string;
  readonly status: "active" | "archived";
}

interface EditorPlanItem {
  readonly id: string;
  readonly title: string;
  readonly status: "planned" | "in_progress" | "paused" | "done" | "cancelled";
}

export interface SharedTaskEditorTimeBlock {
  readonly eventId: string;
  readonly calendarName: string;
  readonly start: string;
  readonly end: string;
  readonly href: string;
}

interface EditorTaskDetails {
  readonly id: string;
  readonly scheduledBlocks: readonly SharedTaskEditorTimeBlock[];
}

export function TaskEditorDialog({
  draft,
  projects,
  planItems,
  busy,
  onDraftChange,
  onClose,
  onSave,
}: {
  readonly draft: SharedTaskEditorDraft;
  readonly projects: readonly EditorProject[];
  readonly planItems: readonly EditorPlanItem[];
  readonly editingTask?: EditorTaskDetails;
  readonly busy: boolean;
  readonly scheduleBusy?: boolean;
  readonly onDraftChange: (draft: SharedTaskEditorDraft) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly onSchedule?: (block?: SharedTaskEditorTimeBlock) => void;
  readonly onDeleteTimeBlock?: (block: SharedTaskEditorTimeBlock) => void;
}) {
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const update = (changes: Partial<SharedTaskEditorDraft>) => onDraftChange({ ...draft, ...changes });
  const applyList = (kind: TaskNotesListKind) => {
    const textarea = notesRef.current;
    if (!textarea) return;
    const formatted = formatTaskNotesList(draft.notes, textarea.selectionStart, textarea.selectionEnd, kind);
    update({ notes: formatted.value });
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(formatted.selectionStart, formatted.selectionEnd);
    });
  };

  return <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="calendar-dialog task-dialog panel" role="dialog" aria-modal="true" aria-labelledby="shared-task-dialog-title">
      <header><div><h2 id="shared-task-dialog-title">{draft.id ? "编辑任务" : "新建任务"}</h2></div><button aria-label="关闭" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="task-form">
        <label><span>任务标题</span><input autoFocus value={draft.title} maxLength={240} onChange={(event) => update({ title: event.target.value })} placeholder="要完成什么？" /></label>
        <label className="task-project-field"><span>项目</span><AppSelect ariaLabel="任务所属项目" value={draft.projectId || (draft.projectName ? "__legacy__" : "")} onValueChange={(projectId) => {
          const project = projects.find((entry) => entry.id === projectId);
          update({
            projectId: project?.id ?? "",
            planItemId: "",
            projectName: project?.name ?? "",
            areaName: project?.areaName ?? (projectId ? draft.areaName : ""),
          });
        }} options={[{ value: "", label: "无项目" }, ...(draft.projectName && !draft.projectId ? [{ value: "__legacy__", label: `旧标签 · ${draft.projectName}`, disabled: true }] : []), ...projects.map((project) => ({ value: project.id, label: `${project.name}${project.areaName ? ` · ${project.areaName}` : ""}${project.status === "archived" ? " · 已归档" : ""}`, disabled: project.status === "archived" && project.id !== draft.projectId }))]} /></label>
        <label><span>状态</span><AppSelect ariaLabel="任务状态" value={draft.status} onValueChange={(status) => update({ status: status as EditorTaskStatus })} options={[{ value: "inbox", label: "Inbox · 待整理" }, { value: "next", label: "下一步" }, { value: "waiting", label: "等待中" }, { value: "someday", label: "以后也许" }, { value: "done", label: "已完成" }]} /></label>
        <label><span>紧急程度</span><AppSelect ariaLabel="紧急程度" value={draft.urgencyMode} onValueChange={(urgencyMode) => update({ urgencyMode: urgencyMode as EditorUrgencyMode })} options={[{ value: "auto", label: "自动（按开始时间）" }, { value: "urgent", label: "紧急" }, { value: "not_urgent", label: "不紧急" }]} /></label>
        <DateTimeField label="开始时间" value={draft.dueAt} onChange={(dueAt) => update({ dueAt })} />
        <label><span>预计时长（分钟，用于日历）</span><input type="number" min="5" max="1440" step="5" value={draft.estimatedMinutes} onChange={(event) => update({ estimatedMinutes: event.target.value })} placeholder="例如 45" /></label>
        {draft.projectId && <label className="task-project-field"><span>关联计划项（可选）</span><AppSelect ariaLabel="任务关联计划项" value={draft.planItemId} onValueChange={(planItemId) => update({ planItemId })} options={[{ value: "", label: "不关联 · 仅作为行动任务" }, ...planItems.map((item) => ({ value: item.id, label: `${item.title}${item.status === "done" ? " · 已完成" : item.status === "cancelled" ? " · 已取消" : ""}` }))]} /></label>}
        <label className="task-important-field"><input type="checkbox" checked={draft.important} onChange={(event) => update({ important: event.target.checked })} /><Star size={15} fill={draft.important ? "currentColor" : "none"} /><span>这是重要任务</span></label>
        <section className="task-notes-field task-notes-editor" aria-labelledby="task-notes-label">
          <span id="task-notes-label">备注</span>
          <div className="task-notes-editor-surface">
            <div className="task-notes-toolbar" role="toolbar" aria-label="备注列表格式">
              <button type="button" aria-label="有序列表" title="有序列表" onClick={() => applyList("ordered")}><ListOrdered size={16} /></button>
              <button type="button" aria-label="无序列表" title="无序列表" onClick={() => applyList("unordered")}><List size={16} /></button>
              <button type="button" aria-label="任务列表" title="任务列表" onClick={() => applyList("task")}><ListTodo size={16} /></button>
            </div>
            <textarea ref={notesRef} aria-labelledby="task-notes-label" value={draft.notes} maxLength={10_000} onChange={(event) => update({ notes: event.target.value })} placeholder="补充完成标准、等待事项或下一步…" />
          </div>
        </section>
        {draft.id && <RelatedContentPanel kind="task" entityId={draft.id} flat hideWhenEmpty excludeRelations={["project-item"]} />}
      </div>
      <footer><div><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !draft.title.trim()} onClick={onSave}>{busy && <LoaderCircle className="spin" size={15} />}{draft.id ? "保存修改" : "创建任务"}</button></div></footer>
    </section>
  </div>;
}
