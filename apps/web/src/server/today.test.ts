import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-today-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const calendar = await import("./calendar-repository");
  const tasks = await import("./task-repository");
  const today = await import("./today-repository");
  const { getDatabase } = await import("./database");
  const database = await getDatabase();

  try {
    const todayEvent = await calendar.upsertStoredCalendarEvent({
      calendarId: "local:personal",
      title: "Today review",
      start: "2026-07-21T09:00:00.000Z",
      end: "2026-07-21T10:00:00.000Z",
      timeZone: "Europe/Berlin",
    });
    await calendar.upsertStoredCalendarEvent({
      calendarId: "local:personal",
      title: "Tomorrow review",
      start: "2026-07-22T09:00:00.000Z",
      end: "2026-07-22T10:00:00.000Z",
      timeZone: "Europe/Berlin",
    });
    const dueTodayTask = await tasks.saveStoredTask({
      title: "Due today",
      status: "next",
      important: true,
      urgencyMode: "auto",
      dueAt: "2026-07-21T15:00:00.000Z",
    });
    await tasks.saveStoredTask({
      title: "Due later",
      status: "next",
      important: false,
      urgencyMode: "not_urgent",
      dueAt: "2026-07-25T15:00:00.000Z",
    });
    await tasks.saveStoredTask({
      title: "Manual urgent",
      status: "next",
      important: false,
      urgencyMode: "urgent",
    });
    await tasks.saveStoredTask({
      title: "Already completed",
      status: "done",
      important: true,
      urgencyMode: "urgent",
      dueAt: "2026-07-20T15:00:00.000Z",
    });
    await database.query(
      "INSERT INTO task_time_blocks (task_id, calendar_event_id) VALUES ($1, $2)",
      [dueTodayTask.id, todayEvent.id],
    );

    const snapshot = await today.getTodaySnapshot("2026-07-21T00:00:00.000Z", "2026-07-22T00:00:00.000Z");
    assert(snapshot.events.length === 1 && snapshot.events[0]?.title === "Today review", "Today includes only overlapping calendar events");
    assert(snapshot.events[0]?.linkedTask?.id === dueTodayTask.id, "Today includes calendar task links for schedule editing");
    assert(
      snapshot.tasks.length === 2
        && snapshot.tasks[0]?.title === "Due today"
        && snapshot.tasks[1]?.title === "Manual urgent",
      "Today queries due and manually urgent tasks but excludes later or completed work",
    );
    assert(snapshot.tasks[0]?.attention === "today", "Today classifies due tasks");
    assert(snapshot.unreadMail.length === 0, "Today handles an empty inbox");

    try {
      today.parseTodayRange(new URL("http://localhost/api/today?from=bad&to=also-bad"));
      throw new Error("invalid range unexpectedly accepted");
    } catch (error) {
      assert(error instanceof today.TodayRangeError, "invalid Today ranges are rejected");
    }

    console.log("Today repository tests passed");
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
