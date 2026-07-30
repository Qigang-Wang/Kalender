import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kalender-exchange-test-"));
  process.env.KALENDER_DATA_DIR = temporaryRoot;
  process.env.KALENDER_MASTER_KEY = Buffer.alloc(32, 2).toString("base64");

  try {
    const {
      parseExchangeCalendarCredential,
      parseExchangeEventsResponse,
      parseExchangeFolderResponse,
      RWTH_EWS_URL,
    } = await import("./exchange-calendar");
    const {
      deleteCalendarAccount,
      listCalendarAccounts,
      loadExchangeCalendarCredential,
      saveExchangeCalendar,
      saveExchangeCalendarAccount,
      saveExchangeCalendarEvents,
    } = await import("./calendar-account-repository");
    const { listStoredCalendarEvents, listStoredCalendars } = await import("./calendar-repository");
    const { getDatabase } = await import("./database");

    const credential = parseExchangeCalendarCredential({
      providerId: "exchange",
      username: "ab123456@rwth-aachen.de",
      password: "not-a-real-password",
    });
    assert(credential.serverUrl === RWTH_EWS_URL, "RWTH EWS endpoint is the default");

    const folderXml = `<?xml version="1.0"?>
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
        <s:Body><m:GetFolderResponse><m:ResponseMessages><m:GetFolderResponseMessage ResponseClass="Success">
          <m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:CalendarFolder>
            <t:FolderId Id="folder-1&amp;safe" ChangeKey="folder-key-1"/><t:DisplayName>Kalender</t:DisplayName>
          </t:CalendarFolder></m:Folders>
        </m:GetFolderResponseMessage></m:ResponseMessages></m:GetFolderResponse></s:Body>
      </s:Envelope>`;
    const folder = parseExchangeFolderResponse(folderXml);
    assert(folder.folderId === "folder-1&safe", "Exchange folder id is decoded");
    assert(folder.name === "Kalender", "Exchange calendar display name is parsed");

    const eventsXml = `<?xml version="1.0"?>
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
        <s:Body><m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success">
          <m:ResponseCode>NoError</m:ResponseCode><m:RootFolder IncludesLastItemInRange="true"><t:Items>
            <t:CalendarItem><t:ItemId Id="event-1" ChangeKey="event-key-1"/><t:Subject>产品评审 &amp; 演示</t:Subject><t:Body BodyType="Text">准备演示并确认下一步</t:Body><t:LastModifiedTime>2026-07-22T08:00:00Z</t:LastModifiedTime>
              <t:Start>2026-07-23T07:30:00Z</t:Start><t:End>2026-07-23T08:30:00Z</t:End>
              <t:IsAllDayEvent>false</t:IsAllDayEvent><t:IsCancelled>false</t:IsCancelled><t:Location>会议室 A</t:Location>
              <t:LegacyFreeBusyStatus>Tentative</t:LegacyFreeBusyStatus>
              <t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Anna</t:Name><t:EmailAddress>anna@example.test</t:EmailAddress></t:Mailbox></t:Attendee></t:RequiredAttendees>
            </t:CalendarItem>
            <t:CalendarItem><t:ItemId Id="event-2"/><t:Subject>全天安排</t:Subject>
              <t:Start>2026-07-24T00:00:00Z</t:Start><t:End>2026-07-25T00:00:00Z</t:End>
              <t:IsAllDayEvent>true</t:IsAllDayEvent><t:IsCancelled>false</t:IsCancelled><t:LegacyFreeBusyStatus>OOF</t:LegacyFreeBusyStatus>
            </t:CalendarItem>
          </t:Items></m:RootFolder>
        </m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse></s:Body>
      </s:Envelope>`;
    const events = parseExchangeEventsResponse(eventsXml, credential.serverUrl);
    assert(events.length === 2, "Exchange calendar items are parsed");
    assert(events[0]?.title === "产品评审 & 演示", "XML entities in subjects are decoded");
    assert(events[0]?.description === "准备演示并确认下一步", "Exchange calendar body is parsed as event description");
    assert(events[0]?.status === "tentative", "tentative status is retained");
    assert(events[0]?.availability === "tentative", "tentative availability is retained");
    assert(events[0]?.attendees[0]?.address === "anna@example.test", "Exchange attendees are parsed");
    assert(events[1]?.allDay === true, "Exchange all-day events are detected");
    assert(events[1]?.availability === "oof", "Exchange out-of-office availability is retained");

    const account = await saveExchangeCalendarAccount("RWTH 日历", credential);
    const restored = await loadExchangeCalendarCredential(account.id);
    assert(restored.password === credential.password, "encrypted Exchange credential round trip succeeds");
    const database = await getDatabase();
    const encrypted = await database.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM calendar_encrypted_credentials WHERE account_id = $1",
      [account.id],
    );
    assert(!encrypted.rows[0]?.encrypted_payload.includes(credential.password), "Exchange password is not stored in plaintext");

    const calendarId = await saveExchangeCalendar(account.id, folder, credential.serverUrl, account.color);
    await saveExchangeCalendarEvents(calendarId, events, "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    const calendars = await listStoredCalendars();
    assert(calendars.some((calendar) => calendar.id === calendarId && calendar.providerData?.providerId === "exchange" && !calendar.readOnly), "Exchange calendar is stored as a writable provider");
    assert(calendars.some((calendar) => calendar.id === calendarId && calendar.name === "RWTH 日历"), "user-defined Exchange account name replaces the remote folder name");
    const storedEvents = await listStoredCalendarEvents({ calendarIds: [calendarId], from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });
    assert(storedEvents.length === 2, "Exchange events are indexed locally");
    assert(storedEvents[0]?.description === "准备演示并确认下一步", "Exchange event body is persisted locally");
    assert(storedEvents[0]?.providerData?.itemId === "event-1" && storedEvents[0]?.providerData?.changeKey === "event-key-1", "Exchange mutation identity is persisted locally");
    assert(storedEvents[0]?.providerData?.providerId === "exchange", "stored Exchange event keeps provider identity");
    assert((await listCalendarAccounts())[0]?.providerId === "exchange", "Exchange account is listed");
    assert(await deleteCalendarAccount(account.id), "Exchange account can be removed with its local index");

    console.log("Exchange calendar parser and storage tests passed");
    await database.close();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
