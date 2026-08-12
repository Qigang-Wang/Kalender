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
  if (!project) return { ok: false, message: "项目不存在或已删除" };
  if (project.status === "archived") return { ok: false, message: "已归档项目不能添加任务" };
  return {
    ok: true,
    status,
    projectId: project.id,
    projectName: project.name,
    areaName: project.areaName ?? "",
  };
}
