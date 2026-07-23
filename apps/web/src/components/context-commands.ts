export type ContextCommandGroup = "primary" | "state" | "organize" | "danger";
export type ContextCommandRisk = "read" | "local-write" | "external-write" | "destructive";
export type ContextCommandIcon =
  | "archive"
  | "calendar-plus"
  | "clock"
  | "copy"
  | "edit"
  | "eye"
  | "eye-off"
  | "mail"
  | "note"
  | "sparkles"
  | "star"
  | "star-filled"
  | "task"
  | "trash";

export type MailMessageCommandId =
  | "mail.toggle-read"
  | "mail.toggle-star"
  | "mail.create-task"
  | "mail.ai-summary"
  | "mail.archive"
  | "mail.delete";

export type MailFolderCommandId =
  | "mail-folder.create-child"
  | "mail-folder.create-sibling"
  | "mail-folder.rename"
  | "mail-folder.move-root"
  | "mail-folder.delete";

export type CalendarEventCommandId =
  | "calendar.open"
  | "calendar.edit"
  | "calendar.open-task"
  | "calendar.duplicate"
  | "calendar.create-note"
  | "calendar.create-prep-task"
  | "calendar.create-followup-task"
  | "calendar.delete";

export type CalendarSlotCommandId =
  | "calendar.create-event"
  | "calendar.create-focus";

export type TaskCommandId =
  | "task.complete"
  | "task.open-mail"
  | "task.schedule"
  | "task.edit"
  | "task.toggle-important"
  | "task.toggle-urgent"
  | "task.set-waiting"
  | "task.delete";

export type NoteCommandId =
  | "note.open"
  | "note.rename"
  | "note.toggle-pin"
  | "note.duplicate"
  | "note.delete";

export type ContextCommandId = MailMessageCommandId | MailFolderCommandId | CalendarEventCommandId | CalendarSlotCommandId | TaskCommandId | NoteCommandId;

export interface MailMessageContextTarget {
  readonly kind: "mail-message";
  readonly id: string;
  readonly subject: string;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly canArchive: boolean;
}

export interface CalendarEventContextTarget {
  readonly kind: "calendar-event";
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
  readonly hasLinkedTask: boolean;
  readonly readOnly: boolean;
  readonly writeDisabledReason?: string;
  readonly hasWritableCalendar: boolean;
}

export interface CalendarSlotContextTarget {
  readonly kind: "calendar-slot";
  readonly startsAt: string;
  readonly busy: boolean;
}

export interface TaskContextTarget {
  readonly kind: "task";
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
  readonly important: boolean;
  readonly urgent: boolean;
  readonly waiting: boolean;
  readonly hasMailSource: boolean;
}

export interface NoteContextTarget {
  readonly kind: "note";
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
  readonly pinned: boolean;
}

export type ContextTarget = MailMessageContextTarget | CalendarEventContextTarget | CalendarSlotContextTarget | TaskContextTarget | NoteContextTarget;

export interface ResolvedContextCommand {
  readonly id: ContextCommandId;
  readonly label: string;
  readonly group: ContextCommandGroup;
  readonly risk: ContextCommandRisk;
  readonly icon: ContextCommandIcon;
  readonly disabledReason?: string;
}

interface ContextCommandDefinition<TTarget extends ContextTarget> {
  readonly id: ContextCommandId;
  readonly group: ContextCommandGroup;
  readonly risk: ContextCommandRisk;
  readonly resolve: (target: TTarget) => Omit<ResolvedContextCommand, "id" | "group" | "risk">;
}

const mailMessageCommandRegistry: readonly ContextCommandDefinition<MailMessageContextTarget>[] = [
  {
    id: "mail.toggle-read",
    group: "state",
    risk: "external-write",
    resolve: (target) => ({
      label: target.isRead ? "标记为未读" : "标记为已读",
      icon: target.isRead ? "eye-off" : "eye",
      disabledReason: remoteWriteDisabledReason(target),
    }),
  },
  {
    id: "mail.toggle-star",
    group: "state",
    risk: "external-write",
    resolve: (target) => ({
      label: target.isStarred ? "取消星标" : "添加星标",
      icon: target.isStarred ? "star-filled" : "star",
      disabledReason: remoteWriteDisabledReason(target),
    }),
  },
  {
    id: "mail.create-task",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "创建关联任务", icon: "task", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "mail.ai-summary",
    group: "organize",
    risk: "read",
    resolve: () => ({ label: "AI 总结", icon: "sparkles", disabledReason: "需配置 GPT" }),
  },
  {
    id: "mail.archive",
    group: "danger",
    risk: "external-write",
    resolve: (target) => ({
      label: "归档",
      icon: "archive",
      disabledReason: remoteWriteDisabledReason(target) ?? (target.canArchive ? undefined : "无归档文件夹"),
    }),
  },
  {
    id: "mail.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({
      label: "删除（移至已删除邮件）",
      icon: "trash",
      disabledReason: remoteWriteDisabledReason(target),
    }),
  },
];

const calendarEventCommandRegistry: readonly ContextCommandDefinition<CalendarEventContextTarget>[] = [
  {
    id: "calendar.open",
    group: "primary",
    risk: "read",
    resolve: () => ({ label: "查看日程详情", icon: "eye" }),
  },
  {
    id: "calendar.edit",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "编辑日程", icon: "edit", disabledReason: target.writeDisabledReason ?? (target.readOnly ? "只读日历不可编辑" : target.busy ? "操作进行中" : undefined) }),
  },
  {
    id: "calendar.open-task",
    group: "primary",
    risk: "read",
    resolve: (target) => ({ label: "打开来源任务", icon: "task", disabledReason: target.hasLinkedTask ? undefined : "日程未关联任务" }),
  },
  {
    id: "calendar.duplicate",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "复制到个人日历", icon: "copy", disabledReason: target.busy ? "操作进行中" : target.hasWritableCalendar ? undefined : "没有可写的个人日历" }),
  },
  {
    id: "calendar.create-note",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "创建会议笔记", icon: "note", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "calendar.create-prep-task",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "创建准备任务", icon: "task", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "calendar.create-followup-task",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "创建跟进任务", icon: "task", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "calendar.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({ label: "删除日程", icon: "trash", disabledReason: target.writeDisabledReason ?? (target.readOnly ? "只读日历不可删除" : target.busy ? "操作进行中" : undefined) }),
  },
];

const calendarSlotCommandRegistry: readonly ContextCommandDefinition<CalendarSlotContextTarget>[] = [
  {
    id: "calendar.create-event",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "新建日程", icon: "calendar-plus", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "calendar.create-focus",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "安排专注时间", icon: "clock", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
];

const taskCommandRegistry: readonly ContextCommandDefinition<TaskContextTarget>[] = [
  {
    id: "task.complete",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "标记完成", icon: "task", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "task.open-mail",
    group: "primary",
    risk: "read",
    resolve: (target) => ({ label: "打开关联邮件", icon: "mail", disabledReason: target.hasMailSource ? undefined : "任务未关联邮件" }),
  },
  {
    id: "task.schedule",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "安排到日历", icon: "calendar-plus", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "task.edit",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "编辑任务", icon: "edit", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "task.toggle-important",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: target.important ? "移出重要" : "标记重要", icon: target.important ? "star-filled" : "star", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "task.toggle-urgent",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: target.urgent ? "标记不紧急" : "标记紧急", icon: "clock", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "task.set-waiting",
    group: "state",
    risk: "local-write",
    resolve: (target) => ({ label: target.waiting ? "移回下一步" : "设为等待中", icon: "eye", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "task.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({ label: "删除任务", icon: "trash", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
];

const noteCommandRegistry: readonly ContextCommandDefinition<NoteContextTarget>[] = [
  {
    id: "note.open",
    group: "primary",
    risk: "read",
    resolve: () => ({ label: "打开笔记", icon: "note" }),
  },
  {
    id: "note.rename",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "重命名", icon: "edit", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "note.toggle-pin",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: target.pinned ? "取消置顶" : "置顶笔记", icon: target.pinned ? "star-filled" : "star", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "note.duplicate",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "创建副本", icon: "copy", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
  {
    id: "note.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({ label: "删除笔记", icon: "trash", disabledReason: target.busy ? "操作进行中" : undefined }),
  },
];

export function resolveContextCommands(target: ContextTarget): readonly ResolvedContextCommand[] {
  if (target.kind === "mail-message") return resolveRegistry(target, mailMessageCommandRegistry);
  if (target.kind === "calendar-event") return resolveRegistry(target, calendarEventCommandRegistry);
  if (target.kind === "calendar-slot") return resolveRegistry(target, calendarSlotCommandRegistry);
  if (target.kind === "note") return resolveRegistry(target, noteCommandRegistry);
  return resolveRegistry(target, taskCommandRegistry);
}

function resolveRegistry<TTarget extends ContextTarget>(
  target: TTarget,
  registry: readonly ContextCommandDefinition<TTarget>[],
): readonly ResolvedContextCommand[] {
  return registry.map((definition) => ({
    id: definition.id,
    group: definition.group,
    risk: definition.risk,
    ...definition.resolve(target),
  }));
}

function remoteWriteDisabledReason(target: MailMessageContextTarget): string | undefined {
  if (!target.connected) return "连接真实邮箱后可用";
  if (target.busy) return "操作进行中";
  return undefined;
}
