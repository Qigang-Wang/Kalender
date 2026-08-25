export type NewTaskView = "today" | "inbox" | "upcoming" | "waiting" | "projects" | "completed" | "matrix";
export type NewTaskStatus = "inbox" | "next";

export interface NewTaskProject {
  readonly id: string;
  readonly name: string;
  readonly areaName?: string;
  readonly status: "active" | "archived";
}

export type NewTaskDefaults = {
  readonly ok: true;
  readonly status: NewTaskStatus;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly areaName?: string;
} | {
  readonly ok: false;
  readonly message: string;
};

export function resolveNewTaskDefaults(
  view: NewTaskView,
  selectedProjectId: string | undefined,
  projects: readonly NewTaskProject[],
): NewTaskDefaults {
  const status = view === "matrix" || view === "projects" ? "next" : "inbox";
  if (view !== "projects" || !selectedProjectId) return { ok: true, status };

  const project = projects.find((entry) => entry.id === selectedProjectId);
  if (!project) return { ok: false, message: "Projekt nicht gefunden oder gelöscht" };
  if (project.status === "archived") return { ok: false, message: "Aufgaben für archivierte Projekte können nicht hinzugefügt werden" };
  return {
    ok: true,
    status,
    projectId: project.id,
    projectName: project.name,
    areaName: project.areaName ?? "",
  };
}
