import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Assertion failed: ${message}`); }
const key = (label: string) => `mcp-domain-${label}-${randomUUID()}`;

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-mcp-domain-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const auth = await import("./auth");
  const collaboration = await import("./project-collaboration");
  const notes = await import("./note-repository");
  const { getDatabase, closeDatabaseForRestore } = await import("./database");
  const domain = await import("./mcp-domain-service");
  try {
    const database = await getDatabase();
    const admin = await auth.createInitialAdmin({ displayName: "Admin", username: "admin", password: "admin-password" });
    const alice = await auth.createManagedAppUser(admin, { displayName: "Alice", username: "alice", password: "alice-password", role: "user" });
    const bob = await auth.createManagedAppUser(admin, { displayName: "Bob", username: "bob", password: "bob-password", role: "user" });
    const service = new domain.McpDomainService(alice);
    const bobService = new domain.McpDomainService(bob);
    const adminService = new domain.McpDomainService(admin);
    const project = await auth.runWithMcpActor(alice, () => notes.saveStoredProject({ name: "MCP project", color: "#86bdf5", status: "active" }));
    const otherProject = await auth.runWithMcpActor(alice, () => notes.saveStoredProject({ name: "Other MCP project", color: "#f59e0b", status: "active" }));
    const expected = [
      "dayline_search", "dayline_today_get", "dayline_tasks_list", "dayline_task_get", "dayline_task_create", "dayline_task_update", "dayline_projects_list", "dayline_project_get", "dayline_task_schedule", "dayline_notes_search",
      "dayline_project_plan_items_list", "dayline_project_plan_item_get", "dayline_project_plan_item_create", "dayline_project_plan_item_update", "dayline_project_plan_item_delete", "dayline_task_plan_item_link", "dayline_task_plan_item_unlink", "dayline_note_get", "dayline_note_create", "dayline_note_update", "dayline_note_append", "dayline_note_delete", "dayline_calendars_list", "dayline_calendar_events_list", "dayline_calendar_free_slots", "dayline_task_reschedule", "dayline_task_schedule_cancel", "dayline_project_next_actions", "dayline_relations_list", "dayline_relation_link", "dayline_relation_unlink", "dayline_calendar_event_create", "dayline_calendar_event_update", "dayline_calendar_event_delete",
    ];
    assert(domain.mcpDomainOperationNames.join(",") === expected.join(","), "all 34 operations are exposed");

    // REQ-01: project-local dependencies reject self/cycles and reflow automatic successors.
    const first = await service.execute("dayline_project_plan_item_create", { projectId: project.id, title: "Design", plannedStart: "2026-07-20", durationWorkdays: 2, dependencyIds: [], idempotencyKey: key("plan-first") });
    const denied = async (operation: () => Promise<unknown>) => {
      try { await operation(); return false; } catch (error) { return error instanceof auth.AuthError && error.status === 403; }
    };
    assert((await service.execute("dayline_project_plan_items_list", { projectId: project.id })).some((item) => item.id === first.id) && (await service.execute("dayline_project_plan_item_get", { projectId: project.id, planItemId: first.id }))?.id === first.id, "REQ-MCP-SEC-01 owner can list and get plan items");
    assert(await denied(() => adminService.execute("dayline_project_plan_items_list", { projectId: project.id })) && await denied(() => adminService.execute("dayline_project_plan_item_get", { projectId: project.id, planItemId: first.id })) && await denied(() => bobService.execute("dayline_project_plan_items_list", { projectId: project.id })) && await denied(() => bobService.execute("dayline_project_plan_item_get", { projectId: project.id, planItemId: first.id })), "REQ-MCP-SEC-01 admin MCP token and outsider cannot read another user's plan");
    await auth.runWithMcpActor(alice, () => collaboration.saveProjectMembers(project.id, [{ userId: bob.id, accessLevel: "viewer" }]));
    assert((await bobService.execute("dayline_project_plan_items_list", { projectId: project.id })).some((item) => item.id === first.id) && (await bobService.execute("dayline_project_plan_item_get", { projectId: project.id, planItemId: first.id }))?.id === first.id, "REQ-MCP-SEC-01 project member can list and get plan items");
    const second = await service.execute("dayline_project_plan_item_create", { projectId: project.id, title: "Build", dependencyIds: [first.id], durationWorkdays: 1, autoSchedule: true, idempotencyKey: key("plan-second") });
    assert(second.plannedStart === "2026-07-22" && second.phaseId === undefined && second.autoSchedule, "REQ-01 auto scheduling preserves plan fields");
    let cycleRejected = false;
    try { await service.execute("dayline_project_plan_item_update", { projectId: project.id, planItemId: first.id, dependencyIds: [second.id], expectedUpdatedAt: first.updatedAt, idempotencyKey: key("cycle") }); } catch (error) { cycleRejected = error instanceof Error && /循环/.test(error.message); }
    assert(cycleRejected, "REQ-01 cycle is rejected");

    // REQ-02 and REQ-06: only same-project links work, and dependency state blocks next actions.
    const task = await service.execute("dayline_task_create", { title: "Implement feature", projectId: project.id, status: "next", important: true, urgencyMode: "auto", idempotencyKey: key("task") });
    const linked = await service.execute("dayline_task_plan_item_link", { taskId: task.id, projectId: project.id, planItemId: second.id, expectedUpdatedAt: task.updatedAt, idempotencyKey: key("link-plan") });
    assert(linked.planItemId === second.id, "REQ-02 same-project task-plan link succeeds");
    const foreignPlan = await service.execute("dayline_project_plan_item_create", { projectId: otherProject.id, title: "Foreign plan", dependencyIds: [], idempotencyKey: key("foreign-plan") });
    let crossProjectRejected = false;
    try { await service.execute("dayline_task_plan_item_link", { taskId: linked.id, projectId: project.id, planItemId: foreignPlan.id, expectedUpdatedAt: linked.updatedAt, idempotencyKey: key("foreign-link") }); } catch (error) { crossProjectRejected = error instanceof Error && /计划项不属于任务项目/.test(error.message); }
    const afterCrossProjectFailure = await service.execute("dayline_task_get", { taskId: linked.id });
    assert(crossProjectRejected && afterCrossProjectFailure?.projectId === project.id && afterCrossProjectFailure.planItemId === second.id && afterCrossProjectFailure.updatedAt === linked.updatedAt, "REQ-02 cross-project binding preserves task project, plan and revision");
    const actions = await service.execute("dayline_project_next_actions", { projectId: project.id });
    assert(Array.isArray(actions) && actions.some((entry) => entry.taskId === task.id && entry.state === "blocked" && entry.blockedReasons.includes(`dependency_not_done:${first.id}`)), "REQ-06 stable blocked reason is returned");

    // REQ-03: pure text/Markdown is returned, and append keeps prior content.
    const note = await service.execute("dayline_note_create", { projectId: project.id, title: "Research", content: "# Initial", idempotencyKey: key("note") });
    const appended = await service.execute("dayline_note_append", { noteId: note.id, content: "More context", expectedUpdatedAt: note.updatedAt, idempotencyKey: key("append") });
    assert(appended.content === "# Initial\n\nMore context" && !appended.content.includes("plate-json-v1:"), "REQ-03 append returns portable content");

    // REQ-MCP-CALENDAR-01 / REQ-MCP-IDEM-01: ordinary events retain their complete shape and replay before conflict checks.
    const calendars = await service.execute("dayline_calendars_list", {});
    const calendarId = calendars[0]!.id;
    const eventKey = key("event");
    const eventInput = { calendarId, title: "Busy", description: "Initial description", location: "Room 1", start: "2026-07-22T10:00:00.000Z", end: "2026-07-22T11:00:00.000Z", timeZone: "UTC", allDay: false, reminderMinutesBefore: 15 as const, attendees: [{ address: "attendee@example.test", name: "Attendee" }], availability: "busy" as const, idempotencyKey: eventKey };
    const event = await service.execute("dayline_calendar_event_create", eventInput);
    const replayedEvent = await service.execute("dayline_calendar_event_create", eventInput);
    const createdRoundTrip = (await service.execute("dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-07-22T00:00:00.000Z", to: "2026-07-23T00:00:00.000Z" })).find((entry) => entry.id === event.id);
    let eventKeyConflict = false;
    try { await service.execute("dayline_calendar_event_create", { ...eventInput, title: "Changed", idempotencyKey: eventKey }); } catch (error) { eventKeyConflict = (error as { code?: string }).code === "idempotency_conflict"; }
    assert(replayedEvent.id === event.id && eventKeyConflict && createdRoundTrip?.title === eventInput.title && createdRoundTrip?.description === eventInput.description && createdRoundTrip?.location === eventInput.location && Date.parse(createdRoundTrip?.start ?? "") === Date.parse(eventInput.start) && Date.parse(createdRoundTrip?.end ?? "") === Date.parse(eventInput.end) && createdRoundTrip?.timeZone === eventInput.timeZone && createdRoundTrip?.allDay === eventInput.allDay && createdRoundTrip?.reminderMinutesBefore === eventInput.reminderMinutesBefore && createdRoundTrip?.attendees[0]?.address === eventInput.attendees[0]?.address && createdRoundTrip?.availability === eventInput.availability, "REQ-MCP-IDEM-01 same calendar create key replays first result and its complete event shape");
    let calendarConflict: unknown;
    try { await service.execute("dayline_calendar_event_create", { calendarId, title: "Conflict", start: "2026-07-22T10:15:00.000Z", end: "2026-07-22T10:45:00.000Z", idempotencyKey: key("event-conflict") }); } catch (error) { calendarConflict = error; }
    const safeConflict = calendarConflict as { code?: string; status?: number; details?: { conflicts?: Array<Record<string, unknown>> }; conflicts?: Array<Record<string, unknown>> };
    assert(safeConflict.code === "schedule_conflict" && safeConflict.status === 409 && safeConflict.details?.conflicts?.length === 1 && safeConflict.conflicts?.every((entry) => Object.keys(entry).every((key) => ["id", "title", "start", "end"].includes(key))), "REQ-04 calendar conflict has a stable bounded schedule_conflict contract");
    const allowedConflict = await service.execute("dayline_calendar_event_create", { calendarId, title: "Allowed conflict", start: "2026-07-22T10:15:00.000Z", end: "2026-07-22T10:45:00.000Z", allowConflicts: true, idempotencyKey: key("event-allowed") });
    const freeEvent = await service.execute("dayline_calendar_event_create", { calendarId, title: "Free Berlin", start: "2026-07-22T13:00:00.000+02:00", end: "2026-07-22T14:00:00.000+02:00", availability: "free", idempotencyKey: key("event-free") });
    const oofEvent = await service.execute("dayline_calendar_event_create", { calendarId, title: "OOF", start: "2026-07-22T12:00:00.000Z", end: "2026-07-22T13:00:00.000Z", availability: "oof", idempotencyKey: key("event-oof") });
    const tentativeEvent = await service.execute("dayline_calendar_event_create", { calendarId, title: "Tentative", start: "2026-07-22T13:00:00.000Z", end: "2026-07-22T13:30:00.000Z", availability: "tentative", idempotencyKey: key("event-tentative") });
    const workingElsewhereEvent = await service.execute("dayline_calendar_event_create", { calendarId, title: "Working elsewhere", start: "2026-07-22T13:30:00.000Z", end: "2026-07-22T14:00:00.000Z", availability: "working_elsewhere", idempotencyKey: key("event-working-elsewhere") });
    const cancelledEvent = await service.execute("dayline_calendar_event_create", { calendarId, title: "Cancelled", start: "2026-07-22T14:00:00.000Z", end: "2026-07-22T14:30:00.000Z", availability: "busy", idempotencyKey: key("event-cancelled") });
    await database.query("UPDATE calendar_events SET status = 'cancelled' WHERE id = $1", [cancelledEvent.id]);
    const availabilityEvents = await service.execute("dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-07-22T09:00:00.000Z", to: "2026-07-22T15:00:00.000Z" });
    const slots = await service.execute("dayline_calendar_free_slots", { calendarIds: [calendarId], from: "2026-07-22T09:00:00.000Z", to: "2026-07-22T15:00:00.000Z", minimumDurationMinutes: 60, timeZone: "Europe/Berlin" });
    const utcSlots = await service.execute("dayline_calendar_free_slots", { calendarIds: [calendarId], from: "2026-07-22T09:00:00.000Z", to: "2026-07-22T15:00:00.000Z", minimumDurationMinutes: 60, timeZone: "UTC" });
    assert(allowedConflict.id !== event.id && availabilityEvents.some((entry) => entry.id === freeEvent.id && entry.availability === "free") && availabilityEvents.some((entry) => entry.id === oofEvent.id && entry.availability === "oof") && availabilityEvents.some((entry) => entry.id === tentativeEvent.id && entry.availability === "tentative") && availabilityEvents.some((entry) => entry.id === workingElsewhereEvent.id && entry.availability === "working_elsewhere") && availabilityEvents.some((entry) => entry.id === cancelledEvent.id && entry.status === "cancelled") && Array.isArray(slots) && Array.isArray(utcSlots) && slots.length === 3 && slots.every((entry, index) => Date.parse(entry.start) === Date.parse(utcSlots[index]!.start) && Date.parse(entry.end) === Date.parse(utcSlots[index]!.end) && entry.durationMinutes === utcSlots[index]!.durationMinutes) && slots.map((entry) => Date.parse(entry.start)).join(",") === ["2026-07-22T09:00:00.000Z", "2026-07-22T11:00:00.000Z", "2026-07-22T14:00:00.000Z"].map(Date.parse).join(",") && slots[0]!.start.endsWith("+02:00") && utcSlots[0]!.start.endsWith("+00:00"), "REQ-MCP-AVAIL-01 free/cancelled do not block; busy/tentative/oof/working_elsewhere block; UTC and Berlin slots preserve instants and durations");

    // REQ-05: schedule creates, reschedules and cancels its linked block.
    const scheduled = await service.execute("dayline_task_schedule", { taskId: task.id, calendarId, start: "2026-07-23T09:00:00.000Z", end: "2026-07-23T10:00:00.000Z", idempotencyKey: key("schedule") });
    const currentEvent = await service.execute("dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-07-23T00:00:00.000Z", to: "2026-07-24T00:00:00.000Z" });
    const rescheduled = await service.execute("dayline_task_reschedule", { taskId: task.id, eventId: scheduled.event.id, calendarId, start: "2026-07-23T11:00:00.000Z", end: "2026-07-23T12:00:00.000Z", expectedUpdatedAt: currentEvent.find((entry) => entry.id === scheduled.event.id)!.updatedAt!, idempotencyKey: key("reschedule") });
    assert(rescheduled.event.start === "2026-07-23T11:00:00.000Z", "REQ-05 reschedule updates the task block");
    const rescheduledEvent = (await service.execute("dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-07-23T00:00:00.000Z", to: "2026-07-24T00:00:00.000Z" })).find((entry) => entry.id === scheduled.event.id)!;
    await service.execute("dayline_task_schedule_cancel", { taskId: task.id, eventId: scheduled.event.id, expectedUpdatedAt: rescheduledEvent.updatedAt!, idempotencyKey: key("cancel") });
    const readyTask = await service.execute("dayline_task_create", { title: "Ready urgent", projectId: project.id, status: "next", important: true, urgencyMode: "urgent", idempotencyKey: key("ready-task") });
    const inboxTask = await service.execute("dayline_task_create", { title: "Inbox normal", projectId: project.id, status: "inbox", important: false, urgencyMode: "not_urgent", idempotencyKey: key("inbox-task") });
    const waitingTask = await service.execute("dayline_task_create", { title: "Waiting normal", projectId: project.id, status: "waiting", important: false, urgencyMode: "not_urgent", idempotencyKey: key("waiting-task") });
    const somedayTask = await service.execute("dayline_task_create", { title: "Someday normal", projectId: project.id, status: "someday", important: false, urgencyMode: "not_urgent", idempotencyKey: key("someday-task") });
    const doneTask = await service.execute("dayline_task_create", { title: "Done normal", projectId: project.id, status: "done", important: false, urgencyMode: "not_urgent", idempotencyKey: key("done-task") });
    await service.execute("dayline_task_schedule", { taskId: readyTask.id, calendarId, start: "2026-07-23T13:00:00.000Z", end: "2026-07-23T14:00:00.000Z", idempotencyKey: key("ready-schedule") });
    const nextActions = await service.execute("dayline_project_next_actions", { projectId: project.id }) as Array<{ taskId: string; state: string; priority: string; scheduleStatus: string; blockedReasons: string[] }>;
    assert(nextActions.some((entry) => entry.taskId === readyTask.id && entry.state === "ready" && entry.priority === "urgent" && entry.scheduleStatus === "scheduled") && nextActions.some((entry) => entry.taskId === task.id && entry.state === "blocked" && entry.priority === "important" && entry.blockedReasons.includes(`dependency_not_done:${first.id}`)) && [inboxTask, waitingTask, somedayTask].every((task) => nextActions.some((entry) => entry.taskId === task.id && entry.state === "blocked" && entry.priority === "normal" && entry.scheduleStatus === "unscheduled" && entry.blockedReasons.includes(`task_status_${task.status}`))) && !nextActions.some((entry) => entry.taskId === doneTask.id), "REQ-MCP-NEXT-01 next actions cover ready, dependency-blocked, inbox/waiting/someday blockers, done omission, priority and schedule state");

    // REQ-MCP-REL-01: every entity kind participates in reverse relations and cleanup starts from a real link.
    const mailAccountId = randomUUID();
    const mailThreadId = randomUUID();
    const mailId = randomUUID();
    await database.query("INSERT INTO accounts (id, user_id, provider_id, display_name, email_address, color, enabled, sync_mode, sync_status, last_tested_at) VALUES ($1,$2,'test','Test mailbox','mail@example.test','#86bdf5',true,'recommended','idle',now())", [mailAccountId, alice.id]);
    await database.query("INSERT INTO mail_threads (id, account_id, provider_thread_id, subject, last_message_at) VALUES ($1,$2,$3,'Test mail',now())", [mailThreadId, mailAccountId, `thread:${mailThreadId}`]);
    await database.query("INSERT INTO mail_messages (id, account_id, thread_id, provider_message_id, provider_uid, provider_folder_id, subject, from_address, sent_at, received_at) VALUES ($1,$2,$3,$4,1,$5,'Test mail',$6::jsonb,now(),now())", [mailId, mailAccountId, mailThreadId, `message:${mailId}`, "inbox", JSON.stringify({ address: "sender@example.test" })]);
    const relation = await service.execute("dayline_relation_link", { sourceKind: "note", sourceId: note.id, targetKind: "calendar", targetId: event.id, idempotencyKey: key("relation") }) as { id: string };
    const taskProjectRelation = await service.execute("dayline_relation_link", { sourceKind: "task", sourceId: readyTask.id, targetKind: "project", targetId: project.id, idempotencyKey: key("relation-task-project") }) as { id: string };
    const mailRelation = await service.execute("dayline_relation_link", { sourceKind: "mail", sourceId: mailId, targetKind: "note", targetId: note.id, idempotencyKey: key("relation-mail-note") }) as { id: string };
    const relationList = await service.execute("dayline_relations_list", { kind: "calendar", entityId: event.id }) as Array<{ linkId: string }>;
    const noteRelations = await service.execute("dayline_relations_list", { kind: "note", entityId: note.id }) as Array<{ linkId: string }>;
    assert(Array.isArray(relationList) && relationList.some((entry) => entry.linkId === relation.id) && noteRelations.some((entry) => entry.linkId === mailRelation.id) && taskProjectRelation.id.length > 0, "REQ-MCP-REL-01 mail, calendar, task, note and project relations are resolvable before cleanup");
    const transientRelation = await service.execute("dayline_relation_link", { sourceKind: "task", sourceId: readyTask.id, targetKind: "note", targetId: note.id, idempotencyKey: key("relation-unlink") }) as { id: string };
    await service.execute("dayline_relation_unlink", { linkId: transientRelation.id, idempotencyKey: key("unlink") });
    assert(!(await service.execute("dayline_relations_list", { kind: "note", entityId: note.id }) as Array<{ linkId: string }>).some((entry) => entry.linkId === transientRelation.id), "REQ-MCP-REL-01 unlink removes the selected relation");
    assert((await bobService.execute("dayline_note_get", { noteId: note.id })) === undefined, "REQ-07 actor scope prevents cross-user reads");

    // REQ-08: previews leave tables untouched, don't require a revision, and expose a current snapshot.
    const previewResult = await service.execute("dayline_note_create", { title: "Preview", content: "No write", preview: true, idempotencyKey: key("preview") });
    assert("preview" in previewResult && (await service.execute("dayline_notes_search", { query: "No write" })).length === 0, "REQ-08 preview is side-effect free");
    const eventPreview = await service.execute("dayline_calendar_event_update", { eventId: event.id, calendarId, title: "Preview only", start: event.start, end: event.end, preview: true });
    assert("preview" in eventPreview && (eventPreview as unknown as { currentRevision?: string }).currentRevision === event.updatedAt && (await service.execute("dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-07-22T00:00:00.000Z", to: "2026-07-23T00:00:00.000Z" })).find((entry) => entry.id === event.id)?.title === "Busy", "REQ-08 update preview has no revision requirement and does not write");
    const replayKey = key("replay");
    const replayOne = await service.execute("dayline_note_create", { title: "Replay", content: "once", idempotencyKey: replayKey });
    const replayTwo = await service.execute("dayline_note_create", { title: "Replay", content: "once", idempotencyKey: replayKey });
    assert(replayOne.id === replayTwo.id, "REQ-08 same key returns first result");
    let idempotencyConflict = false;
    try { await service.execute("dayline_note_create", { title: "Replay changed", content: "twice", idempotencyKey: replayKey }); } catch (error) { idempotencyConflict = error instanceof Error && /幂等键/.test(error.message); }
    assert(idempotencyConflict, "REQ-08 changed input conflicts");
    const concurrentNote = await service.execute("dayline_note_create", { title: "Concurrent revision", content: "base", idempotencyKey: key("concurrent-note") });
    const concurrent = await Promise.allSettled([
      service.execute("dayline_note_update", { noteId: concurrentNote.id, title: "Concurrent revision A", content: "first", expectedUpdatedAt: concurrentNote.updatedAt }),
      service.execute("dayline_note_update", { noteId: concurrentNote.id, title: "Concurrent revision B", content: "second", expectedUpdatedAt: concurrentNote.updatedAt }),
    ]);
    const concurrentSuccesses = concurrent.filter((entry) => entry.status === "fulfilled");
    const concurrentConflicts = concurrent.filter((entry) => entry.status === "rejected" && (entry.reason as { code?: string }).code === "VERSION_CONFLICT");
    assert(concurrentSuccesses.length === 1 && concurrentConflicts.length === 1, "REQ-08 concurrent same-revision writes have exactly one success and one version_conflict");
    console.log("REQ-08 concurrency: exactly-one-success/one-version-conflict");

    // REQ-MCP-CALENDAR-01 / REQ-MCP-REL-01: versioned ordinary event update/delete retains fields and cleans its real links.
    const updated = await service.execute("dayline_calendar_event_update", { eventId: event.id, calendarId, title: "Busy updated", description: "Updated description", location: "Room 2", start: event.start, end: event.end, timeZone: "Europe/Berlin", allDay: false, reminderMinutesBefore: 30, attendees: [{ address: "updated@example.test" }], availability: "working_elsewhere", allowConflicts: true, expectedUpdatedAt: event.updatedAt!, idempotencyKey: key("event-update") });
    const updatedRoundTrip = (await service.execute("dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-07-22T00:00:00.000Z", to: "2026-07-23T00:00:00.000Z" })).find((entry) => entry.id === updated.id);
    assert(updatedRoundTrip?.title === updated.title && updatedRoundTrip?.description === updated.description && updatedRoundTrip?.location === updated.location && updatedRoundTrip?.start === updated.start && updatedRoundTrip?.end === updated.end && updatedRoundTrip?.timeZone === updated.timeZone && updatedRoundTrip?.allDay === updated.allDay && updatedRoundTrip?.reminderMinutesBefore === updated.reminderMinutesBefore && updatedRoundTrip?.attendees[0]?.address === updated.attendees[0]?.address && updatedRoundTrip?.availability === updated.availability, "REQ-MCP-CALENDAR-01 ordinary event update survives calendar_events_list round trip for every editable field");
    await service.execute("dayline_calendar_event_delete", { eventId: updated.id, calendarId, expectedUpdatedAt: updated.updatedAt!, idempotencyKey: key("event-delete") });
    assert(!(await service.execute("dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-07-22T00:00:00.000Z", to: "2026-07-23T00:00:00.000Z" })).some((entry) => entry.id === updated.id), "REQ-MCP-CALENDAR-01 ordinary event delete removes it from calendar_events_list");
    const remainingRelations = await service.execute("dayline_relations_list", { kind: "note", entityId: note.id }) as Array<{ entityId: string }>;
    assert(Array.isArray(remainingRelations) && !remainingRelations.some((entry) => entry.entityId === event.id), "REQ-MCP-REL-01 delete cleans pre-existing event relation");
    console.log("REQ-MCP-SEC-01 REQ-MCP-IDEM-01 REQ-MCP-NEXT-01 REQ-MCP-CALENDAR-01 REQ-MCP-AVAIL-01 REQ-MCP-REL-01: MCP domain service tests passed");
    void database;
  } finally { await closeDatabaseForRestore(); await rm(testRoot, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
