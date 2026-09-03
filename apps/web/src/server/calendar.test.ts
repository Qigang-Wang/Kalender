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
  const { deleteStoredCalendarEvent, listStoredCalendarEventConflicts } = await import("./calendar-repository");
  const { parseCalendarEventInput, parseCalendarRange, CalendarValidationError } = await import("./calendar-validation");
  const { expandCalendarRecurrenceStarts } = await import("../lib/calendar-recurrence");
  const { encodeNoteContent, noteContentToPlainText } = await import("../lib/note-content");
  const database = await getDatabase();

  try {
    const calendars = await localCalendarProvider.listCalendars(localCalendarContext);
    assert(calendars.length === 1, "default local calendar is created");
    assert(calendars[0]?.primary && !calendars[0].readOnly, "default calendar is primary and writable");
    const calendarId = calendars[0]!.id;
    const richDescription = encodeNoteContent([
      { type: "p", children: [{ text: "会议议程", bold: true }] },
      { type: "p", indent: 1, listStyleType: "todo", checked: false, children: [{ text: "准备材料" }] },
    ]);

    const created = await localCalendarProvider.upsertEvent(localCalendarContext, {
      calendarId,
      title: "Calendar integration test",
      description: "会议议程\n准备材料",
      descriptionContent: richDescription,
      start: "2026-07-20T07:00:00.000Z",
      end: "2026-07-20T08:00:00.000Z",
      timeZone: "Europe/Berlin",
      allDay: false,
      reminderMinutesBefore: 15,
      attendees: [],
      availability: "working_elsewhere",
      idempotencyKey: "calendar-test-create",
    });
    assert(created.calendarId === calendarId, "created event retains calendar identity");
    assert(created.reminderMinutesBefore === 15, "event reminder lead time is persisted");
    assert(created.availability === "working_elsewhere", "event availability is persisted on local insert");
    assert(
      created.descriptionContent && noteContentToPlainText(created.descriptionContent) === "会议议程\n准备材料",
      "calendar rich description is persisted as structured content",
    );

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
      reminderMinutesBefore: 30,
      availability: "free",
    });
    assert(updated.title === "Updated calendar event", "event can be edited");
    assert(updated.reminderMinutesBefore === 30, "event reminder can be changed independently");
    assert(updated.availability === "free", "event availability is persisted on local update");

    const recurring = await localCalendarProvider.upsertEvent(localCalendarContext, {
      calendarId,
      title: "Recurring review",
      start: "2026-07-20T09:00:00.000Z",
      end: "2026-07-20T10:00:00.000Z",
      timeZone: "Europe/Berlin",
      recurrence: { frequency: "weekly", interval: 1, weekDays: [1, 3], end: "count", count: 4 },
    });
    assert(recurring.recurrenceSeriesId && recurring.recurrenceId, "recurring event returns series occurrence metadata");
    const recurringPage = await localCalendarProvider.listEvents(localCalendarContext, {
      from: "2026-07-20T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    });
    const recurringOccurrences = recurringPage.items.filter((event) => event.recurrenceSeriesId === recurring.recurrenceSeriesId);
    assert(recurringOccurrences.length === 4, "recurring series expands into the requested range");
    assert(recurringOccurrences.every((event) => event.recurrence), "expanded occurrences include their recurrence rule");

    const secondOccurrence = recurringOccurrences[1]!;
    const movedOccurrence = await localCalendarProvider.upsertEvent(localCalendarContext, {
      id: secondOccurrence.id,
      calendarId,
      title: "Moved recurring review",
      start: "2026-07-23T09:30:00.000Z",
      end: "2026-07-23T10:30:00.000Z",
      timeZone: "Europe/Berlin",
      recurrenceSeriesId: secondOccurrence.recurrenceSeriesId,
      recurrenceId: secondOccurrence.recurrenceId,
      recurrenceScope: "occurrence",
      availability: "oof",
    });
    assert(
      movedOccurrence.recurrenceException && new Date(movedOccurrence.start).toISOString() === "2026-07-23T09:30:00.000Z",
      "one occurrence can be moved independently",
    );
    assert(movedOccurrence.availability === "oof", "recurrence occurrence preserves an explicit availability");

    const thirdOccurrence = recurringOccurrences[2]!;
    await deleteStoredCalendarEvent(calendarId, thirdOccurrence.id, {
      recurrenceSeriesId: thirdOccurrence.recurrenceSeriesId,
      recurrenceId: thirdOccurrence.recurrenceId,
      recurrenceScope: "occurrence",
    });
    const afterExceptionChanges = await localCalendarProvider.listEvents(localCalendarContext, {
      from: "2026-07-20T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    });
    const changedSeries = afterExceptionChanges.items.filter((event) => event.recurrenceSeriesId === recurring.recurrenceSeriesId);
    assert(changedSeries.length === 3, "a deleted occurrence is omitted without deleting the series");
    assert(changedSeries.some((event) => event.title === "Moved recurring review"), "a moved exception remains visible after reloading");

    const dstStarts = expandCalendarRecurrenceStarts({
      start: "2026-10-19T07:00:00.000Z",
      timeZone: "Europe/Berlin",
      allDay: false,
      recurrence: { frequency: "weekly", interval: 1, weekDays: [1], end: "count", count: 3 },
      from: "2026-10-19T00:00:00.000Z",
      to: "2026-11-10T00:00:00.000Z",
    });
    assert(
      new Date(dstStarts[0]!).toISOString() === "2026-10-19T07:00:00.000Z"
        && new Date(dstStarts[1]!).toISOString() === "2026-10-26T08:00:00.000Z",
      "weekly recurrence preserves local wall time across daylight saving changes",
    );

    const validated = parseCalendarEventInput({
      calendarId,
      title: "Validated event",
      descriptionContent: richDescription,
      start: "2026-10-25T08:00:00+01:00",
      end: "2026-10-25T09:00:00+01:00",
      timeZone: "Europe/Berlin",
    });
    assert(validated.timeZone === "Europe/Berlin", "IANA time zone is preserved");
    assert(validated.description === "会议议程\n准备材料", "rich description produces a searchable plain-text projection");
    assert(parseCalendarEventInput({
      calendarId,
      title: "Silent event",
      start: "2026-10-25T08:00:00+01:00",
      end: "2026-10-25T09:00:00+01:00",
      reminderMinutesBefore: 0,
    }).reminderMinutesBefore === 0, "zero explicitly disables reminders");
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

    let invalidReminderRejected = false;
    try {
      parseCalendarEventInput({
        calendarId,
        title: "Invalid reminder",
        start: "2026-07-20T09:00:00Z",
        end: "2026-07-20T10:00:00Z",
        reminderMinutesBefore: 10,
      });
    } catch (error) {
      invalidReminderRejected = error instanceof CalendarValidationError;
    }
    assert(invalidReminderRejected, "unsupported reminder lead times are rejected");

    await localCalendarProvider.deleteEvent(localCalendarContext, calendarId, created.id);
    await deleteStoredCalendarEvent(calendarId, recurring.id, {
      recurrenceSeriesId: recurring.recurrenceSeriesId,
      recurrenceId: recurring.recurrenceId,
      recurrenceScope: "series",
    });
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
