import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabaseForRestore, getDatabase } from "./database";
import {
  deleteStoredProjectPhase,
  getStoredProjectOverview,
  reorderStoredProjectGanttItem,
  saveStoredProjectMilestone,
  saveStoredProjectPhase,
} from "./project-repository";
import { deleteStoredProjectPlanItem, reorderStoredProjectPlanItem, saveStoredProjectPlanItem } from "./project-plan-repository";

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
    const validationPhase = await saveStoredProjectPhase({
      projectId: "project-test",
      name: "Validation",
      color: "#9ad3bc",
      sortOrder: 1,
    });
    const milestone = await saveStoredProjectMilestone({
      projectId: "project-test",
      phaseId: phase.id,
      title: "Prototype approved",
      dueOn: "2026-07-31",
      status: "active",
    });
    const validationMilestone = await saveStoredProjectMilestone({
      projectId: "project-test",
      phaseId: validationPhase.id,
      title: "Validation complete",
      dueOn: "2026-08-04",
      status: "planned",
    });
    const predecessorPlan = await saveStoredProjectPlanItem({
      projectId: "project-test",
      title: "Prepare prototype",
      plannedStart: "2026-07-24",
      plannedEnd: "2026-07-27",
      dependencyIds: [],
      phaseId: phase.id,
      durationWorkdays: 2,
      autoSchedule: false,
    });
    const successorPlan = await saveStoredProjectPlanItem({
      projectId: "project-test",
      title: "Run validation",
      plannedStart: "2026-07-24",
      plannedEnd: "2026-07-28",
      dependencyIds: [predecessorPlan.id],
      phaseId: phase.id,
      durationWorkdays: 3,
      autoSchedule: true,
    });
    await database.query("UPDATE tasks SET plan_item_id = $1 WHERE id = 'task-a'", [predecessorPlan.id]);

    let overview = await getStoredProjectOverview("project-test");
    assert(
      overview?.tasks.length === 2 && overview.notes.length === 0,
      "project overview queries only the selected project's tasks and notes",
    );
    assert(
      overview.milestones.find((entry) => entry.id === milestone.id)?.phaseId === phase.id,
      "project milestones can belong to a project phase",
    );
    const predecessor = overview?.ganttTasks.find((task) => task.id === predecessorPlan.id);
    let successor = overview?.ganttTasks.find((task) => task.id === successorPlan.id);
    assert(overview?.ganttTasks.length === 2, "only explicit plan items appear in the gantt chart");
    assert(predecessor?.linkedTaskCount === 1, "plan items expose linked action progress");
    assert(predecessor?.plannedEnd === "2026-07-25", "plan item duration includes weekend days");
    assert(successor?.plannedStart === "2026-07-26", "automatic scheduling starts on the calendar day after the predecessor");
    assert(successor.plannedEnd === "2026-07-28", "automatic scheduling preserves calendar-day duration");

    await reorderStoredProjectPlanItem("project-test", successorPlan.id, phase.id, predecessorPlan.id);
    overview = await getStoredProjectOverview("project-test");
    assert(
      overview!.ganttTasks.find((task) => task.id === successorPlan.id)!.ganttSortOrder
        < overview!.ganttTasks.find((task) => task.id === predecessorPlan.id)!.ganttSortOrder,
      "plan items can be reordered inside a project phase",
    );

    overview = await reorderStoredProjectGanttItem({
      projectId: "project-test",
      kind: "milestone",
      itemId: milestone.id,
      phaseId: validationPhase.id,
      beforeId: validationMilestone.id,
    });
    const movedMilestone = overview.milestones.find((entry) => entry.id === milestone.id)!;
    assert(movedMilestone.phaseId === validationPhase.id, "milestones can move across project phases");
    assert(
      movedMilestone.sortOrder < overview.milestones.find((entry) => entry.id === validationMilestone.id)!.sortOrder,
      "milestones preserve their dropped order in the destination phase",
    );
    await reorderStoredProjectGanttItem({
      projectId: "project-test",
      kind: "milestone",
      itemId: milestone.id,
      phaseId: phase.id,
    });

    const movedPlan = await saveStoredProjectPlanItem({
      id: predecessorPlan.id,
      projectId: "project-test",
      title: "Prepare production prototype",
      plannedStart: "2026-07-27",
      plannedEnd: "2026-07-28",
      dependencyIds: [],
      phaseId: phase.id,
      durationWorkdays: 2,
      autoSchedule: false,
      projectStatus: "done",
    });
    overview = await getStoredProjectOverview("project-test");
    successor = overview!.ganttTasks.find((task) => task.id === successorPlan.id);
    assert(movedPlan.plannedStart === "2026-07-27", "save result returns the confirmed plan item");
    assert(movedPlan.title === "Prepare production prototype", "gantt plan can rename a plan item");
    assert(movedPlan.projectStatus === "done", "gantt plan can complete a plan item");
    assert(overview!.tasks.find((task) => task.id === "task-a")?.status === "next", "completing a plan item does not complete its linked action");
    assert(successor?.plannedStart === "2026-07-29", "moving a predecessor cascades to automatic successors");
    assert(successor.plannedEnd === "2026-07-31", "cascaded scheduling preserves consecutive-day duration");

    assert(await deleteStoredProjectPhase("project-test", phase.id), "phase can be deleted");
    assert(await deleteStoredProjectPhase("project-test", validationPhase.id), "second phase can be deleted");
    overview = await getStoredProjectOverview("project-test");
    assert(overview?.phases.length === 0, "deleted phase is removed from the project");
    assert(overview?.ganttTasks.every((task) => !task.phaseId), "deleting a phase preserves and ungroups its plan items");
    assert(
      overview?.milestones.some((entry) => entry.id === milestone.id && !entry.phaseId),
      "deleting a phase preserves its milestones as project-level milestones",
    );
    assert(await deleteStoredProjectPlanItem("project-test", predecessorPlan.id), "plan item can be deleted independently");
    overview = await getStoredProjectOverview("project-test");
    assert(overview?.tasks.some((task) => task.id === "task-a" && !task.planItemId), "deleting a plan item preserves and unlinks its actions");
    assert(overview?.ganttTasks.every((task) => !task.dependencyIds.includes(predecessorPlan.id)), "deleting a plan item removes plan dependencies");
    console.log("Project plan-item separation and automatic scheduling tests passed");
  } finally {
    await closeDatabaseForRestore().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
