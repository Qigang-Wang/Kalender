import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isIP } from "node:net";
import { z } from "zod";

import { AuthError, recordAuditEvent, type AppUser } from "./auth";
import { McpDomainInputError, McpDomainService, mcpDomainOperationNames } from "./mcp-domain-service";
import { authenticateMcpToken, McpTokenError, type AuthenticatedMcpToken, type McpTokenRateLimitResult } from "./mcp-token-repository";
import { noteTypes } from "./note-repository";
import { entityKinds } from "./entity-link-repository";
import { projectPlanItemStatuses } from "./project-plan-repository";
import { taskStatuses, taskUrgencyModes, taskSourceKinds, TaskRepositoryError } from "./task-repository";
import { TaskValidationError } from "./task-validation";

export const MCP_PATH = "/mcp";
const READ_SCOPE = "dayline:read" as const;
const WRITE_SCOPE = "dayline:write" as const;
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

/**
 * Keep this list as the protocol registry. The domain service has a matching
 * typed operation map; the runtime check in registerTool prevents either side
 * from silently exposing an unimplemented operation.
 */
export const MCP_TOOL_NAMES = [
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

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_READ_TOOL_NAMES = [
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
] as const satisfies readonly McpToolName[];

export const MCP_WRITE_TOOL_NAMES = [
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
] as const satisfies readonly McpToolName[];

export const MCP_DESTRUCTIVE_TOOL_NAMES = [
  "dayline_project_plan_item_delete",
  "dayline_note_delete",
  "dayline_task_schedule_cancel",
  "dayline_relation_unlink",
  "dayline_calendar_event_delete",
] as const satisfies readonly McpToolName[];

export const MCP_MUTATING_TOOL_NAMES = [...MCP_WRITE_TOOL_NAMES, ...MCP_DESTRUCTIVE_TOOL_NAMES] as const;
const MUTATION_WITH_IDEMPOTENCY_KEY = new Set<McpToolName>([
  "dayline_task_create",
  "dayline_task_schedule",
  "dayline_project_plan_item_create",
  "dayline_note_create",
  "dayline_relation_link",
  "dayline_calendar_event_create",
]);
const MUTATION_WITH_EXPECTED_REVISION = new Set<McpToolName>([
  "dayline_task_update",
  "dayline_project_plan_item_update",
  "dayline_task_plan_item_link",
  "dayline_task_plan_item_unlink",
  "dayline_note_update",
  "dayline_note_append",
  "dayline_task_reschedule",
  "dayline_project_plan_item_delete",
  "dayline_note_delete",
  "dayline_task_schedule_cancel",
  "dayline_calendar_event_update",
  "dayline_calendar_event_delete",
]);

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const updateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export async function handleMcpRequest(request: Request): Promise<Response> {
  const targetError = validateRequestTarget(request);
  if (targetError) return targetError;
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return authenticationResponse(401, "MCP 端点需要 Bearer 令牌");
  let principal: AuthenticatedMcpToken;
  try {
    principal = await authenticateMcpToken(token, {
      requiredScope: READ_SCOPE,
      ipAddress: requestIpAddress(request),
      rateLimit: configuredLimit("KALENDER_MCP_TOKEN_REQUESTS_PER_MINUTE"),
      invalidTokenRateLimit: configuredLimit("KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE"),
    });
  } catch (error) {
    if (error instanceof McpTokenError) return authenticationResponse(error.status, safeAuthenticationMessage(error), error.rateLimit);
    return authenticationResponse(401, "MCP API 令牌无效或已过期");
  }
  const server = createMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return withRateLimitHeaders(await transport.handleRequest(request), principal.rateLimit);
}

export function createMcpServer(principal: AuthenticatedMcpToken): McpServer {
  const domain = new McpDomainService(actorFor(principal));
  const server = new McpServer({ name: "dayline", version: "0.1.0" });

  registerTool(server, principal, domain, "dayline_search", "Search workspace content.", strictObject({
    query: z.string().min(1).max(500),
    kind: z.enum(["task", "project", "note", "calendar", "mail", "ai"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_today_get", "Get a bounded Today snapshot.", strictObject({
    from: instant,
    to: instant,
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_tasks_list", "List accessible tasks.", strictObject({
    includeCompleted: z.boolean().optional(),
    projectId: identifier.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_task_get", "Get one accessible task.", strictObject({
    taskId: identifier,
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_task_create", "Create a task.", strictObject({
    ...taskCreateFields,
    ...idempotentCreateFields,
  }), createAnnotations);
  registerTool(server, principal, domain, "dayline_task_update", "Update an accessible task with compare-and-set revision protection.", strictObject({
    taskId: identifier,
    ...taskUpdateFields,
    ...revisionFields,
  }), updateAnnotations);
  registerTool(server, principal, domain, "dayline_projects_list", "List accessible projects.", strictObject({
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_project_get", "Get one accessible project.", strictObject({
    projectId: identifier,
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_task_schedule", "Create a task focus-time block.", strictObject({
    taskId: identifier,
    ...scheduleFields,
    ...idempotentCreateFields,
  }), createAnnotations);
  registerTool(server, principal, domain, "dayline_notes_search", "Search accessible notes.", strictObject({
    query: z.string().min(1).max(500),
    projectId: identifier.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }), readAnnotations);

  registerTool(server, principal, domain, "dayline_project_plan_items_list", "List plan items in an accessible project.", strictObject({
    projectId: identifier,
    limit: z.number().int().min(1).max(100).optional(),
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_project_plan_item_get", "Get one accessible project plan item.", strictObject({
    projectId: identifier,
    planItemId: identifier,
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_project_plan_item_create", "Create a project plan item.", strictObject({
    projectId: identifier,
    ...planItemFields(true),
    ...idempotentCreateFields,
  }), createAnnotations);
  registerTool(server, principal, domain, "dayline_project_plan_item_update", "Update a project plan item with compare-and-set revision protection.", strictObject({
    projectId: identifier,
    planItemId: identifier,
    ...planItemFields(false),
    ...revisionFields,
  }), updateAnnotations);
  registerTool(server, principal, domain, "dayline_project_plan_item_delete", "Delete a project plan item; this is irreversible.", strictObject({
    projectId: identifier,
    planItemId: identifier,
    ...revisionFields,
  }), destructiveAnnotations);
  registerTool(server, principal, domain, "dayline_task_plan_item_link", "Link an accessible task to a project plan item.", strictObject({
    taskId: identifier,
    projectId: identifier,
    planItemId: identifier,
    ...revisionFields,
  }), updateAnnotations);
  registerTool(server, principal, domain, "dayline_task_plan_item_unlink", "Unlink an accessible task from a project plan item.", strictObject({
    taskId: identifier,
    ...revisionFields,
  }), updateAnnotations);

  registerTool(server, principal, domain, "dayline_note_get", "Get one accessible note as portable plain text or Markdown.", strictObject({
    noteId: identifier,
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_note_create", "Create a note using portable plain text or Markdown content.", strictObject({
    id: identifier.optional(),
    projectId: identifier.optional(),
    title,
    content: mcpNoteContent,
    noteType: z.enum(noteTypes).optional(),
    pinned: z.boolean().optional(),
    ...idempotentCreateFields,
  }), createAnnotations);
  registerTool(server, principal, domain, "dayline_note_update", "Update a note with compare-and-set revision protection.", strictObject({
    noteId: identifier,
    projectId: identifier.nullable().optional(),
    title: title.optional(),
    content: mcpNoteContent.optional(),
    noteType: z.enum(noteTypes).optional(),
    pinned: z.boolean().optional(),
    ...revisionFields,
  }), updateAnnotations);
  registerTool(server, principal, domain, "dayline_note_append", "Append portable plain text or Markdown to a note.", strictObject({
    noteId: identifier,
    content: mcpNoteContent.min(1),
    ...revisionFields,
  }), updateAnnotations);
  registerTool(server, principal, domain, "dayline_note_delete", "Delete a note and its links; this is irreversible.", strictObject({
    noteId: identifier,
    ...revisionFields,
  }), destructiveAnnotations);

  registerTool(server, principal, domain, "dayline_calendars_list", "List accessible calendars.", strictObject({}), readAnnotations);
  registerTool(server, principal, domain, "dayline_calendar_events_list", "List ordinary calendar events in a bounded range.", strictObject({
    calendarIds: z.array(identifier).max(100).optional(),
    from: instant,
    to: instant,
    limit: z.number().int().min(1).max(1000).optional(),
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_calendar_free_slots", "Find free calendar slots in a bounded range.", strictObject({
    calendarIds: z.array(identifier).max(100).optional(),
    from: instant,
    to: instant,
    minimumDurationMinutes: z.number().int().min(1).max(1440).optional(),
    timeZone: timeZone.optional(),
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_task_reschedule", "Move an existing task focus-time block with compare-and-set revision protection.", strictObject({
    taskId: identifier,
    eventId: identifier,
    ...scheduleFields,
    ...revisionFields,
  }), updateAnnotations);
  registerTool(server, principal, domain, "dayline_task_schedule_cancel", "Cancel a task focus-time block; the task itself remains.", strictObject({
    taskId: identifier,
    eventId: identifier,
    ...revisionFields,
  }), destructiveAnnotations);
  registerTool(server, principal, domain, "dayline_project_next_actions", "List next actions in an accessible project.", strictObject({
    projectId: identifier,
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_relations_list", "List accessible relations for an entity.", strictObject({
    kind: z.enum(entityKinds),
    entityId: identifier,
    limit: z.number().int().min(1).max(100).optional(),
  }), readAnnotations);
  registerTool(server, principal, domain, "dayline_relation_link", "Create an idempotent relation between accessible entities.", strictObject({
    sourceKind: z.enum(entityKinds),
    sourceId: identifier,
    targetKind: z.enum(entityKinds),
    targetId: identifier,
    relation: relationName.optional(),
    ...idempotentCreateFields,
  }), createAnnotations);
  registerTool(server, principal, domain, "dayline_relation_unlink", "Remove a relation by its immutable link ID.", strictObject({
    linkId: identifier,
    ...idempotentCreateFields,
  }), destructiveAnnotations);

  registerTool(server, principal, domain, "dayline_calendar_event_create", "Create an ordinary calendar event.", strictObject({
    ...calendarEventCreateFields,
    ...idempotentCreateFields,
  }), createAnnotations);
  registerTool(server, principal, domain, "dayline_calendar_event_update", "Update an ordinary calendar event with compare-and-set revision protection.", strictObject({
    eventId: identifier,
    ...calendarEventUpdateFields,
    ...revisionFields,
  }), updateAnnotations);
  registerTool(server, principal, domain, "dayline_calendar_event_delete", "Delete an ordinary calendar event; this is irreversible.", strictObject({
    eventId: identifier,
    calendarId: identifier,
    recurrenceSeriesId: identifier.optional(),
    recurrenceId: instant.optional(),
    recurrenceScope: recurrenceScope.optional(),
    ...revisionFields,
  }), destructiveAnnotations);

  return server;
}

const identifier = z.string().min(1).max(500);
const title = z.string().min(1).max(240);
const instant = z.string().datetime({ offset: true });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeZone = z.string().min(1).max(100);
const mcpNoteContent = z.string().max(500_000).refine((value) => !value.startsWith("plate-json-v1:"), "MCP 笔记内容必须是纯文本或 Markdown");
const relationName = z.string().regex(/^[a-z][a-z0-9-]{0,49}$/);
const idempotencyKey = z.string().min(16).max(160);
const idempotentCreateFields = {
  idempotencyKey: idempotencyKey.optional(),
  preview: z.boolean().optional(),
};
const revisionFields = {
  idempotencyKey: idempotencyKey.optional(),
  expectedUpdatedAt: instant.optional(),
  preview: z.boolean().optional(),
};
const taskUpdateFields = {
  title: title.optional(),
  notes: z.string().max(500_000).nullable().optional(),
  status: z.enum(taskStatuses).optional(),
  important: z.boolean().optional(),
  urgencyMode: z.enum(taskUrgencyModes).optional(),
  dueAt: instant.nullable().optional(),
  estimatedMinutes: z.number().int().positive().max(100_000).nullable().optional(),
  projectId: identifier.nullable().optional(),
  planItemId: identifier.nullable().optional(),
  projectName: z.string().max(240).nullable().optional(),
  areaName: z.string().max(240).nullable().optional(),
  assigneeUserId: identifier.nullable().optional(),
  sourceReferences: z.array(z.object({
    kind: z.enum(taskSourceKinds),
    sourceId: identifier,
    label: z.string().min(1).max(500),
    href: z.string().url().max(2_000).optional(),
  }).strict()).max(100).optional(),
};
const taskCreateFields = {
  ...taskUpdateFields,
  title,
};
const scheduleFields = {
  calendarId: identifier,
  start: instant,
  end: instant,
  timeZone: timeZone.optional(),
  allowConflicts: z.boolean().optional(),
};
const planItemFields = (create: boolean) => ({
  ...(create ? { id: identifier.optional() } : {}),
  title: create ? title : title.optional(),
  status: z.enum(projectPlanItemStatuses).optional(),
  plannedStart: dateOnly.optional(),
  plannedEnd: dateOnly.optional(),
  dependencyIds: create ? z.array(identifier).max(100) : z.array(identifier).max(100).optional(),
  phaseId: identifier.nullable().optional(),
  durationWorkdays: z.number().int().min(1).max(2600).optional(),
  autoSchedule: z.boolean().optional(),
});

const attendee = z.object({
  address: z.string().min(1).max(500),
  name: z.string().max(240).optional(),
}).strict();
const recurrence = z.object({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(1000),
  weekDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  end: z.enum(["never", "until", "count"]),
  until: instant.optional(),
  count: z.number().int().min(1).max(10_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.end === "until" && !value.until) context.addIssue({ code: z.ZodIssueCode.custom, path: ["until"], message: "until is required when recurrence ends by date" });
  if (value.end !== "until" && value.until) context.addIssue({ code: z.ZodIssueCode.custom, path: ["until"], message: "until is only valid for an until recurrence" });
  if (value.end === "count" && value.count === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["count"], message: "count is required when recurrence ends by count" });
  if (value.end !== "count" && value.count !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["count"], message: "count is only valid for a count recurrence" });
});
const recurrenceScope = z.enum(["occurrence", "following", "series"]);
const calendarEventFields = {
  calendarId: identifier,
  title,
  description: z.string().max(100_000).optional(),
  location: z.string().max(500).optional(),
  start: instant,
  end: instant,
  timeZone: timeZone.optional(),
  allDay: z.boolean().optional(),
  reminderMinutesBefore: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(1440)]).optional(),
  attendees: z.array(attendee).max(200).optional(),
  availability: z.enum(["free", "tentative", "busy", "oof", "working_elsewhere"]).optional(),
  allowConflicts: z.boolean().optional(),
  recurrence: recurrence.nullable().optional(),
};
const calendarEventCreateFields = calendarEventFields;
const calendarEventUpdateFields = {
  calendarId: identifier,
  title: title.optional(),
  description: z.string().max(100_000).optional(),
  location: z.string().max(500).optional(),
  start: instant.optional(),
  end: instant.optional(),
  timeZone: timeZone.optional(),
  allDay: z.boolean().optional(),
  reminderMinutesBefore: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(1440)]).optional(),
  attendees: z.array(attendee).max(200).optional(),
  availability: z.enum(["free", "tentative", "busy", "oof", "working_elsewhere"]).optional(),
  allowConflicts: z.boolean().optional(),
  recurrence: recurrence.nullable().optional(),
  recurrenceSeriesId: identifier.optional(),
  recurrenceId: instant.optional(),
  recurrenceScope: recurrenceScope.optional(),
};

type SchemaShape = Record<string, z.ZodType>;
function strictObject(shape: SchemaShape): z.ZodType {
  return z.object(shape).strict();
}

function registerTool(
  server: McpServer,
  principal: AuthenticatedMcpToken,
  domain: McpDomainService,
  name: McpToolName,
  description: string,
  inputSchema: z.ZodType,
  annotations: typeof readAnnotations | typeof createAnnotations | typeof updateAnnotations | typeof destructiveAnnotations,
): void {
  if (!MCP_TOOL_NAMES.includes(name)) throw new Error(`Unsupported MCP protocol operation: ${name}`);
  if (!(mcpDomainOperationNames as readonly string[]).includes(name)) {
    throw new Error(`Unsupported MCP domain operation: ${name}`);
  }
  const register = server.registerTool as unknown as (
    toolName: string,
    config: { title: string; description: string; inputSchema: z.ZodType; annotations: typeof annotations },
    callback: (input: Record<string, unknown>) => Promise<unknown>,
  ) => unknown;
  register.call(server, name, { title: name, description, inputSchema, annotations }, async (input) => {
    const startedAt = Date.now();
    let outcome: "success" | "failure" = "success";
    let errorCode: string | undefined;
    try {
      if (isWriteTool(name) && (!principal.scopes.includes(WRITE_SCOPE) || principal.role === "viewer")) {
        errorCode = "permission_denied";
        outcome = "failure";
        return toolError(errorCode, "MCP API 令牌没有写入权限", false);
      }
      const contractError = validateMutationContract(name, input);
      if (contractError) {
        errorCode = contractError.code;
        outcome = "failure";
        return toolError(contractError.code, contractError.message, contractError.retryable, contractError.details);
      }
      const result = await (domain.execute as unknown as (operation: string, value: Record<string, unknown>) => Promise<unknown>)(name, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      const normalized = normalizeToolError(error);
      outcome = "failure";
      errorCode = normalized.code;
      return toolError(normalized.code, normalized.message, normalized.retryable, normalized.details);
    } finally {
      await recordAuditEvent({
        actorUserId: principal.userId,
        targetUserId: principal.userId,
        action: "mcp.tool",
        metadata: {
          tokenId: principal.tokenId,
          tool: name,
          outcome,
          durationMs: Date.now() - startedAt,
          errorCode: errorCode ?? null,
        },
      });
    }
  });
}

function isWriteTool(name: McpToolName): boolean {
  return (MCP_MUTATING_TOOL_NAMES as readonly string[]).includes(name);
}

function validateMutationContract(name: McpToolName, input: Record<string, unknown>): NormalizedToolError | undefined {
  if (!isWriteTool(name) || input.preview === true) return undefined;
  if (MUTATION_WITH_IDEMPOTENCY_KEY.has(name)) {
    const key = input.idempotencyKey;
    if (typeof key !== "string" || key.length < 16 || key.length > 160) {
      return { code: "invalid_input", message: "执行写操作时 idempotencyKey 必须为 16–160 个字符", retryable: false };
    }
  }
  if (MUTATION_WITH_EXPECTED_REVISION.has(name)) {
    const revision = input.expectedUpdatedAt;
    if (typeof revision !== "string" || !isValidInstant(revision)) {
      return { code: "invalid_input", message: "执行修改或删除时 expectedUpdatedAt 必填且必须是有效时间", retryable: false };
    }
  }
  return undefined;
}

function isValidInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function actorFor(principal: AuthenticatedMcpToken): AppUser {
  return {
    id: principal.userId,
    displayName: "MCP API",
    username: "mcp",
    email: "mcp@local.invalid",
    role: principal.role,
    sessionVersion: 0,
    mustChangePassword: false,
  };
}

function toolError(code: string, message: string, retryable: boolean, details?: Record<string, unknown>) {
  const error = { code, message, retryable, ...(details ? { details } : {}) };
  return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true };
}

interface NormalizedToolError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

function normalizeToolError(error: unknown): NormalizedToolError {
  if (error instanceof AuthError && error.status === 403) {
    return { code: "permission_denied", message: safeErrorMessage(error.message), retryable: false, details: { status: error.status } };
  }
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
    readonly conflicts?: unknown;
    readonly retryable?: unknown;
  } | null;
  if (candidate && typeof candidate === "object" && typeof candidate.name === "string" && candidate.name === "McpCalendarAvailabilityError") {
    return { code: "invalid_input", message: typeof candidate.message === "string" ? candidate.message : "日历空闲时间参数无效", retryable: false };
  }
  if (candidate && typeof candidate === "object" && typeof candidate.code === "string") {
    const status = typeof candidate.status === "number" ? candidate.status : undefined;
    const code = normalizedErrorCode(candidate.code, status);
    const details = safeErrorDetails(candidate.details, status, candidate.conflicts);
    return {
      code,
      message: safeErrorMessage(candidate.message),
      retryable: candidate.retryable === true || code === "operation_in_progress" || (status !== undefined && status >= 500),
      ...(details ? { details } : {}),
    };
  }
  if (error instanceof McpDomainInputError || error instanceof TaskValidationError) {
    const code = error instanceof McpDomainInputError ? domainInputErrorCode(error.message) : undefined;
    const status = typeof candidate?.status === "number" ? candidate.status : undefined;
    const details = safeErrorDetails(candidate?.details, status, candidate?.conflicts);
    return {
      code: code ?? "invalid_input",
      message: safeErrorMessage(error.message),
      retryable: false,
      ...(details ? { details } : {}),
    };
  }
  return { code: "internal_error", message: "MCP 工具执行失败", retryable: true };
}

function domainInputErrorCode(message: string): string | undefined {
  if (/日程.*冲突|安排冲突/.test(message)) return "schedule_conflict";
  if (/任务不存在/.test(message)) return "task_not_found";
  if (/日程不存在/.test(message)) return "event_not_found";
  if (/计划项不存在/.test(message)) return "plan_item_not_found";
  if (/笔记不存在/.test(message)) return "note_not_found";
  if (/关联不存在/.test(message)) return "relation_not_found";
  if (/日历不存在/.test(message)) return "calendar_not_found";
  return undefined;
}

function normalizedErrorCode(code: string, status?: number): string {
  const normalized = code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized.includes("idempot") || normalized.includes("duplicate")) return "idempotency_conflict";
  if (normalized.includes("version") || normalized.includes("revision") || normalized.includes("updated_at") || normalized.includes("cas")) return "version_conflict";
  if (
    (normalized.includes("schedule") && (status === 409 || normalized.includes("conflict")))
      || (normalized.includes("calendar") && normalized.includes("conflict"))
      || (normalized.includes("event") && normalized.includes("conflict"))
  ) return "schedule_conflict";
  return normalized || (status === 409 ? "conflict" : "internal_error");
}

function safeErrorMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /(?:password|secret|token|authorization|stack| at )/i.test(value)) {
    return "MCP 工具执行失败";
  }
  return value.trim().slice(0, 2_000);
}

function safeErrorDetails(value: unknown, status?: number, conflicts?: unknown): Record<string, unknown> | undefined {
  if ((!value || typeof value !== "object" || Array.isArray(value)) && !Array.isArray(conflicts)) return status === undefined ? undefined : { status };
  const source = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  const conflictDetails = safeConflictDetails(Array.isArray(conflicts) ? conflicts : source.conflicts);
  delete source.conflicts;
  const entries = Object.entries(source).flatMap(([key, entry]) => {
    if (/token|secret|header|authorization|stack|body|content/i.test(key)) return [];
    const safe = boundedSafeDetail(entry);
    return safe === undefined ? [] : [[key, safe] as const];
  });
  const details: Record<string, unknown> = Object.fromEntries(entries);
  if (conflictDetails) details.conflicts = conflictDetails;
  if (status !== undefined && details.status === undefined) details.status = status;
  return Object.keys(details).length ? details : undefined;
}

function boundedSafeDetail(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function safeConflictDetails(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const conflicts = value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const candidate = entry as Record<string, unknown>;
    const safe = Object.fromEntries(Object.entries(candidate).filter(([key, item]) => (
      ["id", "title", "start", "end"].includes(key)
        && boundedSafeDetail(item) !== undefined
    )).map(([key, item]) => [key, boundedSafeDetail(item)]));
    return Object.keys(safe).length ? [safe] : [];
  });
  return conflicts.length ? conflicts : undefined;
}

function bearerToken(value: string | null): string | undefined {
  return /^Bearer ([^\s]+)$/i.exec(value ?? "")?.[1];
}

function validateRequestTarget(request: Request): Response | undefined {
  const host = normalizedHostname(request.headers.get("host") ?? "");
  const allowedHosts = configuredValues("KALENDER_MCP_ALLOWED_HOSTS", normalizedHostname, DEFAULT_ALLOWED_HOSTS);
  if (!host || !allowedHosts.has(host)) return forbiddenResponse("MCP 请求 Host 不在允许列表中");

  const originHeader = request.headers.get("origin");
  if (!originHeader) return undefined;
  const origin = normalizedOrigin(originHeader);
  const allowedOrigins = configuredValues("KALENDER_MCP_ALLOWED_ORIGINS", normalizedOrigin);
  return origin && allowedOrigins.has(origin)
    ? undefined
    : forbiddenResponse("MCP 请求 Origin 不在允许列表中");
}

function configuredValues(
  name: string,
  normalize: (value: string) => string | undefined,
  fallback: readonly string[] = [],
): ReadonlySet<string> {
  const configured = process.env[name]?.split(",") ?? fallback;
  return new Set(configured.map(normalize).filter((value): value is string => Boolean(value)));
}

function normalizedHostname(value: string): string | undefined {
  let host = value.trim().toLowerCase();
  if (!host || host.length > 255 || /[\s/@]/.test(host)) return undefined;
  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    if (closingBracket < 0 || (host.slice(closingBracket + 1) && !/^:\d+$/.test(host.slice(closingBracket + 1)))) return undefined;
    host = host.slice(1, closingBracket);
  } else if (isIP(host) === 0) {
    const port = /:\d+$/.exec(host);
    if (port) host = host.slice(0, -port[0].length);
  }
  return isIP(host) !== 0 || (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !host.includes("..")) ? host : undefined;
}

function normalizedOrigin(value: string): string | undefined {
  if (!value || value.length > 2_000) return undefined;
  try {
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return undefined;
    return origin.origin;
  } catch {
    return undefined;
  }
}

function forbiddenResponse(message: string): Response {
  return new Response(JSON.stringify({ error: { code: "forbidden", message, retryable: false } }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestIpAddress(request: Request): string | undefined {
  if (process.env.KALENDER_MCP_TRUST_PROXY_IP_HEADERS !== "true") return undefined;
  const realIp = request.headers.get("x-real-ip");
  if (realIp !== null) return normalizedIp(realIp);
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor || forwardedFor.length > 512) return undefined;
  return normalizedIp(forwardedFor.split(",").at(-1) ?? "");
}

function normalizedIp(value: string): string | undefined {
  const ip = value.trim();
  return ip.length <= 45 && isIP(ip) !== 0 ? ip : undefined;
}

function configuredLimit(name: string): number | undefined {
  const value = process.env[name];
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function safeAuthenticationMessage(error: McpTokenError): string {
  return error.status === 429
    ? "MCP API 请求过多"
    : error.status === 403
      ? "MCP API 令牌没有所需权限"
      : "MCP API 令牌无效或已过期";
}

function authenticationResponse(status: number, message: string, rateLimit?: McpTokenRateLimitResult): Response {
  return withRateLimitHeaders(new Response(JSON.stringify({
    error: { code: status === 429 ? "rate_limited" : "unauthorized", message, retryable: status === 429 },
  }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Bearer realm="dayline-mcp"',
    },
  }), rateLimit);
}

function withRateLimitHeaders(response: Response, rateLimit?: McpTokenRateLimitResult): Response {
  if (!rateLimit) return response;
  const headers = new Headers(response.headers);
  headers.set("x-ratelimit-limit", String(rateLimit.limit));
  headers.set("x-ratelimit-remaining", String(rateLimit.remaining));
  headers.set("x-ratelimit-reset", rateLimit.retryAt);
  if (!rateLimit.allowed) headers.set("retry-after", String(rateLimit.retryAfterSeconds));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
