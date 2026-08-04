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
  const editorAssets = await import("./editor-asset-service");
  const projectValidation = await import("./project-validation");
  const entityLinks = await import("./entity-link-repository");
  const {
    parseNoteInput,
    parseProjectAreaRenameInput,
    parseProjectInput,
    NoteValidationError,
  } = await import("./note-validation");
  const { getDatabase } = await import("./database");
  const database = await getDatabase();

  const assetUserId = randomUUID();
  await database.query(
    `INSERT INTO app_users (id, display_name, email, password_hash, role)
     VALUES ($1, 'Asset Test', $2, 'test-hash', 'user')`,
    [assetUserId, `asset-${assetUserId}@example.test`],
  );
  const sourceImage = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const savedAsset = await editorAssets.saveEditorAsset(
    new File([sourceImage], "clipboard.png", { type: "image/png" }),
    assetUserId,
  );
  const loadedAsset = await editorAssets.getEditorAsset(savedAsset.id, assetUserId);
  assert(loadedAsset?.filename === "clipboard.png", "editor assets preserve their filename");
  assert(Buffer.from(loadedAsset?.content ?? []).equals(Buffer.from(sourceImage)), "editor asset bytes survive persistence");
  assert(!await editorAssets.getEditorAsset(savedAsset.id, randomUUID()), "editor assets are isolated by user");
  assert(editorAssets.editorAssetDisposition("image/png") === "inline", "safe image assets render inline");
  assert(editorAssets.editorAssetDisposition("text/html") === "attachment", "untrusted assets download as attachments");
  try {
    await editorAssets.saveEditorAsset(
      new File(["<svg/>"], "unsafe.svg", { type: "image/svg+xml" }),
      assetUserId,
    );
    throw new Error("SVG editor asset unexpectedly accepted");
  } catch (error) {
    assert(error instanceof editorAssets.EditorAssetError, "unsafe SVG editor assets are rejected");
  }

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
  const secondProject = await notes.saveStoredProject(parseProjectInput({
    name: "Calendar Integration",
    areaName: "Work",
    color: "#70c9c3",
  }));
  const renameResult = await notes.renameStoredProjectArea("Work", "Professional");
  assert(renameResult.projectsUpdated === 2, "renaming an area updates every project in the group");
  assert(
    (await notes.getStoredProject(project.id))?.areaName === "Professional"
      && (await notes.getStoredProject(secondProject.id))?.areaName === "Professional",
    "renamed projects expose the new area",
  );
  assert((await tasks.getStoredTask(task.id))?.areaName === "Professional", "renaming an area updates linked task metadata");
  const existingAreaProject = await notes.saveStoredProject(parseProjectInput({
    name: "Existing Area Project",
    areaName: "Existing Area",
    color: "#f0a05e",
  }));
  try {
    await notes.renameStoredProjectArea("Professional", "Existing Area");
    throw new Error("area rename unexpectedly merged with an existing area");
  } catch (error) {
    assert(
      error instanceof notes.NoteRepositoryError && error.code === "PROJECT_AREA_EXISTS",
      "renaming an area rejects an existing destination",
    );
  }
  assert(
    parseProjectAreaRenameInput({ previousName: "Professional", name: "Research" }).name === "Research",
    "area rename input is normalized",
  );
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
  assert(await notes.deleteStoredProject(secondProject.id), "second renamed project can be deleted");
  assert(await notes.deleteStoredProject(existingAreaProject.id), "destination area test project can be deleted");

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
