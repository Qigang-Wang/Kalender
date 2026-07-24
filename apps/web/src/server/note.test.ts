import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-note-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const notes = await import("./note-repository");
  const tasks = await import("./task-repository");
  const projectRepository = await import("./project-repository");
  const projectValidation = await import("./project-validation");
  const entityLinks = await import("./entity-link-repository");
  const { parseNoteInput, parseProjectInput, NoteValidationError } = await import("./note-validation");
  const { getDatabase } = await import("./database");
  const database = await getDatabase();

  const project = await notes.saveStoredProject(parseProjectInput({
    name: " Kalender Development ",
    description: "Personal workspace",
    areaName: "Work",
    color: "#86bdf5",
  }));
  assert(project.name === "Kalender Development", "project name is normalized");
  assert(project.noteCount === 0, "new project starts empty");

  try {
    await notes.saveStoredProject(parseProjectInput({ name: "kalender development" }));
    throw new Error("duplicate project unexpectedly accepted");
  } catch (error) {
    assert(error instanceof notes.NoteRepositoryError && error.status === 409, "project names are case-insensitively unique");
  }

  const note = await notes.saveStoredNote(parseNoteInput({
    projectId: project.id,
    title: " Notes architecture ",
    content: "Projects connect notes and tasks.",
    noteType: "project",
    pinned: true,
  }));
  assert(note.title === "Notes architecture", "note title is normalized");
  assert(note.projectName === project.name && note.pinned, "project and pin state are stored");
  assert((await notes.listStoredProjects())[0]?.noteCount === 1, "project note count is updated");
  assert(
    (await entityLinks.listRelatedEntities("note", note.id)).some((item) => item.entityId === project.id && item.relation === "project-item"),
    "project notes are mirrored into EntityLink",
  );

  const updated = await notes.saveStoredNote({
    id: note.id,
    projectId: project.id,
    title: note.title,
    content: `${note.content}\nAutosave is enabled.`,
    noteType: "project",
    pinned: false,
  });
  assert(updated.content.includes("Autosave") && !updated.pinned, "note edits and pin changes are stored");

  const task = await tasks.saveStoredTask({
    title: "Implement Notes editor",
    status: "inbox",
    important: false,
    urgencyMode: "auto",
    projectName: project.name,
    sourceReferences: [{ kind: "note", sourceId: note.id, label: note.title, href: `/notes?note=${encodeURIComponent(note.id)}` }],
  });
  const linked = await notes.getStoredNote(note.id);
  assert(linked?.linkedTasks[0]?.id === task.id, "note exposes its linked task");
  assert(linked.linkedTasks[0]?.href === `/tasks?task=${encodeURIComponent(task.id)}`, "note links back to task detail");
  const milestone = await projectRepository.saveStoredProjectMilestone(projectValidation.parseProjectMilestoneInput({
    title: " First integrated project view ",
    dueOn: "2026-08-15",
    status: "active",
  }, project.id));
  assert(milestone.title === "First integrated project view", "project milestone input is normalized");
  const overview = await projectRepository.getStoredProjectOverview(project.id);
  assert(overview?.project.id === project.id, "project overview returns the selected project");
  assert(
    overview.stats.openTaskCount === 1
      && overview.stats.completedTaskCount === 0
      && overview.stats.noteCount === 1,
    "project overview aggregates task progress and notes",
  );
  assert(
    overview.tasks[0]?.id === task.id && overview.notes[0]?.id === note.id,
    "project overview exposes linked tasks and notes",
  );
  assert(
    overview.milestones[0]?.id === milestone.id && overview.milestones[0]?.dueOn === "2026-08-15",
    "project overview includes its milestone timeline",
  );
  assert(
    overview.review.unscheduledOpenTaskCount === 1 && overview.review.completedLast7DaysCount === 0,
    "project overview builds a weekly review from task activity",
  );
  assert(
    (await entityLinks.listRelatedEntities("task", task.id)).some((item) => item.entityId === project.id && item.relation === "project-item"),
    "project tasks are mirrored into EntityLink",
  );

  const dependentTask = await tasks.saveStoredTask({
    title: "Validate project Gantt",
    status: "next",
    important: false,
    urgencyMode: "auto",
    projectId: project.id,
  });
  await projectRepository.saveStoredProjectTaskPlan(projectValidation.parseProjectTaskPlanInput({
    plannedStart: "2026-07-27",
    plannedEnd: "2026-07-31",
    dependencyIds: [],
  }, project.id, task.id));
  await projectRepository.saveStoredProjectTaskPlan(projectValidation.parseProjectTaskPlanInput({
    plannedStart: "2026-08-03",
    plannedEnd: "2026-08-07",
    dependencyIds: [task.id],
  }, project.id, dependentTask.id));
  const ganttOverview = await projectRepository.getStoredProjectOverview(project.id);
  const plannedDependent = ganttOverview?.ganttTasks.find((entry) => entry.id === dependentTask.id);
  assert(
    plannedDependent?.plannedStart === "2026-08-03"
      && plannedDependent.plannedEnd === "2026-08-07"
      && plannedDependent.dependencyIds[0] === task.id,
    "project Gantt stores task ranges and predecessor relationships",
  );
  try {
    await projectRepository.saveStoredProjectTaskPlan(projectValidation.parseProjectTaskPlanInput({
      plannedStart: "2026-07-27",
      plannedEnd: "2026-07-31",
      dependencyIds: [dependentTask.id],
    }, project.id, task.id));
    throw new Error("cyclic task dependency unexpectedly accepted");
  } catch (error) {
    assert(
      error instanceof projectRepository.ProjectRepositoryError && error.code === "TASK_DEPENDENCY_CYCLE",
      "project Gantt rejects circular dependencies",
    );
  }

  try {
    await notes.deleteStoredProject(project.id);
    throw new Error("non-empty project unexpectedly deleted");
  } catch (error) {
    assert(error instanceof notes.NoteRepositoryError && error.status === 409, "non-empty projects are protected");
  }

  assert(await notes.deleteStoredNote(note.id), "note can be deleted");
  assert(await tasks.getStoredTask(task.id), "deleting a note keeps its task");
  assert((await tasks.getStoredTask(task.id))?.sourceReferences.length === 0, "deleting a note removes the stale source link");
  try {
    await notes.deleteStoredProject(project.id);
    throw new Error("project with a linked task unexpectedly deleted");
  } catch (error) {
    assert(error instanceof notes.NoteRepositoryError && error.status === 409, "project tasks also protect the project");
  }
  assert(await tasks.deleteStoredTask(dependentTask.id), "dependent project task can be cleaned up");
  assert(await tasks.deleteStoredTask(task.id), "linked task can be cleaned up");
  assert(await projectRepository.deleteStoredProjectMilestone(project.id, milestone.id), "project milestone can be deleted");
  assert(await notes.deleteStoredProject(project.id), "empty project can be deleted");

  try {
    parseNoteInput({ title: "", content: "" });
    throw new Error("invalid note unexpectedly accepted");
  } catch (error) {
    assert(error instanceof NoteValidationError, "empty note title is rejected");
  }

  console.log("Note and project repository tests passed");
  await database.close();
  globalThis.kalenderDatabase = undefined;
  await rm(testRoot, { recursive: true, force: true });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
