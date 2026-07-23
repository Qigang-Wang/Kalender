import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-search-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const notes = await import("./note-repository");
  const tasks = await import("./task-repository");
  const calendar = await import("./calendar-repository");
  const { searchWorkspace } = await import("./workspace-search");
  const { getDatabase } = await import("./database");
  const database = await getDatabase();

  try {
    await notes.saveStoredNote({ title: "Kalender architecture", content: "Global search design", noteType: "project", pinned: false });
    await tasks.saveStoredTask({ title: "Implement global search", status: "next", important: true, urgencyMode: "auto" });
    await calendar.upsertStoredCalendarEvent({ calendarId: "local:personal", title: "Search review", start: "2026-07-22T10:00:00.000Z", end: "2026-07-22T11:00:00.000Z", timeZone: "Europe/Berlin" });

    const results = await searchWorkspace("search");
    assert(results.some((item) => item.kind === "note"), "search includes matching notes");
    assert(results.some((item) => item.kind === "task"), "search includes matching tasks");
    assert(results.some((item) => item.kind === "calendar"), "search includes matching events");
    assert((await searchWorkspace("x")).length === 0, "single-character search stays local and empty");
    console.log("Workspace search tests passed");
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
