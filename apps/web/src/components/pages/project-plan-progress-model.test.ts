import assert from "node:assert/strict";

import { findCompletableLinkedPlanItem } from "./project-plan-progress-model";

const planItems = [
  { id: "active", title: "Active plan", status: "in_progress" },
  { id: "done", title: "Done plan", status: "done" },
  { id: "cancelled", title: "Cancelled plan", status: "cancelled" },
];

assert.equal(
  findCompletableLinkedPlanItem(planItems, [
    { planItemId: "active", status: "done" },
    { planItemId: "active", status: "done" },
  ], "active")?.id,
  "active",
  "all linked actions completing should make an active plan item eligible",
);

assert.equal(
  findCompletableLinkedPlanItem(planItems, [
    { planItemId: "active", status: "done" },
    { planItemId: "active", status: "next" },
  ], "active"),
  undefined,
  "an incomplete linked action should keep the plan item in progress",
);

assert.equal(
  findCompletableLinkedPlanItem(planItems, [{ planItemId: "done", status: "done" }], "done"),
  undefined,
  "a completed plan item should not prompt again",
);

assert.equal(
  findCompletableLinkedPlanItem(planItems, [{ planItemId: "cancelled", status: "done" }], "cancelled"),
  undefined,
  "a cancelled plan item should not be completed",
);

assert.equal(
  findCompletableLinkedPlanItem(planItems, [{ planItemId: "other", status: "done" }], "active"),
  undefined,
  "a plan item without linked actions should not prompt",
);

console.log("project plan progress model tests passed");
