"use client";

import Link from "next/link";
import { CalendarClock, ChevronDown, LoaderCircle, Pencil, Plus, Star, Trash2, X } from "lucide-react";

import { AppSelect } from "../app-select";
import { DateTimeField } from "../ui/date-time-field";
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
  readonly projectStatus: "planned" | "in_progress" | "paused" | "done" | "cancelled";
}

interface EditorCollaborator {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
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
  collaborators,
  editingTask,
  busy,
  scheduleBusy = false,
  scheduleHref,
  onDraftChange,
  onClose,
  onSave,
  onSchedule,
  onDeleteTimeBlock,
}: {
  readonly draft: SharedTaskEditorDraft;
  readonly projects: readonly EditorProject[];
  readonly planItems: readonly EditorPlanItem[];
  readonly collaborators: readonly EditorCollaborator[];
  readonly editingTask?: EditorTaskDetails;
  readonly busy: boolean;
  readonly scheduleBusy?: boolean;
  readonly scheduleHref?: string;
  readonly onDraftChange: (draft: SharedTaskEditorDraft) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly onSchedule?: (block?: SharedTaskEditorTimeBlock) => void;
  readonly onDeleteTimeBlock?: (block: SharedTaskEditorTimeBlock) => void;
}) {
  const update = (changes: Partial<SharedTaskEditorDraft>) => onDraftChange({ ...draft, ...changes });
  const hasTimeBlockActions = Boolean(onSchedule || onDeleteTimeBlock);

  return <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="calendar-dialog task-dialog panel" role="dialog" aria-modal="true" aria-labelledby="shared-task-dialog-title">
      <header><div><h2 id="shared-task-dialog-title">{draft.id ? "编辑任务" : "新建任务"}</h2></div><button aria-label="关闭" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="task-form">
        <label className="task-title-field"><span>任务标题</span><input autoFocus value={draft.title} maxLength={240} onChange={(event) => update({ title: event.target.value })} placeholder="要完成什么？" /></label>
        <label><span>状态</span><AppSelect ariaLabel="任务状态" value={draft.status} onValueChange={(status) => update({ status: status as EditorTaskStatus })} options={[{ value: "inbox", label: "Inbox · 待整理" }, { value: "next", label: "下一步" }, { value: "waiting", label: "等待中" }, { value: "someday", label: "以后也许" }, { value: "done", label: "已完成" }]} /></label>
        <label><span>紧急程度</span><AppSelect ariaLabel="紧急程度" value={draft.urgencyMode} onValueChange={(urgencyMode) => update({ urgencyMode: urgencyMode as EditorUrgencyMode })} options={[{ value: "auto", label: "自动（按截止时间）" }, { value: "urgent", label: "紧急" }, { value: "not_urgent", label: "不紧急" }]} /></label>
        <DateTimeField label="截止时间" value={draft.dueAt} onChange={(dueAt) => update({ dueAt })} />
        <label><span>预计时长（分钟）</span><input type="number" min="5" max="1440" step="5" value={draft.estimatedMinutes} onChange={(event) => update({ estimatedMinutes: event.target.value })} placeholder="例如 45" /></label>
        <label className="task-project-field"><span>项目</span><AppSelect ariaLabel="任务所属项目" value={draft.projectId || (draft.projectName ? "__legacy__" : "")} onValueChange={(projectId) => {
          const project = projects.find((entry) => entry.id === projectId);
          update({
            projectId: project?.id ?? "",
            planItemId: "",
            projectName: project?.name ?? "",
            areaName: project?.areaName ?? (projectId ? draft.areaName : ""),
          });
        }} options={[{ value: "", label: "无项目" }, ...(draft.projectName && !draft.projectId ? [{ value: "__legacy__", label: `旧标签 · ${draft.projectName}`, disabled: true }] : []), ...projects.map((project) => ({ value: project.id, label: `${project.name}${project.areaName ? ` · ${project.areaName}` : ""}${project.status === "archived" ? " · 已归档" : ""}`, disabled: project.status === "archived" && project.id !== draft.projectId }))]} /></label>
        {draft.projectId && <label className="task-project-field"><span>关联计划项（可选）</span><AppSelect ariaLabel="任务关联计划项" value={draft.planItemId} onValueChange={(planItemId) => update({ planItemId })} options={[{ value: "", label: "不关联 · 仅作为行动任务" }, ...planItems.map((item) => ({ value: item.id, label: `${item.title}${item.projectStatus === "done" ? " · 已完成" : item.projectStatus === "cancelled" ? " · 已取消" : ""}` }))]} /></label>}
        <label className="task-important-field"><input type="checkbox" checked={draft.important} onChange={(event) => update({ important: event.target.checked })} /><Star size={15} fill={draft.important ? "currentColor" : "none"} /><span>这是重要任务</span></label>
        <details className="task-advanced-options">
          <summary><span>更多选项{draft.areaName || draft.assigneeUserId || draft.notes ? " · 已填写" : ""}</span><ChevronDown size={16} /></summary>
          <div>
            <label><span>领域{draft.projectId ? " · 由项目继承" : ""}</span><input value={draft.areaName} maxLength={100} disabled={Boolean(draft.projectId)} onChange={(event) => update({ areaName: event.target.value })} placeholder="例如 工作 / 个人" /></label>
            <label><span>指派给</span><AppSelect ariaLabel="任务负责人" value={draft.assigneeUserId} onValueChange={(assigneeUserId) => update({ assigneeUserId })} options={[{ value: "", label: "未指派" }, ...collaborators.map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))]} /></label>
            <label className="task-notes-field"><span>备注</span><textarea value={draft.notes} maxLength={10_000} onChange={(event) => update({ notes: event.target.value })} placeholder="补充完成标准、等待事项或下一步…" /></label>
          </div>
        </details>
        {editingTask && <section className={`task-time-blocks${hasTimeBlockActions ? "" : " project-task-time-blocks"}`}><header><div><CalendarClock size={15} /><span>专注时间</span><em>{editingTask.scheduledBlocks.length}</em></div>{onSchedule ? <button type="button" className="secondary-button" onClick={() => onSchedule()}><Plus size={14} />添加时间</button> : scheduleHref ? <Link className="secondary-button" href={scheduleHref}><Plus size={14} />添加时间</Link> : null}</header>{editingTask.scheduledBlocks.length ? <div>{editingTask.scheduledBlocks.map((block) => <article key={block.eventId}><Link href={block.href}><CalendarClock size={14} /><span><strong>{formatTaskBlockRange(block.start, block.end)}</strong><small>{block.calendarName}</small></span></Link>{onSchedule && <button type="button" aria-label={`调整时间：${formatTaskBlockRange(block.start, block.end)}`} title="调整时间" onClick={() => onSchedule(block)}><Pencil size={14} /></button>}{onDeleteTimeBlock && <button type="button" className="danger-button" aria-label={`删除时间块：${formatTaskBlockRange(block.start, block.end)}`} title="删除时间块" disabled={scheduleBusy} onClick={() => onDeleteTimeBlock(block)}><Trash2 size={14} /></button>}</article>)}</div> : <p>尚未安排专注时间。可以添加多个时间块，也可以稍后拖入日历。</p>}</section>}
        {draft.id && <RelatedContentPanel kind="task" entityId={draft.id} emptyText="这个任务还没有关联来源或时间块。" />}
      </div>
      <footer><div><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !draft.title.trim()} onClick={onSave}>{busy && <LoaderCircle className="spin" size={15} />}{draft.id ? "保存修改" : "创建任务"}</button></div></footer>
    </section>
  </div>;
}

function formatTaskBlockRange(startValue: string, endValue: string): string {
  const start = new Date(startValue);
  const end = new Date(endValue);
  const sameDay = start.toDateString() === end.toDateString();
  const day = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time.format(start)}–${sameDay ? time.format(end) : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
}
