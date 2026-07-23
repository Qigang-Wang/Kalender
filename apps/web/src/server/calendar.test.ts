import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-calendar-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const { getDatabase } = await import("./database");
  const { localCalendarContext, localCalendarProvider } = await import("./local-calendar-provider");
  const { listStoredCalendarEventConflicts } = await import("./calendar-repository");
  const { parseCalendarEventInput, parseCalendarRange, CalendarValidationError } = await import("./calendar-validation");
  const database = await getDatabase();

  try {
    const calendars = await localCalendarProvider.listCalendars(localCalendarContext);
    assert(calendars.length === 1, "default local calendar is created");
    assert(calendars[0]?.primary && !calendars[0].readOnly, "default calendar is primary and writable");
    const calendarId = calendars[0]!.id;

    const created = await localCalendarProvider.upsertEvent(localCalendarContext, {
      calendarId,
      title: "Calendar integration test",
      start: "2026-07-20T07:00:00.000Z",
      end: "2026-07-20T08:00:00.000Z",
      timeZone: "Europe/Berlin",
      allDay: false,
      attendees: [],
      idempotencyKey: "calendar-test-create",
    });
    assert(created.calendarId === calendarId, "created event retains calendar identity");

    const duplicate = await localCalendarProvider.upsertEvent(localCalendarContext, {
      calendarId,
      title: "Ignored duplicate retry",
      start: "2026-07-20T07:00:00.000Z",
      end: "2026-07-20T08:00:00.000Z",
      idempotencyKey: "calendar-test-create",
    });
    assert(duplicate.id === created.id, "idempotency key prevents duplicate event creation");

    const conflicts = await listStoredCalendarEventConflicts({
      calendarId,
      start: "2026-07-20T07:30:00.000Z",
      end: "2026-07-20T08:30:00.000Z",
    });
    assert(conflicts.length === 1 && conflicts[0]?.id === created.id, "overlapping calendar event is reported as a conflict");
    const excludedConflicts = await listStoredCalendarEventConflicts({
      calendarId,
      start: created.start,
      end: created.end,
      excludeEventId: created.id,
    });
    assert(excludedConflicts.length === 0, "event edit excludes itself from conflict detection");

    const page = await localCalendarProvider.listEvents(localCalendarContext, {
      from: "2026-07-20T00:00:00.000Z",
      to: "2026-07-21T00:00:00.000Z",
    });
    assert(page.items.length === 1, "event is returned for an overlapping time range");

    const updated = await localCalendarProvider.upsertEvent(localCalendarContext, {
      id: created.id,
      calendarId,
      title: "Updated calendar event",
      start: created.start,
      end: created.end,
      timeZone: "Europe/Berlin",
    });
    assert(updated.title === "Updated calendar event", "event can be edited");

    const validated = parseCalendarEventInput({
      calendarId,
      title: "Validated event",
      start: "2026-10-25T08:00:00+01:00",
      end: "2026-10-25T09:00:00+01:00",
      timeZone: "Europe/Berlin",
    });
    assert(validated.timeZone === "Europe/Berlin", "IANA time zone is preserved");
    const range = parseCalendarRange(new URL("http://localhost/api?from=2026-07-20T00:00:00Z&to=2026-07-27T00:00:00Z"));
    assert(range.from.startsWith("2026-07-20"), "calendar range is normalized");

    let invalidRejected = false;
    try {
      parseCalendarEventInput({
        calendarId,
        title: "Invalid",
        start: "2026-07-20T10:00:00Z",
        end: "2026-07-20T09:00:00Z",
      });
    } catch (error) {
      invalidRejected = error instanceof CalendarValidationError;
    }
    assert(invalidRejected, "end before start is rejected");

    await localCalendarProvider.deleteEvent(localCalendarContext, calendarId, created.id);
    const empty = await localCalendarProvider.listEvents(localCalendarContext, {
      from: "2026-07-20T00:00:00.000Z",
      to: "2026-07-21T00:00:00.000Z",
    });
    assert(empty.items.length === 0, "event can be deleted");

    console.log("Local calendar provider tests passed");
    await database.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
