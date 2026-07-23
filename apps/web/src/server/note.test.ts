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

  try {
    await notes.deleteStoredProject(project.id);
    throw new Error("non-empty project unexpectedly deleted");
  } catch (error) {
    assert(error instanceof notes.NoteRepositoryError && error.status === 409, "non-empty projects are protected");
  }

  assert(await notes.deleteStoredNote(note.id), "note can be deleted");
  assert(await tasks.getStoredTask(task.id), "deleting a note keeps its task");
  assert((await tasks.getStoredTask(task.id))?.sourceReferences.length === 0, "deleting a note removes the stale source link");
  assert(await notes.deleteStoredProject(project.id), "empty project can be deleted");
  assert(await tasks.deleteStoredTask(task.id), "linked task can be cleaned up");

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
