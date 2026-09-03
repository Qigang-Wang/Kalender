import { getStoredProjectOverview } from "./project-repository";

export interface McpProjectNextAction {
  readonly taskId: string;
  readonly title: string;
  readonly state: "ready" | "blocked";
  readonly priority: "urgent" | "important" | "normal";
  readonly scheduleStatus: "scheduled" | "unscheduled";
  readonly estimatedMinutes?: number;
  readonly scheduledBlocks: readonly { readonly eventId: string; readonly start: string; readonly end: string }[];
  readonly blockedReasons: readonly string[];
}

export async function listMcpProjectNextActions(projectId: string): Promise<readonly McpProjectNextAction[]> {
  const overview = await getStoredProjectOverview(projectId);
  if (!overview) return [];
  const plans = new Map(overview.planItems.map((item) => [item.id, item]));
  return overview.tasks
    .filter((task) => task.status !== "done")
    .map((task) => {
      const reasons: string[] = [];
      if (task.status !== "next") reasons.push(`task_status_${task.status}`);
      if (overview.project.status !== "active") reasons.push("project_not_active");
      const plan = task.planItemId ? plans.get(task.planItemId) : undefined;
      if (plan && ["paused", "cancelled", "done"].includes(plan.status)) reasons.push(`plan_item_${plan.status}`);
      if (plan) for (const dependencyId of plan.dependencyIds) if (plans.get(dependencyId)?.status !== "done") reasons.push(`dependency_not_done:${dependencyId}`);
      return {
        taskId: task.id, title: task.title, state: reasons.length ? "blocked" as const : "ready" as const,
        priority: task.isUrgent ? "urgent" as const : task.important ? "important" as const : "normal" as const,
        scheduleStatus: task.scheduledBlocks.length ? "scheduled" as const : "unscheduled" as const,
        estimatedMinutes: task.estimatedMinutes,
        scheduledBlocks: task.scheduledBlocks.map((block) => ({ eventId: block.eventId, start: block.start, end: block.end })),
        blockedReasons: reasons.sort(), important: task.important, urgent: task.isUrgent, dueAt: task.dueAt ?? "9999-12-31T00:00:00.000Z",
      };
    })
    .sort((left, right) => Number(right.state === "ready") - Number(left.state === "ready") || Number(right.important) - Number(left.important) || Number(right.urgent) - Number(left.urgent) || left.dueAt.localeCompare(right.dueAt) || left.title.localeCompare(right.title))
    .map(({ important: _important, urgent: _urgent, dueAt: _dueAt, ...entry }) => entry);
}
