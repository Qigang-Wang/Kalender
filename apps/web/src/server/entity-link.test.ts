import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-entity-link-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const notes = await import("./note-repository");
  const tasks = await import("./task-repository");
  const links = await import("./entity-link-repository");
  const { getDatabase } = await import("./database");
  const database = await getDatabase();

  try {
    const project = await notes.saveStoredProject({
      name: "Entity links",
      color: "#86bdf5",
      status: "active",
    });
    const note = await notes.saveStoredNote({
      title: "Meeting notes",
      content: "Decisions and next steps",
      noteType: "meeting",
      pinned: false,
    });
    const task = await tasks.saveStoredTask({
      title: "Prepare follow-up",
      status: "next",
      important: true,
      urgencyMode: "auto",
      sourceReferences: [{ kind: "note", sourceId: note.id, label: note.title, href: `/notes?note=${note.id}` }],
    });

    const migratedRelation = await links.listRelatedEntities("note", note.id);
    assert(migratedRelation[0]?.entityId === task.id, "task source references create a generic entity link");
    assert(migratedRelation[0]?.relation === "derived-task", "derived task relation is preserved");
    assert(migratedRelation[0]?.href === `/tasks?task=${encodeURIComponent(task.id)}`, "related tasks expose a navigable href");

    const projectLink = await links.saveEntityLink({
      sourceKind: "note",
      sourceId: note.id,
      targetKind: "project",
      targetId: project.id,
      relation: "related",
    });
    const duplicate = await links.saveEntityLink({
      sourceKind: "project",
      sourceId: project.id,
      targetKind: "note",
      targetId: note.id,
      relation: "related",
    });
    assert(projectLink.id === duplicate.id, "reverse duplicate links are idempotent");
    assert((await links.listRelatedEntities("project", project.id))[0]?.title === note.title, "links resolve related entity details in either direction");

    try {
      await links.saveEntityLink({ sourceKind: "note", sourceId: note.id, targetKind: "note", targetId: note.id, relation: "related" });
      throw new Error("self link unexpectedly accepted");
    } catch (error) {
      assert(error instanceof links.EntityLinkRepositoryError && error.status === 400, "self links are rejected");
    }

    assert(await links.deleteEntityLink(projectLink.id), "a generic link can be removed");
    assert((await links.listRelatedEntities("project", project.id)).length === 0, "removed links disappear from both directions");
    const disposableProject = await notes.saveStoredProject({
      name: "Disposable project link",
      color: "#9ad3bc",
      status: "active",
    });
    await links.saveEntityLink({
      sourceKind: "project",
      sourceId: disposableProject.id,
      targetKind: "note",
      targetId: note.id,
      relation: "related",
    });
    assert(await notes.deleteStoredProject(disposableProject.id), "a project without owned content can be deleted");
    assert(
      !(await links.listRelatedEntities("note", note.id)).some((item) => item.entityId === disposableProject.id),
      "deleting a project removes its remaining generic links",
    );
    assert(await notes.deleteStoredNote(note.id), "linked note can be deleted");
    assert((await links.listRelatedEntities("task", task.id)).length === 0, "deleting an entity removes its generic links");

    console.log("Entity link repository tests passed");
  } finally {
    await database.close();
    globalThis.kalenderDatabase = undefined;
    globalThis.kalenderDatabaseMigrations = undefined;
    await rm(testRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
