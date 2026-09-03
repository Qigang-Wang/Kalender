import { noteContentToMarkdown, normalizeMcpNoteContent } from "../lib/note-content";
import type { CalendarEvent, CalendarSummary, UpsertCalendarEventInput } from "../../../../src/mail/types";
import { runWithMcpActor, type AppUser } from "./auth";
import { deleteCalendarEvent, upsertCalendarEvent, validateCalendarEventDelete, validateCalendarEventUpsert } from "./calendar-event-service";
import { getStoredCalendarEvent, listStoredCalendarEventConflicts, listStoredCalendarEvents, listStoredCalendars } from "./calendar-repository";
import { deleteEntityLink, listRelatedEntities, saveEntityLink, validateEntityLink, validateEntityLinkDelete, type EntityKind, type SaveEntityLinkInput } from "./entity-link-repository";
import { listMcpCalendarFreeSlots } from "./mcp-calendar-availability";
import { listMcpProjectNextActions } from "./mcp-project-actions";
import { assertExpectedUpdatedAt, executeMcpWrite, type McpWriteOptions } from "./mcp-write-safety";
import { deleteStoredNote, getStoredNote, listStoredNotes, listStoredProjectNotes, listStoredProjects, saveStoredNote, validateStoredNoteInput, type SaveNoteInput, type StoredNote, type StoredProject } from "./note-repository";
import { deleteStoredProjectPlanItem, listStoredProjectPlanItems, saveStoredProjectPlanItem, validateStoredProjectPlanItemDelete, validateStoredProjectPlanItemInput, type SaveProjectPlanItemInput, type StoredProjectPlanItem } from "./project-plan-repository";
import { getStoredProjectOverview } from "./project-repository";
import { deleteStoredTaskSchedule, parseTaskScheduleInput, scheduleStoredTask, updateStoredTaskSchedule, validateStoredTaskSchedule, validateStoredTaskScheduleDelete, type ScheduledTaskResult } from "./task-schedule";
import { getStoredTask, listStoredProjectTasks, listStoredTasks, saveStoredTask, TaskRepositoryError, validateStoredTaskInput, type StoredTask } from "./task-repository";
import { parseTaskInput, type TaskRequestBody } from "./task-validation";
import { getTodaySnapshot, type TodaySnapshot } from "./today-repository";
import { searchWorkspace, type WorkspaceSearchKind, type WorkspaceSearchResult } from "./workspace-search";

export const mcpDomainOperationNames = [
  "dayline_search", "dayline_today_get", "dayline_tasks_list", "dayline_task_get", "dayline_task_create", "dayline_task_update", "dayline_projects_list", "dayline_project_get", "dayline_task_schedule", "dayline_notes_search",
  "dayline_project_plan_items_list", "dayline_project_plan_item_get", "dayline_project_plan_item_create", "dayline_project_plan_item_update", "dayline_project_plan_item_delete", "dayline_task_plan_item_link", "dayline_task_plan_item_unlink", "dayline_note_get", "dayline_note_create", "dayline_note_update", "dayline_note_append", "dayline_note_delete", "dayline_calendars_list", "dayline_calendar_events_list", "dayline_calendar_free_slots", "dayline_task_reschedule", "dayline_task_schedule_cancel", "dayline_project_next_actions", "dayline_relations_list", "dayline_relation_link", "dayline_relation_unlink", "dayline_calendar_event_create", "dayline_calendar_event_update", "dayline_calendar_event_delete",
] as const;
export type McpDomainOperationName = (typeof mcpDomainOperationNames)[number];
type WriteInput = McpWriteOptions & Record<string, unknown>;
export interface McpPreview { readonly preview: true; readonly currentRevision?: string; readonly before: unknown; readonly after: unknown; readonly warnings: readonly string[]; readonly conflicts: readonly unknown[]; }
export interface McpNote { readonly id: string; readonly projectId?: string; readonly title: string; readonly content: string; readonly noteType: string; readonly pinned: boolean; readonly createdAt: string; readonly updatedAt: string; }
export interface McpNoteInput { readonly projectId?: string; readonly title: string; readonly content: string; readonly noteType?: SaveNoteInput["noteType"]; readonly pinned?: boolean; }
export interface McpCalendarEventInput { readonly calendarId: string; readonly title: string; readonly description?: string; readonly location?: string; readonly start: string; readonly end: string; readonly timeZone?: string; readonly allDay?: boolean; readonly reminderMinutesBefore?: CalendarEvent["reminderMinutesBefore"]; readonly attendees?: readonly { readonly address: string; readonly name?: string }[]; readonly availability?: CalendarEvent["availability"]; readonly recurrence?: CalendarEvent["recurrence"]; readonly recurrenceSeriesId?: string; readonly recurrenceId?: string; readonly recurrenceScope?: "occurrence" | "following" | "series"; readonly allowConflicts?: boolean; }

export interface McpDomainOperationMap {
  readonly dayline_search: { input: { query: string; kind?: WorkspaceSearchKind; limit?: number }; output: readonly WorkspaceSearchResult[] };
  readonly dayline_today_get: { input: { from: string; to: string }; output: TodaySnapshot };
  readonly dayline_tasks_list: { input: { includeCompleted?: boolean; projectId?: string; limit?: number }; output: readonly StoredTask[] };
  readonly dayline_task_get: { input: { taskId: string }; output: StoredTask | undefined };
  readonly dayline_task_create: { input: TaskRequestBody & WriteInput; output: StoredTask };
  readonly dayline_task_update: { input: TaskRequestBody & { taskId: string } & WriteInput; output: StoredTask };
  readonly dayline_projects_list: { input: { includeArchived?: boolean; limit?: number }; output: readonly StoredProject[] };
  readonly dayline_project_get: { input: { projectId: string }; output: Awaited<ReturnType<typeof getStoredProjectOverview>> };
  readonly dayline_task_schedule: { input: { taskId: string; calendarId: string; start: string; end: string; timeZone?: string; allowConflicts?: boolean } & WriteInput; output: ScheduledTaskResult };
  readonly dayline_notes_search: { input: { query: string; projectId?: string; limit?: number }; output: readonly McpNote[] };
  readonly dayline_project_plan_items_list: { input: { projectId: string; limit?: number }; output: readonly StoredProjectPlanItem[] };
  readonly dayline_project_plan_item_get: { input: { projectId: string; planItemId: string }; output: StoredProjectPlanItem | undefined };
  readonly dayline_project_plan_item_create: { input: SaveProjectPlanItemInput & WriteInput; output: StoredProjectPlanItem };
  readonly dayline_project_plan_item_update: { input: Partial<SaveProjectPlanItemInput> & { projectId: string; planItemId: string } & WriteInput; output: StoredProjectPlanItem };
  readonly dayline_project_plan_item_delete: { input: { projectId: string; planItemId: string } & WriteInput; output: { deleted: true } };
  readonly dayline_task_plan_item_link: { input: { taskId: string; projectId: string; planItemId: string } & WriteInput; output: StoredTask };
  readonly dayline_task_plan_item_unlink: { input: { taskId: string } & WriteInput; output: StoredTask };
  readonly dayline_note_get: { input: { noteId: string }; output: McpNote | undefined };
  readonly dayline_note_create: { input: McpNoteInput & WriteInput; output: McpNote };
  readonly dayline_note_update: { input: Partial<McpNoteInput> & { noteId: string } & WriteInput; output: McpNote };
  readonly dayline_note_append: { input: { noteId: string; content: string } & WriteInput; output: McpNote };
  readonly dayline_note_delete: { input: { noteId: string } & WriteInput; output: { deleted: true } };
  readonly dayline_calendars_list: { input: Record<string, never>; output: readonly CalendarSummary[] };
  readonly dayline_calendar_events_list: { input: { from: string; to: string; calendarIds?: readonly string[]; limit?: number }; output: readonly CalendarEvent[] };
  readonly dayline_calendar_free_slots: { input: { from: string; to: string; calendarIds?: readonly string[]; minimumDurationMinutes?: number; timeZone?: string }; output: unknown };
  readonly dayline_task_reschedule: { input: { taskId: string; eventId: string; calendarId: string; start: string; end: string; timeZone?: string; allowConflicts?: boolean } & WriteInput; output: ScheduledTaskResult };
  readonly dayline_task_schedule_cancel: { input: { taskId: string; eventId: string } & WriteInput; output: StoredTask };
  readonly dayline_project_next_actions: { input: { projectId: string }; output: unknown };
  readonly dayline_relations_list: { input: { kind: EntityKind; entityId: string; limit?: number }; output: unknown };
  readonly dayline_relation_link: { input: { sourceKind: EntityKind; sourceId: string; targetKind: EntityKind; targetId: string; relation?: string } & WriteInput; output: unknown };
  readonly dayline_relation_unlink: { input: { linkId: string } & WriteInput; output: { deleted: true } };
  readonly dayline_calendar_event_create: { input: McpCalendarEventInput & WriteInput; output: CalendarEvent };
  readonly dayline_calendar_event_update: { input: Partial<McpCalendarEventInput> & { eventId: string; calendarId: string } & WriteInput; output: CalendarEvent };
  readonly dayline_calendar_event_delete: { input: { eventId: string; calendarId: string } & WriteInput; output: { deleted: true } };
}
export type McpDomainInput<Name extends McpDomainOperationName> = McpDomainOperationMap[Name]["input"];
export type McpDomainOutput<Name extends McpDomainOperationName> = McpDomainOperationMap[Name]["output"];
export class McpDomainInputError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly conflicts?: readonly { readonly id: string; readonly title: string; readonly start: string; readonly end: string }[];
  constructor(message: string, options: { readonly status?: number; readonly code?: string; readonly details?: Readonly<Record<string, unknown>>; readonly conflicts?: readonly { readonly id: string; readonly title: string; readonly start: string; readonly end: string }[] } = {}) {
    super(message);
    this.name = "McpDomainInputError";
    this.status = options.status ?? 400;
    this.code = options.code;
    this.details = options.details;
    this.conflicts = options.conflicts;
  }
}

export class McpDomainService {
  constructor(private readonly actor: AppUser) {}
  async execute<Name extends McpDomainOperationName>(name: Name, input: McpDomainInput<Name>): Promise<McpDomainOutput<Name>> { return runWithMcpActor(this.actor, async () => this.executeScoped(name, input as Record<string, unknown>)) as Promise<McpDomainOutput<Name>>; }
  async daylineSearch(input: McpDomainInput<"dayline_search">) { return this.execute("dayline_search", input); }
  async daylineTodayGet(input: McpDomainInput<"dayline_today_get">) { return this.execute("dayline_today_get", input); }
  async daylineTasksList(input: McpDomainInput<"dayline_tasks_list"> = {}) { return this.execute("dayline_tasks_list", input); }
  async daylineTaskGet(input: McpDomainInput<"dayline_task_get">) { return this.execute("dayline_task_get", input); }
  async daylineTaskCreate(input: McpDomainInput<"dayline_task_create">) { return this.execute("dayline_task_create", input); }
  async daylineTaskUpdate(input: McpDomainInput<"dayline_task_update">) { return this.execute("dayline_task_update", input); }
  async daylineProjectsList(input: McpDomainInput<"dayline_projects_list"> = {}) { return this.execute("dayline_projects_list", input); }
  async daylineProjectGet(input: McpDomainInput<"dayline_project_get">) { return this.execute("dayline_project_get", input); }
  async daylineTaskSchedule(input: McpDomainInput<"dayline_task_schedule">) { return this.execute("dayline_task_schedule", input); }
  async daylineNotesSearch(input: McpDomainInput<"dayline_notes_search">) { return this.execute("dayline_notes_search", input); }

  private async executeScoped(name: McpDomainOperationName, raw: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "dayline_search": return searchWorkspace(requiredText(raw.query, "搜索关键词"), { kind: raw.kind as WorkspaceSearchKind | undefined, limit: boundedLimit(raw.limit) });
      case "dayline_today_get": { const from = validDate(raw.from, "开始时间"); const to = validDate(raw.to, "结束时间"); if (to <= from || to.getTime() - from.getTime() > 172800000) throw new McpDomainInputError("Today 时间范围无效"); return getTodaySnapshot(from.toISOString(), to.toISOString()); }
      case "dayline_tasks_list": return (await (raw.projectId ? listStoredProjectTasks(requiredText(raw.projectId, "项目标识"), raw.includeCompleted === true) : listStoredTasks(raw.includeCompleted === true))).slice(0, boundedLimit(raw.limit));
      case "dayline_task_get": return getStoredTask(requiredText(raw.taskId, "任务标识"));
      case "dayline_projects_list": return (await listStoredProjects(raw.includeArchived === true)).slice(0, boundedLimit(raw.limit));
      case "dayline_project_get": return getStoredProjectOverview(requiredText(raw.projectId, "项目标识"));
      case "dayline_notes_search": { const notes = raw.projectId ? await listStoredProjectNotes(requiredText(raw.projectId, "项目标识")) : await listStoredNotes(); const query = requiredText(raw.query, "搜索关键词").toLocaleLowerCase(); return notes.filter((note) => `${note.title}\n${noteContentToMarkdown(note.content)}`.toLocaleLowerCase().includes(query)).slice(0, boundedLimit(raw.limit)).map(mapNote); }
      case "dayline_project_plan_items_list": return (await listStoredProjectPlanItems(requiredText(raw.projectId, "项目标识"))).slice(0, boundedLimit(raw.limit));
      case "dayline_project_plan_item_get": return (await listStoredProjectPlanItems(requiredText(raw.projectId, "项目标识"))).find((item) => item.id === requiredText(raw.planItemId, "计划项标识"));
      case "dayline_calendars_list": return listStoredCalendars();
      case "dayline_calendar_events_list": return listStoredCalendarEvents({ from: validDate(raw.from, "开始时间").toISOString(), to: validDate(raw.to, "结束时间").toISOString(), calendarIds: stringArray(raw.calendarIds, "calendarIds"), limit: raw.limit === undefined ? undefined : boundedCalendarLimit(raw.limit) });
      case "dayline_calendar_free_slots": return listMcpCalendarFreeSlots({ from: requiredText(raw.from, "开始时间"), to: requiredText(raw.to, "结束时间"), calendarIds: stringArray(raw.calendarIds, "calendarIds"), minimumDurationMinutes: numberValue(raw.durationMinutes ?? raw.minimumDurationMinutes), timeZone: optionalText(raw.timeZone) });
      case "dayline_project_next_actions": return listMcpProjectNextActions(requiredText(raw.projectId, "项目标识"));
      case "dayline_relations_list": return (await listRelatedEntities(entityKind(raw.kind), requiredText(raw.entityId, "对象标识"))).slice(0, boundedLimit(raw.limit));
      case "dayline_task_create": { const input = parseTaskInput(raw as TaskRequestBody); return this.write(name, raw, () => saveStoredTask(input), async () => { await validateStoredTaskInput(input); return preview(null, input); }); }
      case "dayline_task_update": return this.taskUpdate(name, raw);
      case "dayline_task_schedule": return this.taskSchedule(name, raw);
      case "dayline_task_reschedule": return this.taskReschedule(name, raw);
      case "dayline_task_schedule_cancel": return this.taskCancel(name, raw);
      case "dayline_project_plan_item_create": return this.planCreate(name, raw);
      case "dayline_project_plan_item_update": return this.planUpdate(name, raw);
      case "dayline_project_plan_item_delete": return this.planDelete(name, raw);
      case "dayline_task_plan_item_link": return this.planLink(name, raw, false);
      case "dayline_task_plan_item_unlink": return this.planLink(name, raw, true);
      case "dayline_note_get": { const note = await getStoredNote(requiredText(raw.noteId, "笔记标识")); return note && mapNote(note); }
      case "dayline_note_create": return this.noteCreate(name, raw);
      case "dayline_note_update": return this.noteUpdate(name, raw);
      case "dayline_note_append": return this.noteAppend(name, raw);
      case "dayline_note_delete": return this.noteDelete(name, raw);
      case "dayline_relation_link": { const input: SaveEntityLinkInput = { sourceKind: entityKind(raw.sourceKind), sourceId: requiredText(raw.sourceId, "来源标识"), targetKind: entityKind(raw.targetKind), targetId: requiredText(raw.targetId, "目标标识"), relation: optionalText(raw.relation) ?? "related" }; return this.write(name, raw, () => saveEntityLink(input), async () => { await validateEntityLink(input); return preview(null, input); }); }
      case "dayline_relation_unlink": return this.relationUnlink(name, raw);
      case "dayline_calendar_event_create": return this.calendarEventCreate(name, raw);
      case "dayline_calendar_event_update": return this.calendarEventUpdate(name, raw);
      case "dayline_calendar_event_delete": return this.calendarEventDelete(name, raw);
    }
  }
  private write<T>(operation: string, input: Record<string, unknown>, perform: () => Promise<T>, previewAction: () => McpPreview | Promise<McpPreview>): Promise<T | McpPreview> { return executeMcpWrite(this.actor, operation, input, { ...input, requireIdempotency: isCreateOperation(operation) }, perform, previewAction); }
  private async taskUpdate(operation: string, raw: Record<string, unknown>) { const current = await getStoredTask(requiredText(raw.taskId, "任务标识")); if (!current) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404); assertRevisionForExecute(current, raw); const next = parseTaskInput(mergeTaskUpdate(current, raw as TaskRequestBody), current.id); return this.write(operation, raw, () => saveStoredTask(next, { expectedUpdatedAt: requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt") }), async () => { await validateStoredTaskInput(next); return preview(current, next); }); }
  private async taskSchedule(operation: string, raw: Record<string, unknown>) { const task = await getStoredTask(requiredText(raw.taskId, "任务标识")); if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404); const input = parseTaskScheduleInput(raw); return this.write(operation, raw, () => scheduleStoredTask(task.id, input), async () => preview(task, input, (await validateStoredTaskSchedule(task.id, input)).conflicts)); }
  private async taskReschedule(operation: string, raw: Record<string, unknown>) { const task = await getStoredTask(requiredText(raw.taskId, "任务标识")); const event = await getStoredCalendarEvent(requiredText(raw.eventId, "日程标识")); if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404); if (!event) throw new TaskRepositoryError("TIME_BLOCK_NOT_FOUND", "任务时间块不存在", 404); assertRevisionForExecute(event as { updatedAt: string }, raw); const input = parseTaskScheduleInput(raw); return this.write(operation, raw, () => updateStoredTaskSchedule(task.id, event.id, input, requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt")), async () => preview(event, input, (await validateStoredTaskSchedule(task.id, input, event.id)).conflicts)); }
  private async taskCancel(operation: string, raw: Record<string, unknown>) { const taskId = requiredText(raw.taskId, "任务标识"); const event = await getStoredCalendarEvent(requiredText(raw.eventId, "日程标识")); if (!event) throw new TaskRepositoryError("TIME_BLOCK_NOT_FOUND", "任务时间块不存在", 404); assertRevisionForExecute(event as { updatedAt: string }, raw); return this.write(operation, raw, () => deleteStoredTaskSchedule(taskId, event.id, requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt")), async () => { await validateStoredTaskScheduleDelete(taskId, event.id); return preview(event, null); }); }
  private async planCreate(operation: string, raw: Record<string, unknown>) { const input = planInput(raw); return this.write(operation, raw, () => saveStoredProjectPlanItem(input), async () => { await validateStoredProjectPlanItemInput(input); return preview(null, input); }); }
  private async planUpdate(operation: string, raw: Record<string, unknown>) { const projectId = requiredText(raw.projectId, "项目标识"); const current = (await listStoredProjectPlanItems(projectId)).find((item) => item.id === requiredText(raw.planItemId, "计划项标识")); if (!current) throw new McpDomainInputError("计划项不存在"); assertRevisionForExecute(current, raw); const input = planInput({ ...current, ...raw, id: current.id, projectId, dependencyIds: raw.dependencyIds ?? current.dependencyIds }); return this.write(operation, raw, () => saveStoredProjectPlanItem(input, { expectedUpdatedAt: requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt") }), async () => { await validateStoredProjectPlanItemInput(input); return preview(current, input); }); }
  private async planDelete(operation: string, raw: Record<string, unknown>) { const projectId = requiredText(raw.projectId, "项目标识"); const current = (await listStoredProjectPlanItems(projectId)).find((item) => item.id === requiredText(raw.planItemId, "计划项标识")); if (!current) throw new McpDomainInputError("计划项不存在"); assertRevisionForExecute(current, raw); return this.write(operation, raw, async () => { if (!await deleteStoredProjectPlanItem(projectId, current.id, requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt"))) throw new McpDomainInputError("计划项不存在"); return { deleted: true as const }; }, async () => { await validateStoredProjectPlanItemDelete(projectId, current.id); return preview(current, null); }); }
  private async planLink(operation: string, raw: Record<string, unknown>, unlink: boolean) { const task = await getStoredTask(requiredText(raw.taskId, "任务标识")); if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "任务不存在", 404); assertRevisionForExecute(task, raw); if (!task.projectId) throw new McpDomainInputError("任务必须属于项目"); const projectId = requiredText(raw.projectId ?? task.projectId, "项目标识"); if (task.projectId !== projectId) throw new McpDomainInputError("任务不能迁移到其他项目"); const planItemId = unlink ? null : requiredText(raw.planItemId, "计划项标识"); if (!unlink) { const plan = (await listStoredProjectPlanItems(projectId)).find((item) => item.id === planItemId); if (!plan || plan.projectId !== projectId) throw new McpDomainInputError("计划项不属于任务项目"); } const next = parseTaskInput(mergeTaskUpdate(task, { projectId: task.projectId, planItemId }), task.id); return this.write(operation, raw, () => saveStoredTask(next, { expectedUpdatedAt: requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt") }), async () => { await validateStoredTaskInput(next); return preview(task, next); }); }
  private async noteCreate(operation: string, raw: Record<string, unknown>) { const input = noteInput(raw); return this.write(operation, raw, async () => mapNote(await saveStoredNote(input)), async () => { await validateStoredNoteInput(input); return preview(null, input); }); }
  private async noteUpdate(operation: string, raw: Record<string, unknown>) { const current = await getStoredNote(requiredText(raw.noteId, "笔记标识")); if (!current) throw new McpDomainInputError("笔记不存在"); assertRevisionForExecute(current, raw); const input = { ...noteInput({ ...current, ...raw, content: raw.content === undefined ? noteContentToMarkdown(current.content) : raw.content }), id: current.id }; return this.write(operation, raw, async () => mapNote(await saveStoredNote(input, { expectedUpdatedAt: requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt") })), async () => { await validateStoredNoteInput(input); return preview(mapNote(current), input); }); }
  private async noteAppend(operation: string, raw: Record<string, unknown>) { const current = await getStoredNote(requiredText(raw.noteId, "笔记标识")); if (!current) throw new McpDomainInputError("笔记不存在"); assertRevisionForExecute(current, raw); const input = { ...noteInput({ ...current, content: [noteContentToMarkdown(current.content), normalizeMcpNoteContent(raw.content)].filter(Boolean).join("\n\n") }), id: current.id }; return this.write(operation, raw, async () => mapNote(await saveStoredNote(input, { expectedUpdatedAt: requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt") })), async () => { await validateStoredNoteInput(input); return preview(mapNote(current), input); }); }
  private async noteDelete(operation: string, raw: Record<string, unknown>) { const current = await getStoredNote(requiredText(raw.noteId, "笔记标识")); if (!current) throw new McpDomainInputError("笔记不存在"); assertRevisionForExecute(current, raw); return this.write(operation, raw, async () => { if (!await deleteStoredNote(current.id, requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt"))) throw new McpDomainInputError("笔记不存在"); return { deleted: true as const }; }, () => preview(mapNote(current), null)); }
  private async relationUnlink(operation: string, raw: Record<string, unknown>) { const id = requiredText(raw.linkId, "关联标识"); return this.write(operation, raw, async () => { await validateEntityLinkDelete(id); if (!await deleteEntityLink(id)) throw new McpDomainInputError("关联不存在"); return { deleted: true as const }; }, async () => { await validateEntityLinkDelete(id); return preview({ linkId: id }, null); }); }
  private async calendarEventCreate(operation: string, raw: Record<string, unknown>) { return this.eventWrite(operation, raw, calendarInput(raw), null); }
  private async calendarEventUpdate(operation: string, raw: Record<string, unknown>) { const current = await getStoredCalendarEvent(requiredText(raw.eventId, "日程标识")); if (!current) throw new McpDomainInputError("日程不存在"); if (current.calendarId !== requiredText(raw.calendarId, "日历标识")) throw new McpDomainInputError("日程不属于该日历"); assertRevisionForExecute(current as { updatedAt: string }, raw); return this.eventWrite(operation, raw, calendarInput({ ...current, ...raw, id: current.id }), current); }
  private async calendarEventDelete(operation: string, raw: Record<string, unknown>) { const current = await getStoredCalendarEvent(requiredText(raw.eventId, "日程标识")); if (!current) throw new McpDomainInputError("日程不存在"); if (current.calendarId !== requiredText(raw.calendarId, "日历标识")) throw new McpDomainInputError("日程不属于该日历"); assertRevisionForExecute(current as { updatedAt: string }, raw); return this.write(operation, raw, async () => { await validateCalendarEventDelete(current.calendarId, current.id); await deleteCalendarEvent(current.calendarId, current.id, undefined, requiredText(raw.expectedUpdatedAt, "expectedUpdatedAt")); return { deleted: true as const }; }, async () => { await validateCalendarEventDelete(current.calendarId, current.id); return preview(current, null); }); }
  private async eventWrite(operation: string, raw: Record<string, unknown>, input: UpsertCalendarEventInput, before: CalendarEvent | null) { const conflicts = () => listStoredCalendarEventConflicts({ calendarId: input.calendarId, start: input.start, end: input.end, excludeEventId: input.id }); return this.write(operation, raw, async () => { await validateCalendarEventUpsert(input); const found = await conflicts(); if (found.length && raw.allowConflicts !== true) throw scheduleConflict(found); return upsertCalendarEvent(input); }, async () => { await validateCalendarEventUpsert(input); return preview(before, input, await conflicts()); }); }
}
function preview(before: unknown, after: unknown, conflicts: readonly unknown[] = []): McpPreview { const revision = before && typeof before === "object" && "updatedAt" in before ? (before as { updatedAt?: string }).updatedAt : undefined; return { preview: true, currentRevision: revision, before, after, warnings: conflicts.length ? ["schedule_conflict"] : [], conflicts: conflicts.slice(0, 50) }; }
function mapNote(note: StoredNote): McpNote { return { id: note.id, projectId: note.projectId, title: note.title, content: noteContentToMarkdown(note.content), noteType: note.noteType, pinned: note.pinned, createdAt: note.createdAt, updatedAt: note.updatedAt }; }
function noteInput(raw: Record<string, unknown>): SaveNoteInput { return { projectId: optionalText(raw.projectId), title: requiredText(raw.title, "笔记标题"), content: normalizeMcpNoteContent(raw.content), noteType: noteType(raw.noteType), pinned: raw.pinned === true }; }
function noteType(value: unknown): SaveNoteInput["noteType"] { if (value === undefined) return "general"; if (["general", "meeting", "email", "project", "daily"].includes(String(value))) return value as SaveNoteInput["noteType"]; throw new McpDomainInputError("笔记类型无效"); }
function planInput(raw: Record<string, unknown>): SaveProjectPlanItemInput { return { id: optionalText(raw.id), projectId: requiredText(raw.projectId, "项目标识"), title: optionalText(raw.title), status: raw.status as SaveProjectPlanItemInput["status"], plannedStart: optionalText(raw.plannedStart), plannedEnd: optionalText(raw.plannedEnd), dependencyIds: stringArray(raw.dependencyIds, "dependencyIds") ?? [], phaseId: raw.phaseId === null ? null : optionalText(raw.phaseId), durationWorkdays: numberValue(raw.durationWorkdays), autoSchedule: raw.autoSchedule === undefined ? undefined : raw.autoSchedule === true }; }
function calendarInput(raw: Record<string, unknown>): UpsertCalendarEventInput { const start = validDate(raw.start, "开始时间"); const end = validDate(raw.end, "结束时间"); if (end <= start) throw new McpDomainInputError("结束时间必须晚于开始时间"); return { id: optionalText(raw.id), calendarId: requiredText(raw.calendarId, "日历标识"), title: requiredText(raw.title, "日程标题"), description: optionalText(raw.description), location: optionalText(raw.location), start: start.toISOString(), end: end.toISOString(), timeZone: optionalText(raw.timeZone), allDay: raw.allDay === true, reminderMinutesBefore: raw.reminderMinutesBefore as UpsertCalendarEventInput["reminderMinutesBefore"], attendees: Array.isArray(raw.attendees) ? raw.attendees as UpsertCalendarEventInput["attendees"] : undefined, availability: raw.availability as UpsertCalendarEventInput["availability"], recurrence: raw.recurrence as UpsertCalendarEventInput["recurrence"], recurrenceSeriesId: optionalText(raw.recurrenceSeriesId), recurrenceId: optionalText(raw.recurrenceId), recurrenceScope: raw.recurrenceScope as UpsertCalendarEventInput["recurrenceScope"], expectedUpdatedAt: optionalText(raw.expectedUpdatedAt) }; }
function mergeTaskUpdate(current: StoredTask, update: Partial<TaskRequestBody>): TaskRequestBody { const provided = <K extends keyof TaskRequestBody>(key: K, fallback: TaskRequestBody[K]) => Object.prototype.hasOwnProperty.call(update, key) ? update[key] : fallback; return { title: provided("title", current.title), notes: provided("notes", current.notes), status: provided("status", current.status), important: provided("important", current.important), urgencyMode: provided("urgencyMode", current.urgencyMode), dueAt: provided("dueAt", current.dueAt), estimatedMinutes: provided("estimatedMinutes", current.estimatedMinutes), projectId: provided("projectId", current.projectId), planItemId: provided("planItemId", current.planItemId), projectName: provided("projectName", current.projectName), areaName: provided("areaName", current.areaName), assigneeUserId: provided("assigneeUserId", current.assigneeUserId), sourceReferences: provided("sourceReferences", current.sourceReferences) }; }
function requiredText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new McpDomainInputError(`${label}不能为空`); return value.trim(); }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function validDate(value: unknown, label: string): Date { const date = new Date(requiredText(value, label)); if (Number.isNaN(date.getTime())) throw new McpDomainInputError(`${label}无效`); return date; }
function boundedLimit(value: unknown): number { if (value === undefined) return 20; if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) throw new McpDomainInputError("数量必须在 1–100 之间"); return Number(value); }
function boundedCalendarLimit(value: unknown): number { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1000) throw new McpDomainInputError("数量必须在 1–1000 之间"); return Number(value); }
function numberValue(value: unknown): number | undefined { if (value === undefined) return undefined; if (!Number.isInteger(value) || Number(value) < 1) throw new McpDomainInputError("数值无效"); return Number(value); }
function stringArray(value: unknown, label: string): readonly string[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new McpDomainInputError(`${label}必须为字符串数组`); return [...new Set(value.map((item) => item.trim()))]; }
function entityKind(value: unknown): EntityKind { if (["mail", "calendar", "task", "note", "project"].includes(String(value))) return value as EntityKind; throw new McpDomainInputError("对象类型无效"); }
function assertRevisionForExecute(current: { readonly updatedAt: string }, raw: Record<string, unknown>): void { if (raw.preview !== true) assertExpectedUpdatedAt(current, raw.expectedUpdatedAt); }
function scheduleConflict(conflicts: readonly { readonly id: string; readonly title: string; readonly start: string; readonly end: string }[]): McpDomainInputError {
  const safe = conflicts.slice(0, 20).map(({ id, title, start, end }) => ({ id, title, start, end }));
  return new McpDomainInputError("日程与现有安排冲突", { status: 409, code: "schedule_conflict", details: { conflicts: safe }, conflicts: safe });
}
function isCreateOperation(operation: string): boolean { return ["dayline_task_create", "dayline_task_schedule", "dayline_project_plan_item_create", "dayline_note_create", "dayline_relation_link", "dayline_calendar_event_create"].includes(operation); }
