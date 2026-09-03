# Dayline MCP Server

Dayline exposes a stateless Streamable HTTP MCP endpoint at
`https://<host>/mcp`. Each request creates a fresh server and transport, so an
MCP client does not need to retain a session ID. The endpoint is a bounded
workspace API: tools do not execute arbitrary SQL, call arbitrary URLs, or
open an external network connection.

## Authentication and scope

Use HTTPS for every remote MCP client. `/mcp` accepts only
`Authorization: Bearer dln_...`; browser cookies, including `qgw_session`, are
never a fallback. Create a token from the MCP token management API/UI while
signed in. The secret is shown once, stored only as a hash, and can be revoked
at any time. Expired, revoked, disabled-account, malformed, and unknown tokens
return HTTP `401` with a `WWW-Authenticate: Bearer` challenge.

Every token must have `dayline:read`. A non-viewer account may additionally be
given `dayline:write`. A read-only token and a viewer token are denied every
mutating tool before the domain operation runs. Object ownership and shared
project membership are checked again by the domain service for each call; an
administrator token does not grant implicit access to another user's private
objects. The MCP actor context treats an administrator token as an ordinary
owner-scoped user for domain access, so an administrator token and an outsider
token both receive the stable `permission_denied` error for another owner's
private plan-item list/get calls.

## Frozen tool registry

`tools/list` exposes exactly these 34 tools, in this order. Every tool has
`openWorldHint: false`; reads have `readOnlyHint: true`, and only the five
tools in the destructive group have `destructiveHint: true`.

The ordered registry is:

```text
dayline_search
dayline_today_get
dayline_tasks_list
dayline_task_get
dayline_task_create
dayline_task_update
dayline_projects_list
dayline_project_get
dayline_task_schedule
dayline_notes_search
dayline_project_plan_items_list
dayline_project_plan_item_get
dayline_project_plan_item_create
dayline_project_plan_item_update
dayline_project_plan_item_delete
dayline_task_plan_item_link
dayline_task_plan_item_unlink
dayline_note_get
dayline_note_create
dayline_note_update
dayline_note_append
dayline_note_delete
dayline_calendars_list
dayline_calendar_events_list
dayline_calendar_free_slots
dayline_task_reschedule
dayline_task_schedule_cancel
dayline_project_next_actions
dayline_relations_list
dayline_relation_link
dayline_relation_unlink
dayline_calendar_event_create
dayline_calendar_event_update
dayline_calendar_event_delete
```

Read tools (15):

- `dayline_search`, `dayline_today_get`, `dayline_tasks_list`,
  `dayline_task_get`, `dayline_projects_list`, `dayline_project_get`,
  `dayline_notes_search`
- `dayline_project_plan_items_list`, `dayline_project_plan_item_get`,
  `dayline_note_get`
- `dayline_calendars_list`, `dayline_calendar_events_list`,
  `dayline_calendar_free_slots`, `dayline_project_next_actions`,
  `dayline_relations_list`

Ordinary write tools (14):

- `dayline_task_create`, `dayline_task_update`, `dayline_task_schedule`
- `dayline_project_plan_item_create`, `dayline_project_plan_item_update`
- `dayline_task_plan_item_link`, `dayline_task_plan_item_unlink`
- `dayline_note_create`, `dayline_note_update`, `dayline_note_append`
- `dayline_task_reschedule`, `dayline_relation_link`
- `dayline_calendar_event_create`, `dayline_calendar_event_update`

Destructive tools (5):

- `dayline_project_plan_item_delete`, `dayline_note_delete`,
  `dayline_task_schedule_cancel`, `dayline_relation_unlink`,
  `dayline_calendar_event_delete`

The 14 ordinary writes plus these five destructive tools are the complete 19
mutation matrix. Execution safety is fixed as follows:

- Required `idempotencyKey` (16–160 characters):
  `dayline_task_create`, `dayline_task_schedule`,
  `dayline_project_plan_item_create`, `dayline_note_create`,
  `dayline_relation_link`, and `dayline_calendar_event_create`.
- Required `expectedUpdatedAt`: task/plan updates, task-plan link/unlink, note
  update/append/delete, task reschedule, plan-item delete, task schedule
  cancel, and calendar-event update/delete (12 tools).
- `dayline_relation_unlink` is the revision exception: it uses the immutable
  `linkId`; its idempotency key is optional.
- Every mutation accepts `preview: true`, which bypasses both execution-key
  and revision requirements and never consumes an idempotency key.

Create/schedule and destructive tools advertise `idempotentHint: true`;
ordinary update/link/reschedule tools advertise `idempotentHint: false`.

The protocol schemas are strict objects (`additionalProperties: false`).
Unknown fields are rejected before a domain operation runs. Identifiers are
non-empty bounded strings; timestamps are RFC 3339 date-time values. Enum
values are part of the published schema rather than free-form strings.

## Domain coverage

Project plan item tools expose the complete plan shape: `id`, `projectId`,
`planItemId`, `phaseId`, `title`, `status`, `plannedStart`, `plannedEnd`,
`sortOrder`, `durationWorkdays`, `autoSchedule`, `dependencyIds`, linked and
completed task counts, and created/updated timestamps. Status is one of
`planned`, `in_progress`, `paused`, `done`, or `cancelled`. Plan dependencies
are project-local and the domain rejects self-links and cycles.

Task-plan link/unlink operations are scoped by task, project, and plan item.
Linking requires the same project; unlinking identifies the task being changed.

Notes returned through MCP contain only portable plain text or Markdown. The
editor's `plate-json-v1:` storage representation is never accepted or returned.
`dayline_note_append` preserves the existing text and inserts a paragraph
break. Note create/update/append/delete honor the write safety envelope.

Calendar event schemas include ordinary fields: calendar, title, description,
location, start/end, time zone, all-day flag, reminders, attendees,
availability, `allowConflicts`, and recurrence fields where applicable.
`allowConflicts` defaults to false; set it explicitly only when the caller has
confirmed that overlapping events are intentional. Availability is the closed
enum `free`, `tentative`, `busy`, `oof`, or `working_elsewhere`.
`dayline_calendar_events_list` requires a bounded `from`/`to` range, while
`dayline_calendar_free_slots` additionally accepts `calendarIds`,
`minimumDurationMinutes` (default 30, bounded to 1–1440), and an optional time
zone. Its range must be no more than 366 days. Each result is a bounded object
with exactly `status: "free"`, `availability: "free"`, `blockers: []`,
`start`, `end`, and integer `durationMinutes`; cancelled events and events
whose availability is not `free` are excluded.

`dayline_task_schedule` creates a task focus-time block. `allowConflicts` is
also accepted by schedule/reschedule and defaults to false. The reschedule and
schedule-cancel tools address an existing block by both `taskId` and
`eventId`; cancellation leaves the task itself intact. `dayline_project_next_actions`
returns objects with `taskId`, `title`, `state`, `priority`, `scheduleStatus`,
optional `estimatedMinutes`, `scheduledBlocks`, and `blockedReasons`. `state`
is exactly `ready` or `blocked`; `priority` is exactly `urgent`, `important`,
or `normal`; `scheduleStatus` is exactly `scheduled` or `unscheduled`; each
scheduled block has only `eventId`, `start`, and `end`. Blocker reasons are
sorted strings from this closed set: `task_status_inbox`,
`task_status_waiting`, `task_status_someday`, `project_not_active`,
`plan_item_paused`, `plan_item_cancelled`, `plan_item_done`, and
`dependency_not_done:<planItemId>`. Completed tasks are omitted. Task priority
is derived from the closed `urgencyMode` enum `auto`, `urgent`, or `not_urgent`
plus the `important` boolean. Relation tools use entity kinds `mail`,
`calendar`, `task`, `note`, and `project`.

## Preview, idempotency, and revisions

All mutating tools accept `preview?: boolean`. A preview returns a structured
preview with the same shape: `preview: true`, `before`, `after`, `warnings`,
and `conflicts`; `currentRevision` is included when the target has an
`updatedAt` revision. Create previews therefore use `before: null` and omit
`currentRevision`, while target previews report the current revision. The
preview performs no domain mutation: task, plan, note, calendar-event,
relation, and idempotency-action row counts remain unchanged (the normal MCP
audit metadata for the invocation is still recorded). `warnings` and
`conflicts` are arrays; the latter contains only safe bounded conflict
summaries. `preview: true` is evaluated before execution-contract checks, so it
does not require or consume an idempotency key or `expectedUpdatedAt`, including
for update and destructive tools. Preview and execution use the same
side-effect-free domain preflight for object existence, actor/project access,
archived projects, plan phases and dependencies, task time-block ownership,
calendar writability/provider restrictions, remote-event mutation safety, and
recurrence rules. The preflight does not call a remote calendar provider.
Schedule conflicts are the intentional exception: preview returns them as
`schedule_conflict` warnings, while execution rejects them unless
`allowConflicts: true` is supplied.

An executing create or schedule operation supplies an `idempotencyKey` of
16–160 characters. The key is scoped to the authenticated actor and operation
input; retrying the same operation with the same key returns the original
result, while reusing it for different input returns `idempotency_conflict`.
Calendar-event create replay returns the first event before conflict checking,
so an identical same-key retry is not a `schedule_conflict`; changing any
operation input under that key is an `idempotency_conflict`.
The key is required for task/plan/note/calendar-event/relation creation and
task scheduling. Update/delete/link operations may also supply a key when a
client wants durable replay protection, but their required safety check is the
compare-and-set revision described below.

Idempotency input is stored only as a salted SHA-256 fingerprint. The replay
result is retained for 24 hours and then removed by the hourly cleanup sweep
(expired rows are also removed before each idempotent write). A
`running` record older than 10 minutes is changed to an unknown-outcome failure;
the same key then returns `operation_outcome_unknown` instead of risking a
duplicate write. Verify the target object before retrying with a new key.

The task, project, project-plan-item, and relation list tools accept `limit`
from 1 to 100. They default to 20 results so a growing workspace cannot create
an unbounded MCP response.

Update and delete operations also use compare-and-set revision protection:
`expectedUpdatedAt` must equal the latest returned `updatedAt`. This applies to
task/plan updates, task-plan link/unlink, note update/append/delete, task
reschedule, task schedule cancel, and calendar event update/delete. A stale
revision returns `version_conflict`. Relation unlink is the exception: it uses
the immutable `linkId` (and does not guess a link from mutable entity fields).

For the stable not-found/CAS matrix, plan-item update/delete use
`plan_item_not_found` or `version_conflict`; note update/append/delete use
`note_not_found` or `version_conflict`; and calendar-event update/delete use
`event_not_found` or `version_conflict`. These codes are returned as MCP tool
errors after the request schema has been accepted.

## Errors and audit

Tool failures are returned as an MCP tool error whose text is JSON with this
shape:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "对象已被更新，请读取最新版本后重试",
    "retryable": false,
    "details": { "status": 409 }
  }
}
```

The protocol normalizes domain and repository failures to
`code`/`message`/`retryable`/optional `details`. In particular, HTTP-409
version, idempotency, unknown-outcome, and schedule/calendar conflicts remain observable as
`version_conflict`, `idempotency_conflict`, `operation_outcome_unknown`, and `schedule_conflict`; schedule
conflict details may include at most 20 summaries containing only `id`,
`title`, `start`, and `end`. Unknown failures use the generic `internal_error`
message and never expose a stack.

Each tool invocation writes only this metadata to the MCP audit event:
`tokenId`, `tool`, `outcome`, `durationMs`, and `errorCode`. Token secrets,
Authorization headers, request bodies, complete note/event contents, and stack
traces are not written to the audit metadata.

Destructive tools are irreversible from the MCP client's point of view:
project-plan-item delete, note delete, task schedule cancel, relation unlink,
and calendar-event delete. Before calling one, read the current object, show
the user the exact target, send its current `expectedUpdatedAt` (or immutable
relation `linkId`), and use `preview: true` for a dry run when possible.
Deleting a note, plan item, or calendar event invokes the domain relation
cleanup for that entity. Cancelling a task schedule removes its associated time
block while leaving the task itself intact. Relation unlink removes only the
selected link by immutable `linkId`.

## Rate limits and Codex configuration

The defaults are 120 authenticated requests per token per minute and 20
invalid-token requests per minute in one stable anonymous bucket. By default
Dayline does not trust `X-Real-IP` or `X-Forwarded-For`, so a caller cannot
bypass the invalid-token limit by forging or rotating those headers. Configure
the limits with `KALENDER_MCP_TOKEN_REQUESTS_PER_MINUTE` and
`KALENDER_MCP_INVALID_TOKEN_REQUESTS_PER_MINUTE`. A limited request returns
`429` with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset` headers.

If Dayline is behind a trusted reverse proxy that overwrites and normalizes
client IP headers, set `KALENDER_MCP_TRUST_PROXY_IP_HEADERS=true`. Only a
syntactically valid, at-most-45-character `X-Real-IP` is used; when it is
absent, the final (rightmost) `X-Forwarded-For` value is considered. Invalid
or oversized values remain in the anonymous bucket. Do not enable this setting
unless the proxy removes client-supplied values before forwarding requests.

Every MCP request also validates its HTTP `Host` and, when present, `Origin`.
`KALENDER_MCP_ALLOWED_HOSTS` is a comma-separated, port-agnostic hostname/IP
allowlist and defaults to `localhost,127.0.0.1,::1`. Add the public reverse
proxy hostname before enabling remote access. `KALENDER_MCP_ALLOWED_ORIGINS`
is a comma-separated list of exact HTTP(S) origins such as
`https://client.example.com`; when it is unset, requests carrying an `Origin`
header are rejected. CLI clients normally omit `Origin` and need no origin
entry. Keep both lists exact; wildcards are intentionally unsupported.

Store the token in a secret environment variable, then add this to
`~/.codex/config.toml`:

```toml
[mcp_servers.dayline]
url = "https://dayline.example.com/mcp"
bearer_token_env_var = "DAYLINE_MCP_TOKEN"
```

Use an HTTPS reverse proxy with a valid certificate, restrict network access as
appropriate, and rotate/revoke the token immediately if it is disclosed.
