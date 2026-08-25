import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kalender-caldav-test-"));
process.env.KALENDER_DATA_DIR = temporaryRoot;
process.env.KALENDER_MASTER_KEY = Buffer.alloc(32, 1).toString("base64");

try {
  const {
    parseCalendarDiscoveryResponse,
    parseCalendarEventResponse,
    parseCalDavCredential,
  } = await import("./caldav-client");
  const {
    deleteCalendarAccount,
    listCalendarAccounts,
    loadCalDavCredential,
    saveCalDavAccount,
    saveCalDavEvents,
    saveDiscoveredCalendar,
    updateCalendarAccountSettings,
  } = await import("./calendar-account-repository");
  const { deleteStoredCalendarEvent, listStoredCalendarEvents, listStoredCalendars } = await import("./calendar-repository");
  const { getDatabase } = await import("./database");

  const credential = parseCalDavCredential({
    serverUrl: "https://calendar.example.test/dav/",
    username: "adam@example.test",
    password: "not-a-real-password",
  });
  assert(credential.serverUrl === "https://calendar.example.test/dav/", "CalDAV credential URL is normalized");

  const discoveryXml = `<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
      <d:response><d:href>/dav/calendars/adam/work/</d:href><d:propstat><d:prop>
        <d:displayname>工作日历</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <a:calendar-color>#F0A05EFF</a:calendar-color>
        <d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>
      </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/calendars/adam/</d:href><d:propstat><d:prop>
        <d:displayname>主页</d:displayname><d:resourcetype><d:collection/></d:resourcetype>
      </d:prop></d:propstat></d:response>
    </d:multistatus>`;
  const discovered = parseCalendarDiscoveryResponse(discoveryXml, "https://calendar.example.test/");
  assert(discovered.length === 1, "only CalDAV calendar collections are discovered");
  assert(discovered[0]?.name === "工作日历", "calendar display name is parsed");
  assert(discovered[0]?.color === "#F0A05E", "eight-digit calendar color is normalized");
  assert(discovered[0]?.readOnly === false, "write privilege is detected");

  const eventXml = `<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
      <d:href>/dav/calendars/adam/work/review.ics</d:href><d:propstat><d:prop>
        <d:getetag>&quot;etag-1&quot;</d:getetag>
        <c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:review-1\r\nDTSTART;TZID=Europe/Berlin:20260720T093000\r\nDTEND;TZID=Europe/Berlin:20260720T103000\r\nSUMMARY:产品评审\r\nDESCRIPTION:检查演示\\n准备资料\r\nLOCATION:会议室 A\r\nATTENDEE;CN=Anna:mailto:anna@example.test\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:holiday-1\r\nDTSTART;VALUE=DATE:20260721\r\nDTEND;VALUE=DATE:20260722\r\nSUMMARY:全天安排\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data>
      </d:prop></d:propstat></d:response></d:multistatus>`;
  const parsedEvents = parseCalendarEventResponse(eventXml, discovered[0]!.url);
  assert(parsedEvents.length === 2, "VEVENT blocks are parsed");
  assert(parsedEvents[0]?.start === "2026-07-20T07:30:00.000Z", "Europe/Berlin summer time is converted to UTC");
  assert(parsedEvents[0]?.attendees[0]?.address === "anna@example.test", "attendee mailto is parsed");
  assert(parsedEvents[1]?.allDay === true, "all-day event is detected");

  const account = await saveCalDavAccount("工作日历", credential);
  const restored = await loadCalDavCredential(account.id);
  assert(restored.password === credential.password, "encrypted CalDAV credential round trip");
  const database = await getDatabase();
  const encrypted = await database.query<{ encrypted_payload: string }>(
    "SELECT encrypted_payload FROM calendar_encrypted_credentials WHERE account_id = $1",
    [account.id],
  );
  assert(!encrypted.rows[0]?.encrypted_payload.includes(credential.password), "CalDAV password is not stored in plaintext");

  const calendarId = await saveDiscoveredCalendar(account.id, discovered[0]!, true);
  await saveCalDavEvents(calendarId, parsedEvents, "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  const calendars = await listStoredCalendars();
  assert(calendars.some((calendar) => calendar.id === calendarId && calendar.providerData?.providerId === "caldav"), "CalDAV calendar is stored with provider identity");
  const customizedAccount = await updateCalendarAccountSettings(account.id, {
    displayName: "自定义工作日历",
    color: "#c7a6f2",
  });
  assert(customizedAccount?.displayName === "自定义工作日历", "calendar account name can be customized locally");
  assert(customizedAccount?.color === "#c7a6f2" && customizedAccount.colorOverride === "#c7a6f2", "calendar account color override is stored");
  const customizedCalendars = await listStoredCalendars();
  assert(customizedCalendars.some((calendar) => calendar.id === calendarId && calendar.name === "自定义工作日历"), "user-defined account name replaces remote calendar name");
  assert(customizedCalendars.some((calendar) => calendar.id === calendarId && calendar.color === "#c7a6f2"), "calendar color override is applied to indexed calendars");
  const storedEvents = await listStoredCalendarEvents({
    calendarIds: [calendarId],
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-08-01T00:00:00.000Z",
  });
  assert(storedEvents.length === 2, "CalDAV events are indexed locally");

  let readOnlyProtected = false;
  try {
    await deleteStoredCalendarEvent(calendarId, storedEvents[0]!.id);
  } catch (error) {
    readOnlyProtected = error instanceof Error && error.message.includes("schreibgeschützt");
  }
  assert(readOnlyProtected, "remote calendar events cannot be deleted during read-only phase");
  assert((await listCalendarAccounts()).length === 1, "saved CalDAV account is listed");
  assert(await deleteCalendarAccount(account.id), "CalDAV account can be deleted with its local index");

  console.log("CalDAV parser and storage tests passed");
  await database.close();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
