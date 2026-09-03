import { appConfirm } from "@/components/app-dialog-provider";
import { workspaceFetch } from "@/lib/workspace-fetch-cache";
import { findCompletableLinkedPlanItem } from "./project-plan-progress-model";

interface CompletedAction {
  readonly projectId?: string;
  readonly planItemId?: string;
  readonly status: string;
}

interface PlanAction {
  readonly planItemId?: string;
  readonly status: string;
}

interface PlanItem {
  readonly id: string;
  readonly title: string;
  readonly status: "planned" | "in_progress" | "paused" | "done" | "cancelled";
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly dependencyIds: readonly string[];
  readonly phaseId?: string;
  readonly durationWorkdays?: number;
  readonly autoSchedule: boolean;
}

interface ProjectOverview {
  readonly tasks: readonly PlanAction[];
  readonly planItems: readonly PlanItem[];
}

export async function offerToCompleteLinkedPlanItem(action: CompletedAction): Promise<boolean> {
  if (action.status !== "done" || !action.projectId || !action.planItemId) return false;
  const response = await workspaceFetch(`/api/projects/${encodeURIComponent(action.projectId)}`, {}, 0);
  const payload = await response.json() as {
    readonly ok?: boolean;
    readonly overview?: ProjectOverview;
    readonly message?: string;
  };
  if (!response.ok || !payload.ok || !payload.overview) {
    throw new Error(payload.message ?? "无法检查计划项进度");
  }
  const planItem = findCompletableLinkedPlanItem(payload.overview.planItems, payload.overview.tasks, action.planItemId);
  if (!planItem) return false;
  const linkedActions = payload.overview.tasks.filter((task) => task.planItemId === planItem.id);

  const confirmed = await appConfirm({
    title: "关联行动已全部完成",
    description: `计划项“${planItem.title}”的 ${linkedActions.length} 个关联行动都已完成。是否将计划项也标记为已完成？`,
    confirmLabel: "完成计划项",
    tone: "default",
  });
  if (!confirmed) return false;

  const saveResponse = await fetch(
    `/api/projects/${encodeURIComponent(action.projectId)}/plan-items/${encodeURIComponent(planItem.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: planItem.title,
        status: "done",
        plannedStart: planItem.plannedStart,
        plannedEnd: planItem.plannedEnd,
        dependencyIds: planItem.dependencyIds,
        phaseId: planItem.phaseId ?? null,
        durationWorkdays: planItem.durationWorkdays,
        autoSchedule: planItem.autoSchedule,
      }),
    },
  );
  const savePayload = await saveResponse.json() as { readonly ok?: boolean; readonly message?: string };
  if (!saveResponse.ok || !savePayload.ok) throw new Error(savePayload.message ?? "无法完成计划项");
  return true;
}
