import assert from "node:assert/strict";

import { formatTaskNotesList } from "../../lib/task-notes";
import { resolveNewTaskDefaults } from "./task-view-model";

assert.equal(formatTaskNotesList("第一项\n第二项", 0, 7, "ordered").value, "1. 第一项\n2. 第二项");
assert.equal(formatTaskNotesList("- 第一项", 0, 5, "task").value, "- [ ] 第一项");

const projects = [
  { id: "active-project", name: "AGW", areaName: "AMT", status: "active" as const },
  { id: "archived-project", name: "Old", status: "archived" as const },
];

assert.deepEqual(
  resolveNewTaskDefaults("projects", "active-project", projects),
  { ok: true, status: "next", projectId: "active-project", projectName: "AGW", areaName: "AMT" },
  "adding from a selected project creates an active task already assigned to that project",
);
assert.deepEqual(
  resolveNewTaskDefaults("projects", undefined, projects),
  { ok: true, status: "next" },
  "adding from the all-projects view creates an active task that remains visible after choosing a project",
);
assert.deepEqual(
  resolveNewTaskDefaults("matrix", undefined, projects),
  { ok: true, status: "next" },
  "adding from the matrix creates an active task",
);
assert.deepEqual(
  resolveNewTaskDefaults("today", undefined, projects),
  { ok: true, status: "inbox" },
  "other task views retain quick-capture behavior",
);
assert.deepEqual(
  resolveNewTaskDefaults("projects", "archived-project", projects),
  { ok: false, message: "已归档项目不能添加任务" },
  "archived projects reject new tasks",
);
assert.deepEqual(
  resolveNewTaskDefaults("projects", "missing-project", projects),
  { ok: false, message: "项目不存在或已删除" },
  "missing projects reject new tasks",
);

console.log("Task view model tests passed");
