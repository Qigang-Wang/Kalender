import { resolveContextCommands } from "./context-commands";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const ready = resolveContextCommands({
  kind: "mail-message",
  id: "message-1",
  subject: "Test",
  connected: true,
  busy: false,
  isRead: true,
  isStarred: true,
  canArchive: true,
});

assert(ready.map((command) => command.id).join(",") === [
  "mail.toggle-read",
  "mail.toggle-star",
  "mail.create-task",
  "mail.assign-project",
  "mail.ai-summary",
  "mail.archive",
  "mail.delete",
].join(","), "mail command order is stable");
assert(ready[0]?.label === "标记为未读", "read label reflects current state");
assert(ready[1]?.label === "取消星标" && ready[1].icon === "star-filled", "star label and icon reflect current state");
assert(!ready[5]?.disabledReason, "archive is enabled when a destination exists");
assert(ready[6]?.id === "mail.delete" && !ready[6]?.disabledReason, "delete is enabled for a connected mailbox");
assert(!ready[2]?.disabledReason && ready[2]?.label === "创建关联任务", "mail can create a local linked task");
assert(!ready[3]?.disabledReason && ready[3]?.label === "关联到项目", "mail can be organized into a project");
assert(ready[4]?.disabledReason === "需配置 GPT", "AI command explains its dependency");

const disconnected = resolveContextCommands({
  kind: "mail-message",
  id: "demo-message",
  subject: "Demo",
  connected: false,
  busy: false,
  isRead: false,
  isStarred: false,
  canArchive: false,
});

assert(disconnected[0]?.label === "标记为已读", "unread label reflects current state");
assert(disconnected[0]?.disabledReason === "连接真实邮箱后可用", "remote actions explain connection requirement");
assert(disconnected[5]?.disabledReason === "连接真实邮箱后可用", "connection requirement takes priority over archive capability");
assert(disconnected[6]?.disabledReason === "连接真实邮箱后可用", "delete requires a connected mailbox");

const noArchive = resolveContextCommands({
  kind: "mail-message",
  id: "message-2",
  subject: "No archive",
  connected: true,
  busy: false,
  isRead: false,
  isStarred: false,
  canArchive: false,
});
assert(noArchive[5]?.disabledReason === "无归档文件夹", "archive capability is reported clearly");

const calendarEvent = resolveContextCommands({
  kind: "calendar-event",
  id: "event-1",
  title: "Review",
  busy: false,
  hasLinkedTask: true,
  readOnly: false,
  hasWritableCalendar: true,
});
assert(calendarEvent.map((command) => command.id).join(",") === [
  "calendar.open",
  "calendar.edit",
  "calendar.open-task",
  "calendar.duplicate",
  "calendar.create-note",
  "calendar.create-prep-task",
  "calendar.create-followup-task",
  "calendar.delete",
].join(","), "calendar event command order is stable");
assert(calendarEvent[0]?.label === "查看日程详情" && !calendarEvent[0].disabledReason, "calendar details are always available");
assert(calendarEvent[2]?.label === "打开来源任务" && !calendarEvent[2].disabledReason, "linked calendar event can return to its task");
assert(calendarEvent[4]?.label === "创建会议笔记" && !calendarEvent[4].disabledReason, "calendar event can create a meeting note");
assert(calendarEvent[5]?.label === "创建准备任务" && calendarEvent[6]?.label === "创建跟进任务", "calendar event exposes preparation and follow-up workflows");
assert(calendarEvent[7]?.risk === "destructive", "calendar deletion is classified as destructive");

const readOnlyCalendarEvent = resolveContextCommands({
  kind: "calendar-event",
  id: "remote-event-1",
  title: "RWTH meeting",
  busy: false,
  hasLinkedTask: false,
  readOnly: true,
  hasWritableCalendar: true,
});
assert(!readOnlyCalendarEvent[0]?.disabledReason, "read-only calendar details remain available");
assert(readOnlyCalendarEvent[1]?.disabledReason === "只读日历不可编辑", "read-only calendar edit explains the restriction");
assert(!readOnlyCalendarEvent[3]?.disabledReason && readOnlyCalendarEvent[3]?.label === "复制到个人日历", "read-only events can be copied locally");
assert(readOnlyCalendarEvent[7]?.disabledReason === "只读日历不可删除", "read-only calendar deletion is disabled");

const protectedExchangeEvent = resolveContextCommands({
  kind: "calendar-event",
  id: "remote-meeting-1",
  title: "RWTH invited meeting",
  busy: false,
  hasLinkedTask: false,
  readOnly: false,
  writeDisabledReason: "含参会人的会议暂不支持写回，避免误发会议通知",
  hasWritableCalendar: true,
});
assert(protectedExchangeEvent[1]?.disabledReason?.includes("会议"), "protected Exchange meeting edit explains the restriction");
assert(protectedExchangeEvent[7]?.disabledReason?.includes("会议"), "protected Exchange meeting deletion explains the restriction");

const calendarSlot = resolveContextCommands({
  kind: "calendar-slot",
  startsAt: "2026-07-20T09:00:00.000Z",
  busy: false,
});
assert(calendarSlot.map((command) => command.id).join(",") === [
  "calendar.create-event",
  "calendar.create-focus",
].join(","), "calendar slot commands are available");

const task = resolveContextCommands({
  kind: "task",
  id: "task-1",
  title: "Prepare review",
  busy: false,
  important: true,
  urgent: false,
  waiting: false,
  hasMailSource: true,
});
assert(task.map((command) => command.id).join(",") === [
  "task.complete",
  "task.open-mail",
  "task.schedule",
  "task.edit",
  "task.toggle-important",
  "task.toggle-urgent",
  "task.set-waiting",
  "task.delete",
].join(","), "task command order is stable");
assert(task[4]?.label === "移出重要", "task importance command reflects current state");
assert(task[1]?.label === "打开关联邮件" && !task[1].disabledReason, "linked task can open its mail source");
assert(task[2]?.label === "安排到日历", "task scheduling command is available");
assert(task[7]?.risk === "destructive", "task deletion is classified as destructive");

const taskWithoutMail = resolveContextCommands({
  kind: "task",
  id: "task-2",
  title: "Local task",
  busy: false,
  important: false,
  urgent: false,
  waiting: false,
  hasMailSource: false,
});
assert(taskWithoutMail[1]?.disabledReason === "任务未关联邮件", "mail command explains when no source is linked");

const note = resolveContextCommands({
  kind: "note",
  id: "note-1",
  title: "Product notes",
  busy: false,
  pinned: false,
});
assert(note.map((command) => command.id).join(",") === [
  "note.open",
  "note.rename",
  "note.toggle-pin",
  "note.duplicate",
  "note.delete",
].join(","), "note command order is stable");
assert(note[2]?.label === "置顶笔记" && note[2]?.icon === "star", "note pin command reflects current state");
assert(note[4]?.risk === "destructive", "note deletion is classified as destructive");

const pinnedBusyNote = resolveContextCommands({
  kind: "note",
  id: "note-2",
  title: "Pinned note",
  busy: true,
  pinned: true,
});
assert(pinnedBusyNote[2]?.label === "取消置顶" && pinnedBusyNote[2]?.icon === "star-filled", "pinned note command reflects current state");
assert(pinnedBusyNote[1]?.disabledReason === "操作进行中" && pinnedBusyNote[4]?.disabledReason === "操作进行中", "note writes are disabled while busy");

const activeProject = resolveContextCommands({
  kind: "project",
  id: "project-1",
  title: "Drone development",
  busy: false,
  archived: false,
});
assert(activeProject.map((command) => command.id).join(",") === [
  "project.open",
  "project.create-task",
  "project.create-note",
  "project.move-area",
  "project.edit",
  "project.copy-link",
  "project.archive",
].join(","), "active project commands are stable");
assert(activeProject[1]?.label === "添加任务" && !activeProject[1]?.disabledReason, "active projects accept tasks");
assert(activeProject[6]?.label === "归档项目" && activeProject[6]?.risk === "local-write", "active projects can be archived safely");

const archivedProject = resolveContextCommands({
  kind: "project",
  id: "project-2",
  title: "Old project",
  busy: false,
  archived: true,
});
assert(archivedProject.map((command) => command.id).join(",") === [
  "project.open",
  "project.move-area",
  "project.edit",
  "project.copy-link",
  "project.restore",
].join(","), "archived project commands replace archive with restore");
assert(archivedProject[4]?.label === "恢复项目" && archivedProject[4]?.icon === "restore", "archived projects can be restored");

console.log("Context command registry tests passed");
