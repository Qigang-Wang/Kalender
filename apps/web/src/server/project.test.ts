import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabaseForRestore, getDatabase } from "./database";
import {
  deleteStoredProjectPhase,
  getStoredProjectOverview,
  saveStoredProjectPhase,
  saveStoredProjectTaskPlan,
} from "./project-repository";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const root = path.join(tmpdir(), `kalender-project-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = root;
  await mkdir(root, { recursive: true });
  try {
    const database = await getDatabase();
    await database.query(
      `INSERT INTO projects (id, name, color, status)
       VALUES
         ('project-test', 'Project test', '#86bdf5', 'active'),
         ('project-unrelated', 'Unrelated project', '#9ad3bc', 'active')`,
    );
    await database.query(
      `INSERT INTO tasks (id, title, status, project_id, project_name)
       VALUES
         ('task-a', 'Prepare prototype', 'next', 'project-test', 'Project test'),
         ('task-b', 'Run validation', 'next', 'project-test', 'Project test'),
         ('task-unrelated', 'Unrelated task', 'next', 'project-unrelated', 'Unrelated project')`,
    );
    await database.query(
      `INSERT INTO notes (id, project_id, title, content)
       VALUES ('note-unrelated', 'project-unrelated', 'Unrelated note', '')`,
    );

    const phase = await saveStoredProjectPhase({
      projectId: "project-test",
      name: "Prototype",
      color: "#86bdf5",
    });
    await saveStoredProjectTaskPlan({
      projectId: "project-test",
      taskId: "task-a",
      plannedStart: "2026-07-24",
      plannedEnd: "2026-07-27",
      dependencyIds: [],
      phaseId: phase.id,
      durationWorkdays: 2,
      autoSchedule: false,
    });
    await saveStoredProjectTaskPlan({
      projectId: "project-test",
      taskId: "task-b",
      plannedStart: "2026-07-24",
      plannedEnd: "2026-07-28",
      dependencyIds: ["task-a"],
      phaseId: phase.id,
      durationWorkdays: 3,
      autoSchedule: true,
    });

    let overview = await getStoredProjectOverview("project-test");
    assert(
      overview?.tasks.length === 2 && overview.notes.length === 0,
      "project overview queries only the selected project's tasks and notes",
    );
    const predecessor = overview?.ganttTasks.find((task) => task.id === "task-a");
    let successor = overview?.ganttTasks.find((task) => task.id === "task-b");
    assert(predecessor?.plannedEnd === "2026-07-25", "task duration includes weekend days");
    assert(successor?.plannedStart === "2026-07-26", "automatic scheduling starts on the calendar day after the predecessor");
    assert(successor.plannedEnd === "2026-07-28", "automatic scheduling preserves calendar-day duration");

    const movedPlan = await saveStoredProjectTaskPlan({
      projectId: "project-test",
      taskId: "task-a",
      plannedStart: "2026-07-27",
      plannedEnd: "2026-07-28",
      dependencyIds: [],
      phaseId: phase.id,
      durationWorkdays: 2,
      autoSchedule: false,
    });
    overview = movedPlan.overview;
    successor = movedPlan.overview.ganttTasks.find((task) => task.id === "task-b");
    assert(movedPlan.task.plannedStart === "2026-07-27", "save result returns the confirmed dragged task");
    assert(successor?.plannedStart === "2026-07-29", "moving a predecessor cascades to automatic successors");
    assert(successor.plannedEnd === "2026-07-31", "cascaded scheduling preserves consecutive-day duration");

    assert(await deleteStoredProjectPhase("project-test", phase.id), "phase can be deleted");
    overview = await getStoredProjectOverview("project-test");
    assert(overview?.phases.length === 0, "deleted phase is removed from the project");
    assert(overview?.ganttTasks.every((task) => !task.phaseId), "deleting a phase preserves and ungroups its tasks");
    console.log("Project phase and automatic scheduling tests passed");
  } finally {
    await closeDatabaseForRestore().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
