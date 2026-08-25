import assert from "node:assert/strict";

import { resolveNewTaskDefaults } from "./task-view-model";

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
  { ok: false, message: "Aufgaben für archivierte Projekte können nicht hinzugefügt werden" },
  "archived projects reject new tasks",
);
assert.deepEqual(
  resolveNewTaskDefaults("projects", "missing-project", projects),
  { ok: false, message: "Projekt nicht gefunden oder gelöscht" },
  "missing projects reject new tasks",
);

console.log("Task view model tests passed");
