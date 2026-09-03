import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { POST } from "../app/mcp/route";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const key = (label: string) => `mcp-protocol-${label}-${randomUUID()}`;

// This oracle intentionally does not import the server registry.  A registry
// typo must fail this test instead of changing both expected and actual data.
const EXPECTED_TOOL_NAMES = [
  "dayline_search",
  "dayline_today_get",
  "dayline_tasks_list",
  "dayline_task_get",
  "dayline_task_create",
  "dayline_task_update",
  "dayline_projects_list",
  "dayline_project_get",
  "dayline_task_schedule",
  "dayline_notes_search",
  "dayline_project_plan_items_list",
  "dayline_project_plan_item_get",
  "dayline_project_plan_item_create",
  "dayline_project_plan_item_update",
  "dayline_project_plan_item_delete",
  "dayline_task_plan_item_link",
  "dayline_task_plan_item_unlink",
  "dayline_note_get",
  "dayline_note_create",
  "dayline_note_update",
  "dayline_note_append",
  "dayline_note_delete",
  "dayline_calendars_list",
  "dayline_calendar_events_list",
  "dayline_calendar_free_slots",
  "dayline_task_reschedule",
  "dayline_task_schedule_cancel",
  "dayline_project_next_actions",
  "dayline_relations_list",
  "dayline_relation_link",
  "dayline_relation_unlink",
  "dayline_calendar_event_create",
  "dayline_calendar_event_update",
  "dayline_calendar_event_delete",
] as const;

const EXPECTED_READ_TOOL_NAMES = [
  "dayline_search",
  "dayline_today_get",
  "dayline_tasks_list",
  "dayline_task_get",
  "dayline_projects_list",
  "dayline_project_get",
  "dayline_notes_search",
  "dayline_project_plan_items_list",
  "dayline_project_plan_item_get",
  "dayline_note_get",
  "dayline_calendars_list",
  "dayline_calendar_events_list",
  "dayline_calendar_free_slots",
  "dayline_project_next_actions",
  "dayline_relations_list",
] as const;

const EXPECTED_WRITE_TOOL_NAMES = [
  "dayline_task_create",
  "dayline_task_update",
  "dayline_task_schedule",
  "dayline_project_plan_item_create",
  "dayline_project_plan_item_update",
  "dayline_task_plan_item_link",
  "dayline_task_plan_item_unlink",
  "dayline_note_create",
  "dayline_note_update",
  "dayline_note_append",
  "dayline_task_reschedule",
  "dayline_relation_link",
  "dayline_calendar_event_create",
  "dayline_calendar_event_update",
] as const;

const EXPECTED_DESTRUCTIVE_TOOL_NAMES = [
  "dayline_project_plan_item_delete",
  "dayline_note_delete",
  "dayline_task_schedule_cancel",
  "dayline_relation_unlink",
  "dayline_calendar_event_delete",
] as const;

const LEGACY_TOOL_NAMES = [
  ...["get", "create", "update", "delete"].map((verb) => `dayline_project_plan_items_${verb}`),
  ...["link", "unlink"].map((verb) => `dayline_relations_${verb}`),
];

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-mcp-protocol-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const auth = await import("./auth");
  const tokens = await import("./mcp-token-repository");
  const notes = await import("./note-repository");
  const calendars = await import("./calendar-repository");
  const { closeDatabaseForRestore, getDatabase } = await import("./database");
  try {
    const admin = await auth.createInitialAdmin({ displayName: "MCP Admin", username: "mcp-protocol-admin", password: "mcp-protocol-password" });
    const writer = await auth.createManagedAppUser(admin, { displayName: "MCP Writer", username: "mcp-protocol-writer", password: "mcp-protocol-password", role: "user" });
    const viewer = await auth.createManagedAppUser(admin, { displayName: "MCP Viewer", username: "mcp-protocol-viewer", password: "mcp-protocol-password", role: "viewer" });
    const outsider = await auth.createManagedAppUser(admin, { displayName: "MCP Outsider", username: "mcp-protocol-outsider", password: "mcp-protocol-password", role: "user" });
    const adminToken = await tokens.createMcpToken(admin);
    const writerToken = await tokens.createMcpToken(writer, { scopes: ["dayline:read", "dayline:write"] });
    const readToken = await tokens.createMcpToken(writer);
    const viewerToken = await tokens.createMcpToken(viewer);
    const outsiderToken = await tokens.createMcpToken(outsider);
    const database = await getDatabase();

    const rejectedHost = await raw(undefined, initialize(), { host: "attacker.example" });
    const rejectedOrigin = await raw(undefined, initialize(), { origin: "https://attacker.example" });
    assert(rejectedHost.response.status === 403 && rejectedOrigin.response.status === 403, "MCP rejects unlisted Host and Origin before authentication");
    process.env.KALENDER_MCP_ALLOWED_HOSTS = "dayline.example.com";
    process.env.KALENDER_MCP_ALLOWED_ORIGINS = "https://client.example.com";
    const allowedTarget = await raw(writerToken.secret, initialize(), { host: "dayline.example.com:443", origin: "https://client.example.com" });
    assert(allowedTarget.response.status === 200, "MCP accepts configured Host and Origin values");
    delete process.env.KALENDER_MCP_ALLOWED_HOSTS;
    delete process.env.KALENDER_MCP_ALLOWED_ORIGINS;

    const cookieOnly = await raw(undefined, initialize(), { cookie: "qgw_session=browser-session" });
    assert(cookieOnly.response.status === 401 && cookieOnly.response.headers.has("www-authenticate"), "cookie-only MCP access is rejected as Bearer-only");
    const missing = await raw(undefined, initialize());
    assert(missing.response.status === 401, "missing Authorization is rejected");
    process.env.KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE = "1";
    const forgedForwarded = await raw("dln_forged_forwarded", initialize(), { "x-forwarded-for": "198.51.100.40", "x-real-ip": "203.0.113.40" });
    const rotatedForwarded = await raw("dln_rotated_forwarded", initialize(), { "x-forwarded-for": "198.51.100.41", "x-real-ip": "203.0.113.41" });
    assert(forgedForwarded.response.status === 401 && rotatedForwarded.response.status === 429, "untrusted forwarding headers share the stable unknown invalid-token bucket");
    const anonymousBucket = await database.query<{ request_count: number }>("SELECT request_count FROM mcp_invalid_token_ip_buckets WHERE ip_address = 'unknown'");
    assert(anonymousBucket.rows[0]?.request_count === 1, "default invalid-token bucket is not bypassable by forged client IP headers");
    delete process.env.KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE;
    process.env.KALENDER_MCP_TRUST_PROXY_IP_HEADERS = "true";
    process.env.KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE = "2";
    const trustedIp = await raw("dln_trusted_ip", initialize(), { "x-real-ip": "203.0.113.80", "x-forwarded-for": "forged, 198.51.100.80" });
    const trustedForwarded = await raw("dln_trusted_forwarded", initialize(), { "x-forwarded-for": "forged-left-value, 203.0.113.81" });
    const malformedTrustedIp = await raw("dln_malformed_ip", initialize(), { "x-real-ip": "not-an-ip", "x-forwarded-for": "198.51.100.81" });
    assert(trustedIp.response.status === 401 && trustedForwarded.response.status === 401 && malformedTrustedIp.response.status === 401, "trusted mode accepts only syntactically valid proxy-normalized addresses");
    const trustedBucket = await database.query<{ request_count: number }>("SELECT request_count FROM mcp_invalid_token_ip_buckets WHERE ip_address = '203.0.113.80'");
    const forwardedBucket = await database.query<{ request_count: number }>("SELECT request_count FROM mcp_invalid_token_ip_buckets WHERE ip_address = '203.0.113.81'");
    const malformedBucket = await database.query<{ request_count: number }>("SELECT request_count FROM mcp_invalid_token_ip_buckets WHERE ip_address = 'unknown'");
    assert(trustedBucket.rows[0]?.request_count === 1 && forwardedBucket.rows[0]?.request_count === 1 && malformedBucket.rows[0]?.request_count === 2, "trusted mode uses the rightmost forwarded address and rejects malformed real IP values instead of falling back to spoofed input");
    delete process.env.KALENDER_MCP_TRUST_PROXY_IP_HEADERS;
    delete process.env.KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE;
    const invalid = await raw("dln_not_a_real_token", initialize(), { "x-forwarded-for": "198.51.100.40" });
    assert(invalid.response.status === 401 && !JSON.stringify(invalid.body).includes("dln_not_a_real_token"), "invalid tokens return sanitized 401 responses");

    const initialized = await raw(writerToken.secret, initialize());
    assert(initialized.response.status === 200 && initialized.body.result?.serverInfo?.name === "dayline", `raw initialize succeeds over stateless Streamable HTTP (${initialized.response.status}: ${JSON.stringify(initialized.body)})`);
    const listed = await raw(writerToken.secret, rpc("tools/list", {}));
    const tools = listed.body.result?.tools as Array<{ name: string; annotations?: Record<string, unknown>; inputSchema?: Record<string, unknown> }>;
    const names = tools.map((tool) => tool.name);
    assert(EXPECTED_TOOL_NAMES.length === 34, "the independent MCP oracle contains exactly 34 names");
    assert(names.length === EXPECTED_TOOL_NAMES.length && names.every((name, index) => name === EXPECTED_TOOL_NAMES[index]), "tools/list exposes exactly the frozen 34 MCP tools in registry order");
    assert(EXPECTED_TOOL_NAMES.includes("dayline_project_plan_item_get") && EXPECTED_TOOL_NAMES.includes("dayline_project_plan_item_create") && EXPECTED_TOOL_NAMES.includes("dayline_project_plan_item_update") && EXPECTED_TOOL_NAMES.includes("dayline_project_plan_item_delete") && EXPECTED_TOOL_NAMES.includes("dayline_relation_link") && EXPECTED_TOOL_NAMES.includes("dayline_relation_unlink"), "the frozen oracle contains all singular plan-item and relation mutation names");
    assert(LEGACY_TOOL_NAMES.every((legacyName) => !names.includes(legacyName)), "the six legacy plural mutation names are absent from tools/list");
    assert(EXPECTED_READ_TOOL_NAMES.length === 15 && EXPECTED_WRITE_TOOL_NAMES.length === 14 && EXPECTED_DESTRUCTIVE_TOOL_NAMES.length === 5, "independent read/write/destructive classifications have frozen cardinalities");
    assert(new Set([...EXPECTED_READ_TOOL_NAMES, ...EXPECTED_WRITE_TOOL_NAMES, ...EXPECTED_DESTRUCTIVE_TOOL_NAMES]).size === 34, "independent classifications partition the frozen registry");
    const readTools = tools.filter((tool) => (EXPECTED_READ_TOOL_NAMES as readonly string[]).includes(tool.name));
    const writeTools = tools.filter((tool) => (EXPECTED_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name));
    const destructiveTools = tools.filter((tool) => (EXPECTED_DESTRUCTIVE_TOOL_NAMES as readonly string[]).includes(tool.name));
    assert(readTools.length === EXPECTED_READ_TOOL_NAMES.length && readTools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false && tool.annotations?.idempotentHint === true), "all read tools are annotated read-only, idempotent, and non-destructive");
    assert(writeTools.length === EXPECTED_WRITE_TOOL_NAMES.length && writeTools.every((tool) => tool.annotations?.readOnlyHint === false && tool.annotations?.destructiveHint === false), "all ordinary write tools are annotated as writes");
    assert(destructiveTools.length === EXPECTED_DESTRUCTIVE_TOOL_NAMES.length && destructiveTools.every((tool) => tool.annotations?.readOnlyHint === false && tool.annotations?.destructiveHint === true && tool.annotations?.idempotentHint === true), "all delete/unlink/cancel tools are explicitly destructive and idempotent");
    assert(tools.filter((tool) => (EXPECTED_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name)).filter((tool) => !["dayline_task_create", "dayline_task_schedule", "dayline_project_plan_item_create", "dayline_relation_link", "dayline_note_create", "dayline_calendar_event_create"].includes(tool.name)).every((tool) => tool.annotations?.idempotentHint === false), "ordinary update tools are explicitly non-idempotent");
    assert(tools.every((tool) => tool.annotations?.openWorldHint === false), "all MCP tools disallow open-world access");
    assert(tools.every((tool) => tool.inputSchema?.additionalProperties === false), "all MCP input schemas reject unknown fields");
    for (const name of ["dayline_tasks_list", "dayline_projects_list", "dayline_project_plan_items_list", "dayline_relations_list"]) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      assert(schemaProperties(schema).includes("limit"), `${name} exposes a bounded result limit`);
    }
    const createSchema = tools.find((tool) => tool.name === "dayline_task_create")?.inputSchema;
    const updateSchema = tools.find((tool) => tool.name === "dayline_task_update")?.inputSchema;
    assert(schemaProperties(createSchema).join(",") === ["title", "notes", "status", "important", "urgencyMode", "dueAt", "estimatedMinutes", "projectId", "planItemId", "projectName", "areaName", "assigneeUserId", "sourceReferences", "idempotencyKey", "preview"].join(","), "REQ-FIX-04 task create schema exposes every priority and ownership field");
    assert(schemaProperties(updateSchema).join(",") === ["taskId", "title", "notes", "status", "important", "urgencyMode", "dueAt", "estimatedMinutes", "projectId", "planItemId", "projectName", "areaName", "assigneeUserId", "sourceReferences", "idempotencyKey", "expectedUpdatedAt", "preview"].join(","), "REQ-FIX-04 task update schema exposes every partial and revision field");
    assert(requiredFields(createSchema).includes("title") && !requiredFields(updateSchema).includes("title"), "create requires title while update permits partial task fields");
    assert(schemaContainsEnum(createSchema, ["inbox", "next", "waiting", "someday", "done"]) && schemaContainsEnum(createSchema, ["auto", "urgent", "not_urgent"]), "task schemas expose status and urgency enums");
    const planSchema = tools.find((tool) => tool.name === "dayline_project_plan_item_create")?.inputSchema;
    const noteSchema = tools.find((tool) => tool.name === "dayline_note_create")?.inputSchema;
    const freeSlotsSchema = tools.find((tool) => tool.name === "dayline_calendar_free_slots")?.inputSchema;
    const relationSchema = tools.find((tool) => tool.name === "dayline_relation_link")?.inputSchema;
    const eventSchema = tools.find((tool) => tool.name === "dayline_calendar_event_create")?.inputSchema;
    const scheduleSchema = tools.find((tool) => tool.name === "dayline_task_schedule")?.inputSchema;
    assert(schemaProperties(scheduleSchema).join(",") === ["taskId", "calendarId", "start", "end", "timeZone", "allowConflicts", "idempotencyKey", "preview"].join(","), "REQ-FIX-04 task schedule schema exposes the complete conflict-aware field set");
    assert(schemaContainsEnum(planSchema, ["planned", "in_progress", "paused", "done", "cancelled"]), "REQ-FIX-04 plan schema exposes the complete status enum");
    assert(schemaProperties(planSchema).join(",") === ["projectId", "id", "title", "status", "plannedStart", "plannedEnd", "dependencyIds", "phaseId", "durationWorkdays", "autoSchedule", "idempotencyKey", "preview"].join(","), "REQ-FIX-04 plan create schema exposes the complete declared field set");
    assert(schemaProperties(noteSchema).join(",") === ["id", "projectId", "title", "content", "noteType", "pinned", "idempotencyKey", "preview"].join(","), "REQ-FIX-04 note schema exposes the complete portable field set");
    assert(schemaProperties(freeSlotsSchema).join(",") === ["calendarIds", "from", "to", "minimumDurationMinutes", "timeZone"].join(","), "REQ-FIX-04 free-slot schema exposes every bounded field");
    assert(schemaProperties(relationSchema).join(",") === ["sourceKind", "sourceId", "targetKind", "targetId", "relation", "idempotencyKey", "preview"].join(","), "REQ-FIX-04 relation schema exposes the complete field set");
    assert(schemaContainsEnum(relationSchema, ["mail", "calendar", "task", "note", "project"]), "REQ-FIX-04 relation schema exposes the complete entity-kind enum");
    assert(schemaProperties(eventSchema).join(",") === ["calendarId", "title", "description", "location", "start", "end", "timeZone", "allDay", "reminderMinutesBefore", "attendees", "availability", "allowConflicts", "recurrence", "idempotencyKey", "preview"].join(","), "REQ-FIX-04 calendar event create schema exposes every ordinary field including allowConflicts");
    const eventUpdateSchema = tools.find((tool) => tool.name === "dayline_calendar_event_update")?.inputSchema;
    assert(schemaProperties(eventUpdateSchema).join(",") === ["eventId", "calendarId", "title", "description", "location", "start", "end", "timeZone", "allDay", "reminderMinutesBefore", "attendees", "availability", "allowConflicts", "recurrence", "recurrenceSeriesId", "recurrenceId", "recurrenceScope", "idempotencyKey", "expectedUpdatedAt", "preview"].join(","), "REQ-FIX-04 calendar event update schema exposes every ordinary and revision field including allowConflicts");
    assert(schemaProperty(eventSchema, "allowConflicts")?.type === "boolean" && schemaProperty(eventUpdateSchema, "allowConflicts")?.type === "boolean", "REQ-FIX-04 calendar event allowConflicts fields are booleans");
    assert(schemaContainsEnum(eventSchema, ["free", "tentative", "busy", "oof", "working_elsewhere"]), "REQ-FIX-04 calendar event schema exposes availability enum");

    for (const name of ["dayline_task_create", "dayline_task_update", "dayline_task_schedule"] as const) {
      const denied = await call(readToken.secret, name, name === "dayline_task_schedule" ? { taskId: "x", calendarId: "x", start: "2026-07-21T09:00:00.000Z", end: "2026-07-21T10:00:00.000Z" } : name === "dayline_task_update" ? { taskId: "x", title: "x" } : { title: "x" });
      assert(denied.body.result?.isError === true && parseContent(denied.body).error.code === "permission_denied", `read token is denied ${name}`);
    }
    for (const name of [...EXPECTED_WRITE_TOOL_NAMES, ...EXPECTED_DESTRUCTIVE_TOOL_NAMES]) {
      const denied = await call(readToken.secret, name, validWriteArguments(name));
      assert(denied.body.result?.isError === true && parseContent(denied.body).error.code === "permission_denied", `read token is denied ${name}`);
    }
    const forgedViewerWrite = await call(viewerToken.secret, "dayline_task_create", { title: "forged viewer write" });
    assert(forgedViewerWrite.body.result?.isError === true && parseContent(forgedViewerWrite.body).error.code === "permission_denied", "viewer is denied a forged write scope");

    const missingCreateKey = await call(writerToken.secret, "dayline_task_create", { title: "missing key" });
    assert(missingCreateKey.body.result?.isError === true && parseContent(missingCreateKey.body).error.code === "invalid_input", "execution requires a bounded idempotency key");
    const missingRevision = await call(writerToken.secret, "dayline_task_update", { taskId: "missing", title: "missing revision", idempotencyKey: key("missing-revision") });
    assert(missingRevision.body.result?.isError === true && parseContent(missingRevision.body).error.code === "invalid_input", "execution requires expectedUpdatedAt for compare-and-set writes");
    const preview = await call(writerToken.secret, "dayline_note_create", { title: "protocol preview", content: "preview only", preview: true });
    assert(preview.body.result?.isError !== true && parseContent(preview.body).preview === true, "preview does not require or consume an idempotency key");

    const project = await auth.runWithMcpActor(writer, () => notes.saveStoredProject({ name: "MCP project", color: "#86bdf5", status: "active" }));
    const seededNote = await auth.runWithMcpActor(writer, () => notes.saveStoredNote({ projectId: project.id, title: "MCP note", content: "protocol search needle", noteType: "project", pinned: false }));
    await auth.runWithMcpActor(writer, () => calendars.listStoredCalendars());
    const created = parseContent(await call(writerToken.secret, "dayline_task_create", { title: "MCP flow task", projectId: project.id, status: "next", important: true, urgencyMode: "urgent", estimatedMinutes: 45, idempotencyKey: key("task-create") }).then((entry) => entry.body));
    assert(typeof created.id === "string" && created.important === true && created.urgencyMode === "urgent" && created.estimatedMinutes === 45, "REQ-FIX-04 task create returns the complete priority shape");
    const got = parseContent(await call(writerToken.secret, "dayline_task_get", { taskId: created.id }).then((entry) => entry.body));
    assert(got.id === created.id, "task get is bound to the token owner");
    assert((parseContent(await call(writerToken.secret, "dayline_tasks_list", { projectId: project.id }).then((entry) => entry.body)) as Array<{ id: string }>).some((entry) => entry.id === created.id), "tasks list is available");
    const updated = parseContent(await call(writerToken.secret, "dayline_task_update", { taskId: created.id, title: "MCP flow task updated", expectedUpdatedAt: created.updatedAt }).then((entry) => entry.body));
    assert(updated.title === "MCP flow task updated", "task update succeeds for the owner");
    const staleUpdate = await call(writerToken.secret, "dayline_task_update", { taskId: created.id, title: "stale update", expectedUpdatedAt: created.updatedAt });
    assert(staleUpdate.body.result?.isError === true && parseContent(staleUpdate.body).error.code === "version_conflict", "REQ-FIX-05 stale task revision is a version_conflict");
    const missingTask = await call(writerToken.secret, "dayline_task_update", { taskId: "missing-task", title: "missing task", expectedUpdatedAt: updated.updatedAt });
    assert(missingTask.body.result?.isError === true && parseContent(missingTask.body).error.code === "task_not_found", "REQ-FIX-05 missing task uses the task_not_found entity code");
    const scheduled = parseContent(await call(writerToken.secret, "dayline_task_schedule", { taskId: created.id, calendarId: `local:${writer.id}:personal`, start: "2026-07-21T09:00:00.000Z", end: "2026-07-21T10:00:00.000Z", idempotencyKey: key("task-schedule") }).then((entry) => entry.body));
    assert(scheduled.event?.calendarId === `local:${writer.id}:personal`, "task schedule stays in the owner calendar");
    const previewUpdate = parseContent(await call(writerToken.secret, "dayline_task_update", { taskId: created.id, title: "preview update", preview: true }).then((entry) => entry.body));
    assertPreviewShape(previewUpdate, "task update preview");
    assert((previewUpdate.after as { title?: unknown } | null)?.title === "preview update", "REQ-FIX-05 update preview reports before/after without a revision");
    const previewDelete = parseContent(await call(writerToken.secret, "dayline_task_schedule_cancel", { taskId: created.id, eventId: scheduled.event.id, preview: true }).then((entry) => entry.body));
    assertPreviewShape(previewDelete, "task schedule delete preview");
    const stillScheduled = parseContent(await call(writerToken.secret, "dayline_calendar_events_list", { calendarIds: [`local:${writer.id}:personal`], from: "2026-07-21T00:00:00.000Z", to: "2026-07-22T00:00:00.000Z" }).then((entry) => entry.body));
    assert(stillScheduled.some((event: { id: string }) => event.id === scheduled.event.id), "REQ-FIX-05 delete preview has no side effect");
    assert((parseContent(await call(writerToken.secret, "dayline_search", { query: "flow task", kind: "task" }).then((entry) => entry.body)) as Array<unknown>).length > 0, "workspace search is available");
    assert(parseContent(await call(writerToken.secret, "dayline_today_get", { from: "2026-07-21T00:00:00.000Z", to: "2026-07-22T00:00:00.000Z" }).then((entry) => entry.body)).from === "2026-07-21T00:00:00.000Z", "Today is available");
    assert((parseContent(await call(writerToken.secret, "dayline_projects_list", {}).then((entry) => entry.body)) as Array<{ id: string }>).some((entry) => entry.id === project.id), "projects are available");
    const projectOverview = parseContent(await call(writerToken.secret, "dayline_project_get", { projectId: project.id }).then((entry) => entry.body));
    assert(projectOverview.project?.id === project.id && Array.isArray(projectOverview.planItems) && Array.isArray(projectOverview.tasks) && projectOverview.tasks.some((entry: { id: string }) => entry.id === created.id), "project get returns project, planItems, and tasks overview data");
    assert((parseContent(await call(writerToken.secret, "dayline_notes_search", { query: "needle" }).then((entry) => entry.body)) as Array<{ title: string }>).some((entry) => entry.title === "MCP note"), "notes search is available");
    const nextActions = parseContent(await call(writerToken.secret, "dayline_project_next_actions", { projectId: project.id }).then((entry) => entry.body));
    const nextAction = nextActions.find((entry: { taskId: string }) => entry.taskId === created.id);
    assert(nextAction?.state === "ready" && nextAction.priority === "urgent" && nextAction.scheduleStatus === "scheduled" && nextAction.title === "MCP flow task updated" && nextAction.estimatedMinutes === 45 && Array.isArray(nextAction.scheduledBlocks) && Array.isArray(nextAction.blockedReasons), "REQ-MCP-NEXT-01 ready next-actions expose the priority and schedule state");
    assert(nextAction.scheduledBlocks.some((block: { eventId: string }) => block.eventId === scheduled.event.id) && nextAction.scheduledBlocks.every((block: Record<string, unknown>) => Object.keys(block).sort().join(",") === "end,eventId,start") && nextAction.blockedReasons.length === 0, "REQ-MCP-NEXT-01 ready next-action has the bounded block list and no blocker reasons");
    const freeSlots = parseContent(await call(writerToken.secret, "dayline_calendar_free_slots", { calendarIds: [`local:${writer.id}:personal`], from: "2026-07-21T08:00:00.000Z", to: "2026-07-21T12:00:00.000Z", minimumDurationMinutes: 60, timeZone: "Europe/Berlin" }).then((entry) => entry.body));
    assert(Array.isArray(freeSlots) && freeSlots.length === 2 && freeSlots.every((slot) => Object.keys(slot).sort().join(",") === ["availability", "blockers", "durationMinutes", "end", "start", "status"].join(",") && slot.status === "free" && slot.availability === "free" && Array.isArray(slot.blockers) && typeof slot.start === "string" && typeof slot.end === "string" && Number.isInteger(slot.durationMinutes)), "REQ-FIX-04 free-slot result matches the bounded domain shape");
    const oversizedFreeSlots = await call(writerToken.secret, "dayline_calendar_free_slots", { calendarIds: [`local:${writer.id}:personal`], from: "2026-01-01T00:00:00.000Z", to: "2027-01-03T00:00:00.000Z" });
    assert(oversizedFreeSlots.body.result?.isError === true && parseContent(oversizedFreeSlots.body).error.code === "invalid_input", "REQ-FIX-04 free-slot range is limited to 366 days");
    const prerequisite = parseContent(await call(writerToken.secret, "dayline_project_plan_item_create", { projectId: project.id, title: "MCP prerequisite", dependencyIds: [], idempotencyKey: key("protocol-prerequisite") }).then((entry) => entry.body));
    const blockedPlan = parseContent(await call(writerToken.secret, "dayline_project_plan_item_create", { projectId: project.id, title: "MCP blocked plan", dependencyIds: [prerequisite.id], idempotencyKey: key("protocol-blocked-plan") }).then((entry) => entry.body));
    const blockedTask = parseContent(await call(writerToken.secret, "dayline_task_create", { title: "MCP blocked task", projectId: project.id, status: "next", idempotencyKey: key("protocol-blocked-task") }).then((entry) => entry.body));
    const blockedLink = await call(writerToken.secret, "dayline_task_plan_item_link", { taskId: blockedTask.id, projectId: project.id, planItemId: blockedPlan.id, expectedUpdatedAt: blockedTask.updatedAt });
    assert(blockedLink.body.result?.isError !== true, "REQ-FIX-04 blocker fixture links the task to its plan item");
    const blockedActions = parseContent(await call(writerToken.secret, "dayline_project_next_actions", { projectId: project.id }).then((entry) => entry.body));
    const blockedAction = blockedActions.find((entry: { taskId: string }) => entry.taskId === blockedTask.id);
    assert(blockedAction?.state === "blocked" && blockedAction.priority === "normal" && blockedAction.scheduleStatus === "unscheduled" && Array.isArray(blockedAction.scheduledBlocks) && Array.isArray(blockedAction.blockedReasons) && blockedAction.blockedReasons.length === 1 && blockedAction.blockedReasons[0] === `dependency_not_done:${prerequisite.id}`, "REQ-MCP-NEXT-01 blocked next-action exposes priority, schedule status, and the stable blocker enum");
    assert(blockedAction.scheduledBlocks.every((block: Record<string, unknown>) => Object.keys(block).sort().join(",") === "end,eventId,start" && typeof block.eventId === "string" && typeof block.start === "string" && typeof block.end === "string"), "REQ-MCP-NEXT-01 blocked scheduledBlocks use the frozen bounded shape");
    const nonNextTask = parseContent(await call(writerToken.secret, "dayline_task_create", { title: "MCP waiting task", projectId: project.id, status: "waiting", important: true, urgencyMode: "not_urgent", idempotencyKey: key("protocol-waiting-task") }).then((entry) => entry.body));
    const nonNextActions = parseContent(await call(writerToken.secret, "dayline_project_next_actions", { projectId: project.id }).then((entry) => entry.body));
    const nonNextAction = nonNextActions.find((entry: { taskId: string }) => entry.taskId === nonNextTask.id);
    assert(nonNextAction?.state === "blocked" && nonNextAction.priority === "important" && nonNextAction.scheduleStatus === "unscheduled" && nonNextAction.blockedReasons.length === 1 && nonNextAction.blockedReasons[0] === "task_status_waiting", "REQ-MCP-NEXT-01 non-next tasks expose the stable task-status blocker");
    assert(nonNextActions.every((entry: Record<string, unknown>) => ["ready", "blocked"].includes(String(entry.state)) && ["urgent", "important", "normal"].includes(String(entry.priority)) && ["scheduled", "unscheduled"].includes(String(entry.scheduleStatus)) && Array.isArray(entry.scheduledBlocks) && Array.isArray(entry.blockedReasons) && (entry.estimatedMinutes === undefined || (Number.isInteger(entry.estimatedMinutes) && Number(entry.estimatedMinutes) > 0)) && (entry.blockedReasons as unknown[]).every((reason) => typeof reason === "string" && /^(task_status_(inbox|waiting|someday)|project_not_active|plan_item_(paused|cancelled|done)|dependency_not_done:.+)$/.test(reason))), "REQ-MCP-NEXT-01 next-actions output is restricted to the frozen state, priority, schedule, block, and blocker value domains");
    for (const [label, secret] of [["outsider", outsiderToken.secret], ["admin", adminToken.secret]] as const) {
      const listDenied = await call(secret, "dayline_project_plan_items_list", { projectId: project.id });
      const getDenied = await call(secret, "dayline_project_plan_item_get", { projectId: project.id, planItemId: blockedPlan.id });
      assert(listDenied.body.result?.isError === true && parseContent(listDenied.body).error.code === "permission_denied", `REQ-MCP-SEC-01 ${label} plan list is denied outside the token owner's project scope`);
      assert(getDenied.body.result?.isError === true && parseContent(getDenied.body).error.code === "permission_denied", `REQ-MCP-SEC-01 ${label} plan get is denied outside the token owner's project scope`);
    }
    const conflictTask = parseContent(await call(writerToken.secret, "dayline_task_create", { title: "MCP conflict task", projectId: project.id, status: "next", idempotencyKey: key("conflict-task") }).then((entry) => entry.body));
    const scheduleConflict = await call(writerToken.secret, "dayline_task_schedule", { taskId: conflictTask.id, calendarId: `local:${writer.id}:personal`, start: "2026-07-21T09:15:00.000Z", end: "2026-07-21T09:45:00.000Z", idempotencyKey: key("schedule-conflict") });
    assertSafeScheduleConflict(scheduleConflict.body, "task schedule conflict");
    const calendarConflict = await call(writerToken.secret, "dayline_calendar_event_create", { calendarId: `local:${writer.id}:personal`, title: "MCP calendar conflict", start: "2026-07-21T09:30:00.000Z", end: "2026-07-21T09:50:00.000Z", availability: "busy", allowConflicts: false, idempotencyKey: key("calendar-conflict") });
    assertSafeScheduleConflict(calendarConflict.body, "calendar event conflict");
    const missingEvent = await call(writerToken.secret, "dayline_calendar_event_update", { eventId: "missing-event", calendarId: `local:${writer.id}:personal`, title: "missing event", expectedUpdatedAt: updated.updatedAt });
    assert(missingEvent.body.result?.isError === true && parseContent(missingEvent.body).error.code === "event_not_found", "REQ-FIX-05 missing event uses the event_not_found entity code");

    const replayEventInput = { calendarId: `local:${writer.id}:personal`, title: "MCP replay event", start: "2026-07-26T09:00:00.000Z", end: "2026-07-26T10:00:00.000Z", idempotencyKey: key("calendar-replay") };
    const replayEventOne = await call(writerToken.secret, "dayline_calendar_event_create", replayEventInput);
    const replayEventTwo = await call(writerToken.secret, "dayline_calendar_event_create", replayEventInput);
    const replayEventChanged = await call(writerToken.secret, "dayline_calendar_event_create", { ...replayEventInput, title: "MCP replay changed" });
    const replayEventResult = parseContent(replayEventOne.body);
    const replayEventResultTwo = parseContent(replayEventTwo.body);
    assert(replayEventOne.body.result?.isError !== true && replayEventTwo.body.result?.isError !== true && replayEventResult.id === replayEventResultTwo.id && replayEventResultTwo.title === "MCP replay event", "REQ-MCP-CALENDAR-01 same-key calendar create replays the first result before conflict checks");
    assert(replayEventChanged.body.result?.isError === true && parseContent(replayEventChanged.body).error.code === "idempotency_conflict", "REQ-MCP-IDEM-01 changed calendar input under a reused key is an idempotency_conflict");

    const matrixPlan = parseContent(await call(writerToken.secret, "dayline_project_plan_item_create", { projectId: project.id, title: "MCP CAS plan", dependencyIds: [], idempotencyKey: key("cas-plan") }).then((entry) => entry.body));
    const matrixPlanUpdated = parseContent(await call(writerToken.secret, "dayline_project_plan_item_update", { projectId: project.id, planItemId: matrixPlan.id, title: "MCP CAS plan updated", expectedUpdatedAt: matrixPlan.updatedAt }).then((entry) => entry.body));
    assertToolError(await call(writerToken.secret, "dayline_project_plan_item_update", { projectId: project.id, planItemId: matrixPlan.id, title: "stale plan", expectedUpdatedAt: matrixPlan.updatedAt }), "version_conflict", "REQ-MCP-CAS-01 plan update stale revision");
    assertToolError(await call(writerToken.secret, "dayline_project_plan_item_delete", { projectId: project.id, planItemId: matrixPlan.id, expectedUpdatedAt: matrixPlan.updatedAt }), "version_conflict", "REQ-MCP-CAS-01 plan delete stale revision");
    assertToolError(await call(writerToken.secret, "dayline_project_plan_item_update", { projectId: project.id, planItemId: "missing-plan-item", title: "missing plan", expectedUpdatedAt: matrixPlanUpdated.updatedAt }), "plan_item_not_found", "REQ-MCP-CAS-01 plan update not-found");
    assertToolError(await call(writerToken.secret, "dayline_project_plan_item_delete", { projectId: project.id, planItemId: "missing-plan-item", expectedUpdatedAt: matrixPlanUpdated.updatedAt }), "plan_item_not_found", "REQ-MCP-CAS-01 plan delete not-found");

    const matrixNote = parseContent(await call(writerToken.secret, "dayline_note_create", { projectId: project.id, title: "MCP CAS note", content: "CAS note", idempotencyKey: key("cas-note") }).then((entry) => entry.body));
    const matrixNoteUpdated = parseContent(await call(writerToken.secret, "dayline_note_update", { noteId: matrixNote.id, title: "MCP CAS note updated", expectedUpdatedAt: matrixNote.updatedAt }).then((entry) => entry.body));
    assertToolError(await call(writerToken.secret, "dayline_note_update", { noteId: matrixNote.id, title: "stale note", expectedUpdatedAt: matrixNote.updatedAt }), "version_conflict", "REQ-MCP-CAS-01 note update stale revision");
    assertToolError(await call(writerToken.secret, "dayline_note_append", { noteId: matrixNote.id, content: "stale append", expectedUpdatedAt: matrixNote.updatedAt }), "version_conflict", "REQ-MCP-CAS-01 note append stale revision");
    assertToolError(await call(writerToken.secret, "dayline_note_delete", { noteId: matrixNote.id, expectedUpdatedAt: matrixNote.updatedAt }), "version_conflict", "REQ-MCP-CAS-01 note delete stale revision");
    assertToolError(await call(writerToken.secret, "dayline_note_update", { noteId: "missing-note", title: "missing note", expectedUpdatedAt: matrixNoteUpdated.updatedAt }), "note_not_found", "REQ-MCP-CAS-01 note update not-found");
    assertToolError(await call(writerToken.secret, "dayline_note_append", { noteId: "missing-note", content: "missing append", expectedUpdatedAt: matrixNoteUpdated.updatedAt }), "note_not_found", "REQ-MCP-CAS-01 note append not-found");
    assertToolError(await call(writerToken.secret, "dayline_note_delete", { noteId: "missing-note", expectedUpdatedAt: matrixNoteUpdated.updatedAt }), "note_not_found", "REQ-MCP-CAS-01 note delete not-found");

    const matrixEvent = parseContent(await call(writerToken.secret, "dayline_calendar_event_create", { calendarId: `local:${writer.id}:personal`, title: "MCP CAS event", start: "2026-08-10T10:00:00.000Z", end: "2026-08-10T11:00:00.000Z", allowConflicts: false, idempotencyKey: key("cas-event") }).then((entry) => entry.body));
    const matrixEventUpdated = parseContent(await call(writerToken.secret, "dayline_calendar_event_update", { eventId: matrixEvent.id, calendarId: `local:${writer.id}:personal`, title: "MCP CAS event updated", expectedUpdatedAt: matrixEvent.updatedAt }).then((entry) => entry.body));
    assertToolError(await call(writerToken.secret, "dayline_calendar_event_update", { eventId: matrixEvent.id, calendarId: `local:${writer.id}:personal`, title: "stale event", expectedUpdatedAt: matrixEvent.updatedAt }), "version_conflict", "REQ-MCP-CAS-01 event update stale revision");
    assertToolError(await call(writerToken.secret, "dayline_calendar_event_delete", { eventId: matrixEvent.id, calendarId: `local:${writer.id}:personal`, expectedUpdatedAt: matrixEvent.updatedAt }), "version_conflict", "REQ-MCP-CAS-01 event delete stale revision");
    assertToolError(await call(writerToken.secret, "dayline_calendar_event_update", { eventId: "missing-event", calendarId: `local:${writer.id}:personal`, title: "missing event", expectedUpdatedAt: matrixEventUpdated.updatedAt }), "event_not_found", "REQ-MCP-CAS-01 event update not-found");
    assertToolError(await call(writerToken.secret, "dayline_calendar_event_delete", { eventId: "missing-event", calendarId: `local:${writer.id}:personal`, expectedUpdatedAt: matrixEventUpdated.updatedAt }), "event_not_found", "REQ-MCP-CAS-01 event delete not-found");
    console.log("REQ-MCP-CAS-01: plan update/delete, note update/append/delete, and event update/delete stale/not-found matrix passed");

    const previewRelation = parseContent(await call(writerToken.secret, "dayline_relation_link", { sourceKind: "task", sourceId: created.id, targetKind: "note", targetId: seededNote.id, idempotencyKey: key("preview-relation-seed") }).then((entry) => entry.body));
    const previewCases: readonly [string, Record<string, unknown>][] = [
      ["dayline_task_create", { title: "MCP preview task", projectId: project.id, preview: true }],
      ["dayline_task_update", { taskId: created.id, title: "MCP preview task update", preview: true }],
      ["dayline_task_schedule", { taskId: created.id, calendarId: `local:${writer.id}:personal`, start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z", preview: true }],
      ["dayline_project_plan_item_create", { projectId: project.id, title: "MCP preview plan", dependencyIds: [], preview: true }],
      ["dayline_project_plan_item_update", { projectId: project.id, planItemId: blockedPlan.id, title: "MCP preview plan update", preview: true }],
      ["dayline_project_plan_item_delete", { projectId: project.id, planItemId: blockedPlan.id, preview: true }],
      ["dayline_task_plan_item_link", { taskId: created.id, projectId: project.id, planItemId: prerequisite.id, preview: true }],
      ["dayline_task_plan_item_unlink", { taskId: blockedTask.id, preview: true }],
      ["dayline_note_create", { projectId: project.id, title: "MCP preview note", content: "preview only", preview: true }],
      ["dayline_note_update", { noteId: seededNote.id, title: "MCP preview note update", preview: true }],
      ["dayline_note_append", { noteId: seededNote.id, content: "preview append", preview: true }],
      ["dayline_note_delete", { noteId: seededNote.id, preview: true }],
      ["dayline_task_reschedule", { taskId: created.id, eventId: scheduled.event.id, calendarId: `local:${writer.id}:personal`, start: "2026-08-20T11:00:00.000Z", end: "2026-08-20T12:00:00.000Z", preview: true }],
      ["dayline_task_schedule_cancel", { taskId: created.id, eventId: scheduled.event.id, preview: true }],
      ["dayline_relation_link", { sourceKind: "task", sourceId: created.id, targetKind: "note", targetId: seededNote.id, preview: true }],
      ["dayline_relation_unlink", { linkId: previewRelation.id, preview: true }],
      ["dayline_calendar_event_create", { calendarId: `local:${writer.id}:personal`, title: "MCP preview event", start: "2026-08-20T13:00:00.000Z", end: "2026-08-20T14:00:00.000Z", preview: true }],
      ["dayline_calendar_event_update", { eventId: scheduled.event.id, calendarId: `local:${writer.id}:personal`, title: "MCP preview event update", start: scheduled.event.start, end: scheduled.event.end, preview: true }],
      ["dayline_calendar_event_delete", { eventId: scheduled.event.id, calendarId: `local:${writer.id}:personal`, preview: true }],
    ];
    assert(previewCases.length === 19 && new Set(previewCases.map(([name]) => name)).size === 19, "REQ-MCP-PREVIEW-01 defines exactly 19 distinct mutation preview calls");
    const previewBefore = await protocolPreviewSnapshot(writerToken.secret, project.id, `local:${writer.id}:personal`, created.id, seededNote.id, blockedPlan.id, scheduled.event.id, matrixNote.id, matrixEvent.id);
    const previewActionCountBefore = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM ai_action_events WHERE actor_user_id = $1", [writer.id]);
    const previewExecuted: string[] = [];
    for (const [name, args] of previewCases) {
      assert(args.preview === true && !Object.prototype.hasOwnProperty.call(args, "idempotencyKey") && !Object.prototype.hasOwnProperty.call(args, "expectedUpdatedAt"), `REQ-MCP-PREVIEW-01 ${name} omits execution safety fields`);
      const result = await call(writerToken.secret, name, args);
      const payload = parseContent(result.body);
      assertPreviewShape(payload, name);
      previewExecuted.push(name);
    }
    const previewAfter = await protocolPreviewSnapshot(writerToken.secret, project.id, `local:${writer.id}:personal`, created.id, seededNote.id, blockedPlan.id, scheduled.event.id, matrixNote.id, matrixEvent.id);
    const previewActionCountAfter = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM ai_action_events WHERE actor_user_id = $1", [writer.id]);
    assert(previewExecuted.length === 19 && previewExecuted.join(",") === previewCases.map(([name]) => name).join(","), "REQ-MCP-PREVIEW-01 executed all 19 preview mutations through the protocol");
    assert(JSON.stringify(previewAfter) === JSON.stringify(previewBefore) && previewActionCountAfter.rows[0]?.count === previewActionCountBefore.rows[0]?.count, "REQ-MCP-PREVIEW-01 preview leaves queried object snapshots and row counts unchanged");
    console.log(`REQ-MCP-PREVIEW-01 mutations: ${previewExecuted.join(",")}`);

    const isolated = parseContent(await call(outsiderToken.secret, "dayline_task_get", { taskId: created.id }).then((entry) => entry.body));
    assert(isolated === null, "a token cannot read another owner's private task");

    const audit = await database.query<{ metadata: string }>("SELECT metadata::text AS metadata FROM app_audit_events WHERE action = 'mcp.tool' ORDER BY created_at DESC LIMIT 200");
    const auditMetadata = audit.rows.map((row) => JSON.parse(row.metadata) as { outcome?: string; tokenId?: string; tool?: string; durationMs?: number; errorCode?: string | null });
    assert(auditMetadata.some((entry) => entry.outcome === "success") && auditMetadata.some((entry) => entry.outcome === "failure") && audit.rows.every((row) => !row.metadata.includes(writerToken.secret) && !row.metadata.includes("stack")) && auditMetadata.every((entry) => typeof entry.tokenId === "string" && typeof entry.tool === "string" && typeof entry.durationMs === "number" && (entry.errorCode === null || typeof entry.errorCode === "string")), "tool success and failure audits contain only stable metadata without secrets or stacks");

    process.env.KALENDER_MCP_TOKEN_REQUESTS_PER_MINUTE = "1";
    const limitedToken = await tokens.createMcpToken(admin);
    const rateFirst = await raw(limitedToken.secret, initialize());
    const rateSecond = await raw(limitedToken.secret, initialize());
    assert(rateFirst.response.status === 200 && rateSecond.response.status === 429 && rateSecond.response.headers.has("retry-after") && rateSecond.response.headers.has("x-ratelimit-limit"), "429 includes retry and rate metadata");
    delete process.env.KALENDER_MCP_TOKEN_REQUESTS_PER_MINUTE;
    process.env.KALENDER_MCP_TRUST_PROXY_IP_HEADERS = "true";
    process.env.KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE = "1";
    await raw("dln_invalid_rate_test", initialize(), { "x-real-ip": "203.0.113.77" });
    const invalidLimited = await raw("dln_invalid_rate_test", initialize(), { "x-real-ip": "203.0.113.77" });
    assert(invalidLimited.response.status === 429 && invalidLimited.response.headers.has("www-authenticate") && invalidLimited.response.headers.has("retry-after"), "invalid-token/IP limits return authenticated retry metadata");
    delete process.env.KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE;

    const expired = await tokens.createMcpToken(admin);
    await database.query("UPDATE mcp_api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    assert((await raw(expired.secret, initialize())).response.status === 401, "expired token is rejected");
    const revoked = await tokens.createMcpToken(admin);
    await tokens.revokeMcpToken(admin, revoked.id);
    assert((await raw(revoked.secret, initialize())).response.status === 401, "revoked token is rejected");
    const disabled = await tokens.createMcpToken(writer);
    await auth.updateManagedAppUser(admin, writer.id, { disabled: true });
    assert((await raw(disabled.secret, initialize())).response.status === 401, "disabled-owner token is rejected");
    console.log("REQ-FIX-01/04/05/09: MCP Streamable HTTP protocol, auth, scope, rate, audit, schema, error, and domain-flow tests passed");
  } finally {
    delete process.env.KALENDER_MCP_TOKEN_REQUESTS_PER_MINUTE;
    delete process.env.KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE;
    delete process.env.KALENDER_MCP_TRUST_PROXY_IP_HEADERS;
    delete process.env.KALENDER_MCP_ALLOWED_HOSTS;
    delete process.env.KALENDER_MCP_ALLOWED_ORIGINS;
    await closeDatabaseForRestore().catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
}

function rpc(method: string, params: Record<string, unknown>) { return { jsonrpc: "2.0", id: randomUUID(), method, params }; }
function initialize() { return rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-protocol-test", version: "1.0.0" } }); }
async function raw(secret: string | undefined, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost", ...extraHeaders });
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  const response = await POST(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(payload) }));
  return { response, body: await response.json() as Record<string, any> };
}
async function call(secret: string, name: string, args: Record<string, unknown>) { return raw(secret, rpc("tools/call", { name, arguments: args })); }
function assertToolError(result: { body: Record<string, any> }, code: string, label: string): void {
  assert(result.body.result?.isError === true && parseContent(result.body).error.code === code, `${label} is ${code}`);
}
async function protocolPreviewSnapshot(secret: string, projectId: string, calendarId: string, taskId: string, noteId: string, planItemId: string, eventId: string, matrixNoteId: string, matrixEventId: string): Promise<Record<string, unknown>> {
  const tasks = parseContent((await call(secret, "dayline_tasks_list", { projectId })).body) as Array<Record<string, unknown>>;
  const plans = parseContent((await call(secret, "dayline_project_plan_items_list", { projectId })).body) as Array<Record<string, unknown>>;
  const notes = parseContent((await call(secret, "dayline_notes_search", { query: "MCP", projectId })).body) as Array<Record<string, unknown>>;
  const events = parseContent((await call(secret, "dayline_calendar_events_list", { calendarIds: [calendarId], from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" })).body) as Array<Record<string, unknown>>;
  const relations = parseContent((await call(secret, "dayline_relations_list", { kind: "note", entityId: noteId })).body) as Array<Record<string, unknown>>;
  const task = parseContent((await call(secret, "dayline_task_get", { taskId })).body) as Record<string, unknown> | null;
  const note = parseContent((await call(secret, "dayline_note_get", { noteId })).body) as Record<string, unknown> | null;
  const matrixNote = parseContent((await call(secret, "dayline_note_get", { noteId: matrixNoteId })).body) as Record<string, unknown> | null;
  const plan = parseContent((await call(secret, "dayline_project_plan_item_get", { projectId, planItemId })).body) as Record<string, unknown> | null;
  const event = events.find((entry) => entry.id === eventId) ?? null;
  const matrixEvent = events.find((entry) => entry.id === matrixEventId) ?? null;
  return {
    counts: { tasks: tasks.length, plans: plans.length, notes: notes.length, events: events.length, relations: relations.length },
    task: task && { id: task.id, title: task.title, updatedAt: task.updatedAt },
    note: note && { id: note.id, title: note.title, content: note.content, updatedAt: note.updatedAt },
    matrixNote: matrixNote && { id: matrixNote.id, title: matrixNote.title, content: matrixNote.content, updatedAt: matrixNote.updatedAt },
    plan: plan && { id: plan.id, title: plan.title, status: plan.status, updatedAt: plan.updatedAt },
    event: event && { id: event.id, title: event.title, start: event.start, end: event.end, updatedAt: event.updatedAt },
    matrixEvent: matrixEvent && { id: matrixEvent.id, title: matrixEvent.title, start: matrixEvent.start, end: matrixEvent.end, updatedAt: matrixEvent.updatedAt },
  };
}
function parseContent(body: Record<string, any>): any {
  if (!body.result?.content?.[0]?.text) throw new Error(`Missing MCP tool result: ${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}
function assertPreviewShape(value: any, label: string, requireRevision = false): asserts value is {
  preview: true;
  currentRevision?: string;
  before: unknown;
  after: unknown;
  warnings: readonly unknown[];
  conflicts: readonly unknown[];
} {
  assert(value?.preview === true, `${label} is marked as preview`);
  assert((value.currentRevision === undefined || typeof value.currentRevision === "string") && (!requireRevision || typeof value.currentRevision === "string"), `${label} reports a valid currentRevision when a target has one`);
  assert(Object.prototype.hasOwnProperty.call(value, "before") && Object.prototype.hasOwnProperty.call(value, "after"), `${label} reports before and after`);
  assert(Array.isArray(value.warnings) && Array.isArray(value.conflicts), `${label} reports warnings and conflicts arrays`);
  const expectedKeys = ["after", "before", "conflicts", "preview", "warnings", ...(value.currentRevision === undefined ? [] : ["currentRevision"])].sort().join(",");
  assert(Object.keys(value).sort().join(",") === expectedKeys, `${label} uses the frozen preview object shape`);
}
function assertSafeScheduleConflict(body: Record<string, any>, label: string): void {
  const payload = parseContent(body);
  assert(payload.error?.code === "schedule_conflict", `REQ-FIX-05 ${label} is normalized to schedule_conflict`);
  const conflicts = payload.error.details?.conflicts;
  assert(Array.isArray(conflicts) && conflicts.length > 0 && conflicts.length <= 20, `REQ-FIX-05 ${label} exposes bounded conflict details`);
  assert(conflicts.every((entry: unknown) => entry && typeof entry === "object" && Object.keys(entry as object).every((field) => ["id", "title", "start", "end"].includes(field)) && Object.values(entry as Record<string, unknown>).every((value) => typeof value === "string" && value.length <= 500)), `REQ-FIX-05 ${label} conflict details contain only safe bounded fields`);
}
function schemaContainsEnum(schema: unknown, expected: readonly string[]): boolean {
  if (!schema || typeof schema !== "object") return false;
  const candidate = schema as Record<string, unknown>;
  const enumValues = candidate.enum;
  if (Array.isArray(enumValues) && expected.every((value) => enumValues.includes(value))) return true;
  return Object.values(candidate).some((value) => Array.isArray(value)
    ? value.some((entry) => schemaContainsEnum(entry, expected))
    : schemaContainsEnum(value, expected));
}
function requiredFields(schema: Record<string, unknown> | undefined): readonly string[] {
  return Array.isArray(schema?.required) && schema.required.every((entry) => typeof entry === "string") ? schema.required : [];
}
function schemaProperties(schema: Record<string, unknown> | undefined): readonly string[] {
  return schema?.properties && typeof schema.properties === "object" ? Object.keys(schema.properties as Record<string, unknown>) : [];
}
function schemaProperty(schema: Record<string, unknown> | undefined, name: string): Record<string, unknown> | undefined {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const property = (properties as Record<string, unknown>)[name];
  return property && typeof property === "object" && !Array.isArray(property) ? property as Record<string, unknown> : undefined;
}
function validWriteArguments(name: string): Record<string, unknown> {
  const common = { expectedUpdatedAt: "2026-07-21T08:00:00.000Z", idempotencyKey: key(`denied-${name}`) };
  const values: Record<string, Record<string, unknown>> = {
    dayline_task_create: { title: "x", idempotencyKey: common.idempotencyKey },
    dayline_task_update: { taskId: "x", title: "x", ...common },
    dayline_task_schedule: { taskId: "x", calendarId: "x", start: "2026-07-21T09:00:00.000Z", end: "2026-07-21T10:00:00.000Z", idempotencyKey: common.idempotencyKey },
    dayline_project_plan_item_create: { projectId: "x", title: "x", dependencyIds: [], idempotencyKey: common.idempotencyKey },
    dayline_project_plan_item_update: { projectId: "x", planItemId: "x", dependencyIds: [], ...common },
    dayline_project_plan_item_delete: { projectId: "x", planItemId: "x", ...common },
    dayline_task_plan_item_link: { taskId: "x", projectId: "x", planItemId: "x", ...common },
    dayline_task_plan_item_unlink: { taskId: "x", ...common },
    dayline_note_create: { title: "x", content: "x", idempotencyKey: common.idempotencyKey },
    dayline_note_update: { noteId: "x", ...common },
    dayline_note_append: { noteId: "x", content: "x", ...common },
    dayline_note_delete: { noteId: "x", ...common },
    dayline_task_reschedule: { taskId: "x", eventId: "x", calendarId: "x", start: "2026-07-21T09:00:00.000Z", end: "2026-07-21T10:00:00.000Z", ...common },
    dayline_task_schedule_cancel: { taskId: "x", eventId: "x", ...common },
    dayline_relation_link: { sourceKind: "task", sourceId: "x", targetKind: "note", targetId: "y", idempotencyKey: common.idempotencyKey },
    dayline_relation_unlink: { linkId: "x", idempotencyKey: common.idempotencyKey },
    dayline_calendar_event_create: { calendarId: "x", title: "x", start: "2026-07-21T09:00:00.000Z", end: "2026-07-21T10:00:00.000Z", idempotencyKey: common.idempotencyKey },
    dayline_calendar_event_update: { eventId: "x", calendarId: "x", title: "x", start: "2026-07-21T09:00:00.000Z", end: "2026-07-21T10:00:00.000Z", ...common },
    dayline_calendar_event_delete: { eventId: "x", calendarId: "x", ...common },
  };
  const value = values[name];
  if (!value) throw new Error(`No protocol fixture for ${name}`);
  return value;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
