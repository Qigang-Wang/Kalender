interface PlanProgressAction {
  readonly planItemId?: string;
  readonly status: string;
}

interface PlanProgressItem {
  readonly id: string;
  readonly status: string;
}

export function findCompletableLinkedPlanItem<T extends PlanProgressItem>(
  planItems: readonly T[],
  actions: readonly PlanProgressAction[],
  planItemId: string,
): T | undefined {
  const planItem = planItems.find((item) => item.id === planItemId);
  if (!planItem || planItem.status === "done" || planItem.status === "cancelled") return undefined;
  const linkedActions = actions.filter((action) => action.planItemId === planItem.id);
  if (!linkedActions.length || linkedActions.some((action) => action.status !== "done")) return undefined;
  return planItem;
}
