import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-task-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const repository = await import("./task-repository");
  const planRepository = await import("./project-plan-repository");
  const noteRepository = await import("./note-repository");
  const schedule = await import("./task-schedule");
  const calendarRepository = await import("./calendar-repository");
  const { parseTaskInput, TaskValidationError } = await import("./task-validation");
  const { getDatabase } = await import("./database");
  const database = await getDatabase();
  const project = await noteRepository.saveStoredProject({
    name: "Customer project",
    description: "A shared context for delivery work",
    areaName: "Work",
    color: "#86bdf5",
    status: "active",
  });
  const planItem = await planRepository.saveStoredProjectPlanItem({
    projectId: project.id,
    title: "Deliver customer rollout",
    plannedStart: "2026-07-20",
    plannedEnd: "2026-07-24",
    durationWorkdays: 5,
    dependencyIds: [],
  });
  await database.query(
    `INSERT INTO tasks (id, title, status, project_id, plan_item_id, is_plan_item_mirror)
     VALUES ($1, $2, 'next', $3, $1, true)`,
    [planItem.id, planItem.title, project.id],
  );

  const input = parseTaskInput({
      title: " Confirm delivery time ",
      status: "next",
      important: true,
      urgencyMode: "auto",
      dueAt: "2026-07-20T12:00:00.000Z",
      estimatedMinutes: 45,
      projectId: project.id,
      planItemId: planItem.id,
      sourceReferences: [{ kind: "mail", sourceId: "message-1", label: "Delivery email", href: "/inbox" }],
    });
  const created = await repository.saveStoredTask(input);
  assert(created.title === "Confirm delivery time", "task title is normalized");
  assert(created.important && created.estimatedMinutes === 45, "priority and estimate are stored");
  assert(created.projectId === project.id && created.projectName === project.name, "task stores a real project relation");
  assert(created.planItemId === planItem.id && created.planItemTitle === planItem.title, "task can optionally link to a project plan item");
  assert(created.projectColor === project.color && created.areaName === "Work", "task inherits project presentation and area");
  assert(created.sourceReferences[0]?.kind === "mail", "mail backlink is stored");
  assert(created.isUrgent, "past automatic deadline is urgent");

  const unlinked = await repository.saveStoredTask({ ...input, id: created.id, planItemId: undefined });
  assert(!unlinked.planItemId && !unlinked.planItemTitle, "an action can be unlinked without deleting it");
  const relinked = await repository.saveStoredTask({ ...input, id: created.id });
  assert(relinked.planItemId === planItem.id, "an existing action can be linked again");

  const renamedProject = await noteRepository.saveStoredProject({
    id: project.id,
    name: "Delivery project",
    description: project.description,
    areaName: "Research",
    color: "#9ad3bc",
    status: "active",
  });
  const linkedAfterRename = await repository.getStoredTask(created.id);
  assert(
    linkedAfterRename?.projectName === renamedProject.name
      && linkedAfterRename.projectColor === renamedProject.color
      && linkedAfterRename.areaName === renamedProject.areaName,
    "linked tasks follow project metadata changes",
  );

  try {
    await repository.saveStoredTask(parseTaskInput({ title: "Invalid project task", projectId: "missing-project" }));
    throw new Error("missing project unexpectedly accepted");
  } catch (error) {
    assert(
      error instanceof repository.TaskRepositoryError && error.code === "PROJECT_NOT_FOUND",
      "archived or missing projects cannot receive new tasks",
    );
  }

  const listed = await repository.listStoredTasks();
  assert(listed.length === 1 && listed[0]?.id === created.id, "open task is listed");
  const planWithActions = (await planRepository.listStoredProjectPlanItems(project.id)).find((item) => item.id === planItem.id);
  assert(planWithActions?.linkedTaskCount === 1, "legacy plan-item mirrors are not counted as linked actions");

  const completed = await repository.saveStoredTask({ ...input, id: created.id, status: "done" });
  assert(Boolean(completed.completedAt), "completion timestamp is recorded");
  assert((await repository.listStoredTasks()).length === 0, "completed task is hidden by default");
  assert((await repository.listStoredTasks(true)).length === 1, "completed task can be requested");

  const reopened = await repository.saveStoredTask({ ...input, id: created.id, status: "next" });
  assert(!reopened.completedAt, "reopened task clears completion timestamp");
  assert(!repository.deriveTaskUrgency("not_urgent", created.dueAt), "manual not-urgent override wins");

  const firstBlock = await schedule.scheduleStoredTask(created.id, schedule.parseTaskScheduleInput({
    calendarId: "local:personal",
    start: "2026-07-22T08:00:00.000Z",
    end: "2026-07-22T09:00:00.000Z",
    timeZone: "Europe/Berlin",
  }));
  assert(firstBlock.task.scheduledBlocks.length === 1, "scheduled block is returned with the task");
  assert(firstBlock.event.linkedTask.id === created.id, "calendar event links back to the task");

  try {
    await schedule.scheduleStoredTask(created.id, schedule.parseTaskScheduleInput({
      calendarId: "local:personal",
      start: "2026-07-22T08:30:00.000Z",
      end: "2026-07-22T09:15:00.000Z",
      timeZone: "Europe/Berlin",
    }));
    throw new Error("conflicting block unexpectedly accepted");
  } catch (error) {
    assert(error instanceof schedule.TaskScheduleConflictError, "calendar conflicts require explicit confirmation");
  }

  const overlappingBlock = await schedule.scheduleStoredTask(created.id, schedule.parseTaskScheduleInput({
    calendarId: "local:personal",
    start: "2026-07-22T08:30:00.000Z",
    end: "2026-07-22T09:15:00.000Z",
    timeZone: "Europe/Berlin",
    allowConflicts: true,
  }));
  assert(overlappingBlock.task.scheduledBlockCount === 2, "confirmed conflict can still be scheduled");
  const movedBlock = await schedule.updateStoredTaskSchedule(created.id, firstBlock.event.id, schedule.parseTaskScheduleInput({
    calendarId: "local:personal",
    start: "2026-07-22T10:00:00.000Z",
    end: "2026-07-22T11:00:00.000Z",
    timeZone: "Europe/Berlin",
  }));
  assert(movedBlock.event.start.startsWith("2026-07-22T10:00"), "scheduled block can be moved");
  const afterBlockDelete = await schedule.deleteStoredTaskSchedule(created.id, firstBlock.event.id);
  assert(afterBlockDelete.scheduledBlockCount === 1, "scheduled block can be deleted without deleting the task");
  await calendarRepository.deleteStoredCalendarEvent("local:personal", overlappingBlock.event.id);
  assert((await repository.getStoredTask(created.id))?.scheduledBlockCount === 0, "deleting time blocks keeps the task");

  try {
    parseTaskInput({ title: "", estimatedMinutes: 2 });
    throw new Error("invalid task unexpectedly accepted");
  } catch (error) {
    assert(error instanceof TaskValidationError, "invalid task is rejected by validation");
  }

  const tasks = await repository.listStoredTasks(true);
  assert(tasks[0] && await repository.deleteStoredTask(tasks[0].id), "task can be deleted");
  assert((await repository.listStoredTasks(true)).length === 0, "deleted task is removed");
  assert(await repository.deleteStoredTask(planItem.id), "hidden legacy plan-item mirror can be cleaned up explicitly");
  assert(await noteRepository.deleteStoredProject(project.id), "an empty project can be deleted after its tasks are removed");
  console.log("Task repository tests passed");
  await database.close();
  await rm(testRoot, { recursive: true, force: true });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
