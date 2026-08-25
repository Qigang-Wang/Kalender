export type ContextCommandGroup = "primary" | "state" | "organize" | "danger";
export type ContextCommandRisk = "read" | "local-write" | "external-write" | "destructive";
export type ContextCommandIcon =
  | "archive"
  | "calendar-plus"
  | "clock"
  | "copy"
  | "download"
  | "edit"
  | "eye"
  | "eye-off"
  | "folder"
  | "info"
  | "mail"
  | "note"
  | "open"
  | "refresh"
  | "restore"
  | "sparkles"
  | "star"
  | "star-filled"
  | "task"
  | "trash";

export type MailMessageCommandId =
  | "mail.toggle-read"
  | "mail.toggle-star"
  | "mail.create-task"
  | "mail.assign-project"
  | "mail.ai-summary"
  | "mail.archive"
  | "mail.delete";

export type MailFolderCommandId =
  | "mail-folder.create-child"
  | "mail-folder.create-sibling"
  | "mail-folder.rename"
  | "mail-folder.move-root"
  | "mail-folder.delete";

export type MailAccountCommandId = "mail-account.sync";
export type CalendarAccountCommandId = "calendar-account.sync";
export type SidebarCommandId =
  | "sidebar.toggle-section";

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

export type ProjectCommandId =
  | "project.open"
  | "project.create-task"
  | "project.create-note"
  | "project.move-area"
  | "project.edit"
  | "project.copy-link"
  | "project.archive"
  | "project.restore";

export type ProjectAreaCommandId =
  | "project-area.create-project"
  | "project-area.rename"
  | "project-area.toggle"
  | "project-area.collapse-others";

export type ProjectGanttCommandId =
  | "gantt.add-task"
  | "gantt.add-milestone"
  | "gantt.add-phase"
  | "gantt.edit-task"
  | "gantt.delete-task"
  | "gantt.edit-phase"
  | "gantt.delete-phase"
  | "gantt.remove-phase";

export type JobCommandId =
  | "job.copy-id"
  | "job.copy-logs"
  | "job.retry"
  | "job.cancel"
  | "job.delete";

export type BackupArtifactCommandId =
  | "backup.download"
  | "backup.restore"
  | "backup.copy-name"
  | "backup.copy-checksum"
  | "backup.delete";

export type SearchResultCommandId =
  | "search.open"
  | "search.copy-link"
  | "search.copy-title";

export type ContextCommandId = MailMessageCommandId | MailFolderCommandId | MailAccountCommandId | CalendarAccountCommandId | SidebarCommandId | CalendarEventCommandId | CalendarSlotCommandId | TaskCommandId | NoteCommandId | ProjectCommandId | ProjectAreaCommandId | ProjectGanttCommandId | JobCommandId | BackupArtifactCommandId | SearchResultCommandId;

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

export interface ProjectContextTarget {
  readonly kind: "project";
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
  readonly archived: boolean;
}

export type ContextTarget = MailMessageContextTarget | CalendarEventContextTarget | CalendarSlotContextTarget | TaskContextTarget | NoteContextTarget | ProjectContextTarget;

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
      label: target.isRead ? "Als ungelesen markieren" : "Als gelesen markieren",
      icon: target.isRead ? "eye-off" : "eye",
      disabledReason: remoteWriteDisabledReason(target),
    }),
  },
  {
    id: "mail.toggle-star",
    group: "state",
    risk: "external-write",
    resolve: (target) => ({
      label: target.isStarred ? "Markierung entfernen" : "Markieren",
      icon: target.isStarred ? "star-filled" : "star",
      disabledReason: remoteWriteDisabledReason(target),
    }),
  },
  {
    id: "mail.create-task",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Verknüpfte Aufgabe erstellen", icon: "task", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "mail.assign-project",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Mit Projekt verknüpfen", icon: "folder", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "mail.ai-summary",
    group: "organize",
    risk: "read",
    resolve: () => ({ label: "AI-Zusammenfassung", icon: "sparkles", disabledReason: "GPT konfigurieren" }),
  },
  {
    id: "mail.archive",
    group: "danger",
    risk: "external-write",
    resolve: (target) => ({
      label: "Archiv",
      icon: "archive",
      disabledReason: remoteWriteDisabledReason(target) ?? (target.canArchive ? undefined : "Kein Archivordner"),
    }),
  },
  {
    id: "mail.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({
      label: "Löschen",
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
    resolve: () => ({ label: "Termindetails anzeigen", icon: "eye" }),
  },
  {
    id: "calendar.edit",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "Termin bearbeiten", icon: "edit", disabledReason: target.writeDisabledReason ?? (target.readOnly ? "Schreibgeschützter Kalender kann nicht bearbeitet werden" : target.busy ? "Aktion läuft" : undefined) }),
  },
  {
    id: "calendar.open-task",
    group: "primary",
    risk: "read",
    resolve: (target) => ({ label: "Verknüpfte Aufgabe öffnen", icon: "task", disabledReason: target.hasLinkedTask ? undefined : "Termin ist mit keiner Aufgabe verknüpft" }),
  },
  {
    id: "calendar.duplicate",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "In persönlichen Kalender kopieren", icon: "copy", disabledReason: target.busy ? "Aktion läuft" : target.hasWritableCalendar ? undefined : "Kein beschreibbarer persönlicher Kalender" }),
  },
  {
    id: "calendar.create-note",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Besprechungsnotiz erstellen", icon: "note", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "calendar.create-prep-task",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Vorbereitungsaufgabe erstellen", icon: "task", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "calendar.create-followup-task",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Folgeaufgabe erstellen", icon: "task", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "calendar.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({ label: "Termin löschen", icon: "trash", disabledReason: target.writeDisabledReason ?? (target.readOnly ? "Schreibgeschützter Kalender kann nicht gelöscht werden" : target.busy ? "Aktion läuft" : undefined) }),
  },
];

const calendarSlotCommandRegistry: readonly ContextCommandDefinition<CalendarSlotContextTarget>[] = [
  {
    id: "calendar.create-event",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "Neuer Termin", icon: "calendar-plus", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "calendar.create-focus",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Fokuszeit einplanen", icon: "clock", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
];

const taskCommandRegistry: readonly ContextCommandDefinition<TaskContextTarget>[] = [
  {
    id: "task.complete",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "Als erledigt markieren", icon: "task", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "task.open-mail",
    group: "primary",
    risk: "read",
    resolve: (target) => ({ label: "Verknüpfte E-Mail öffnen", icon: "mail", disabledReason: target.hasMailSource ? undefined : "Aufgabe ist mit keiner E-Mail verknüpft" }),
  },
  {
    id: "task.schedule",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Im Kalender einplanen", icon: "calendar-plus", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "task.edit",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "Aufgabe bearbeiten", icon: "edit", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "task.toggle-important",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: target.important ? "Wichtig entfernen" : "Wichtig markieren", icon: target.important ? "star-filled" : "star", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "task.toggle-urgent",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: target.urgent ? "Dringlichkeit entfernen" : "Als dringend markieren", icon: "clock", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "task.set-waiting",
    group: "state",
    risk: "local-write",
    resolve: (target) => ({ label: target.waiting ? "Auf „Als Nächstes“ setzen" : "Auf „Warten“ setzen", icon: "eye", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "task.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({ label: "Aufgabe löschen", icon: "trash", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
];

const noteCommandRegistry: readonly ContextCommandDefinition<NoteContextTarget>[] = [
  {
    id: "note.open",
    group: "primary",
    risk: "read",
    resolve: () => ({ label: "Notiz öffnen", icon: "note" }),
  },
  {
    id: "note.rename",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "Umbenennen", icon: "edit", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "note.toggle-pin",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: target.pinned ? "Nicht mehr anheften" : "Notiz anheften", icon: target.pinned ? "star-filled" : "star", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "note.duplicate",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Kopie erstellen", icon: "copy", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "note.delete",
    group: "danger",
    risk: "destructive",
    resolve: (target) => ({ label: "Notiz löschen", icon: "trash", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
];

const projectCommandRegistry: readonly ContextCommandDefinition<ProjectContextTarget>[] = [
  {
    id: "project.open",
    group: "primary",
    risk: "read",
    resolve: () => ({ label: "Projekt öffnen", icon: "eye" }),
  },
  {
    id: "project.create-task",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "Aufgabe hinzufügen", icon: "task", disabledReason: target.archived ? "Aufgaben für archivierte Projekte können nicht hinzugefügt werden" : target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "project.create-note",
    group: "primary",
    risk: "local-write",
    resolve: (target) => ({ label: "Notiz hinzufügen", icon: "note", disabledReason: target.archived ? "archivierte Projekte können keine Notizen hinzufügen" : target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "project.move-area",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "In Bereich verschieben", icon: "folder", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "project.edit",
    group: "organize",
    risk: "local-write",
    resolve: (target) => ({ label: "Projekt bearbeiten", icon: "edit", disabledReason: target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "project.copy-link",
    group: "organize",
    risk: "read",
    resolve: () => ({ label: "Projektlink kopieren", icon: "copy" }),
  },
  {
    id: "project.archive",
    group: "state",
    risk: "local-write",
    resolve: (target) => ({ label: "Projekt archivieren", icon: "archive", disabledReason: target.archived ? "Projekt archiviert" : target.busy ? "Aktion läuft" : undefined }),
  },
  {
    id: "project.restore",
    group: "state",
    risk: "local-write",
    resolve: (target) => ({ label: "Projekt wiederherstellen", icon: "restore", disabledReason: target.archived ? target.busy ? "Aktion läuft" : undefined : "Projekt noch nicht archiviert" }),
  },
];

export function resolveContextCommands(target: ContextTarget): readonly ResolvedContextCommand[] {
  if (target.kind === "mail-message") return resolveRegistry(target, mailMessageCommandRegistry);
  if (target.kind === "calendar-event") return resolveRegistry(target, calendarEventCommandRegistry);
  if (target.kind === "calendar-slot") return resolveRegistry(target, calendarSlotCommandRegistry);
  if (target.kind === "note") return resolveRegistry(target, noteCommandRegistry);
  if (target.kind === "project") {
    return resolveRegistry(target, projectCommandRegistry).filter((command) => (
      target.archived
        ? command.id !== "project.archive" && command.id !== "project.create-task" && command.id !== "project.create-note"
        : command.id !== "project.restore"
    ));
  }
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
  if (!target.connected) return "Nach Verbindung eines Postfachs verfügbar";
  if (target.busy) return "Aktion läuft";
  return undefined;
}
