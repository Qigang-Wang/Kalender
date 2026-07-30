import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kalender-ics-test-"));
  process.env.KALENDER_DATA_DIR = temporaryRoot;
  process.env.KALENDER_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
  try {
    const {
      parseIcsSubscriptionContent,
      parseIcsSubscriptionCredential,
      safeIcsSubscriptionLabel,
    } = await import("./ics-subscription");
    const {
      deleteCalendarAccount,
      listCalendarAccounts,
      loadIcsSubscriptionCredential,
      saveCalDavEvents,
      saveIcsSubscription,
      saveIcsSubscriptionCalendar,
    } = await import("./calendar-account-repository");
    const { listStoredCalendarEvents, listStoredCalendars } = await import("./calendar-repository");
    const { getDatabase } = await import("./database");

    const secretUrl = "https://calendar.example.test/published/secret-token/calendar.ics";
    const credential = parseIcsSubscriptionCredential({ feedUrl: secretUrl });
    assert(credential.feedUrl === secretUrl, "ICS HTTPS URL is normalized");
    assert(parseIcsSubscriptionCredential({ feedUrl: "webcal://calendar.example.test/feed.ics" }).feedUrl.startsWith("https://"), "webcal URL is upgraded to HTTPS");
    assert(!safeIcsSubscriptionLabel(secretUrl).includes("secret-token"), "display URL hides secret path tokens");

    const content = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:RWTH Termine\r\nBEGIN:VEVENT\r\nUID:lecture-1\r\nDTSTART;TZID=Europe/Berlin:20260720T100000\r\nDTEND;TZID=Europe/Berlin:20260720T110000\r\nSUMMARY:Vorlesung\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const snapshot = parseIcsSubscriptionContent(content, "source-1", "etag-1");
    assert(snapshot.calendarName === "RWTH Termine", "calendar name is parsed");
    assert(snapshot.events.length === 1, "ICS events are parsed");
    assert(snapshot.events[0]?.title === "Vorlesung", "ICS event title is parsed");

    const recurring = parseIcsSubscriptionContent(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly-1\r\nDTSTART:20260701T080000Z\r\nDTEND:20260701T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE:20260708T080000Z\r\nSUMMARY:Weekly seminar\r\nEND:VEVENT\r\nEND:VCALENDAR",
      "source-recurring",
      undefined,
      undefined,
      { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
    );
    assert(recurring.events.length === 2, "recurring ICS events are expanded and exclusions are respected");
    assert(recurring.events[1]?.start === "2026-07-15T08:00:00.000Z", "recurring occurrence time is correct");

    const account = await saveIcsSubscription("学校日历", credential);
    const restored = await loadIcsSubscriptionCredential(account.id);
    assert(restored.feedUrl === secretUrl, "encrypted ICS URL round trip succeeds");
    const database = await getDatabase();
    const storedAccount = await database.query<{ server_url: string; username: string }>(
      "SELECT server_url, username FROM calendar_accounts WHERE id = $1",
      [account.id],
    );
    assert(!storedAccount.rows[0]?.server_url.includes("secret-token"), "secret ICS URL is not stored in account metadata");
    const encrypted = await database.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM calendar_encrypted_credentials WHERE account_id = $1",
      [account.id],
    );
    assert(!encrypted.rows[0]?.encrypted_payload.includes("secret-token"), "secret ICS URL is encrypted at rest");

    const calendarId = await saveIcsSubscriptionCalendar(account.id, snapshot.calendarName!, safeIcsSubscriptionLabel(secretUrl), account.color);
    await saveCalDavEvents(calendarId, snapshot.events, "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    const calendars = await listStoredCalendars();
    assert(calendars.some((calendar) => calendar.id === calendarId && calendar.providerData?.providerId === "ics" && calendar.readOnly), "ICS calendar is stored as read-only");
    assert(calendars.some((calendar) => calendar.id === calendarId && calendar.name === "学校日历"), "user-defined ICS account name replaces the feed calendar name");
    const events = await listStoredCalendarEvents({ calendarIds: [calendarId], from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });
    assert(events.length === 1, "ICS event is indexed locally");
    assert((await listCalendarAccounts())[0]?.providerId === "ics", "ICS subscription is listed");
    assert(await deleteCalendarAccount(account.id), "ICS subscription can be removed locally");

    console.log("ICS subscription parser and storage tests passed");
    await database.close();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
