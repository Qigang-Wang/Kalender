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
    await database.query("UPDATE calendar_events SET reminder_minutes_before = 30 WHERE id = $1", [storedEvents[0]!.id]);
    await saveExchangeCalendarEvents(calendarId, events, "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    const resyncedEvents = await listStoredCalendarEvents({ calendarIds: [calendarId], from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });
    assert(resyncedEvents.find((event) => event.id === storedEvents[0]!.id)?.reminderMinutesBefore === 30, "Exchange sync preserves local reminder overrides");
    const { upsertCalendarEvent, deleteCalendarEvent, validateCalendarEventDelete, validateCalendarEventUpsert } = await import("./calendar-event-service");
    const originalFetch = globalThis.fetch;
    let soapCallCount = 0;
    const updateResponse = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:UpdateItemResponse><m:ResponseMessages><m:UpdateItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:CalendarItem><t:ItemId Id="event-1" ChangeKey="event-key-2"/></t:CalendarItem></m:Items></m:UpdateItemResponseMessage></m:ResponseMessages></m:UpdateItemResponse></s:Body></s:Envelope>`;
    const getResponse = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:CalendarItem><t:ItemId Id="event-1" ChangeKey="event-key-2"/><t:Subject>产品评审更新</t:Subject><t:Body BodyType="Text">更新后的描述</t:Body><t:Start>2026-07-23T07:30:00Z</t:Start><t:End>2026-07-23T08:30:00Z</t:End><t:IsAllDayEvent>false</t:IsAllDayEvent><t:IsCancelled>false</t:IsCancelled><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus></t:CalendarItem></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse></s:Body></s:Envelope>`;
    try {
      globalThis.fetch = (async (_request, init) => {
        soapCallCount += 1;
        const body = String(init?.body);
        return new Response(body.includes("UpdateItem") ? updateResponse : body.includes("GetItem") ? getResponse : "", { status: 200 });
      }) as typeof fetch;
      const target = resyncedEvents[0]!;
      const updated = await upsertCalendarEvent({ id: target.id, calendarId, title: "产品评审更新", description: "更新后的描述", start: target.start, end: target.end, expectedUpdatedAt: target.updatedAt });
      assert(soapCallCount === 2 && updated.providerData?.itemId === "event-1" && updated.providerData?.changeKey === "event-key-2", "REQ-MCP-EXCHANGE-01 successful Exchange update carries old itemId to a new changeKey");
      globalThis.fetch = (async () => { soapCallCount += 1; throw new Error("SOAP must not be reached by a rejected local mutation"); }) as typeof fetch;
      soapCallCount = 0;
      await validateCalendarEventUpsert({ id: updated.id, calendarId, title: updated.title, start: updated.start, end: updated.end });
      await validateCalendarEventDelete(calendarId, updated.id);
      assert(soapCallCount === 0, "REQ-MCP-PREVIEW-02 Exchange preflight validates cached state without a SOAP/network call");
      const rejected = async (operation: () => Promise<unknown>, label: string) => {
        let failed = false;
        try { await operation(); } catch { failed = true; }
        assert(failed && soapCallCount === 0, `${label} rejects before any SOAP/network call`);
      };
      await rejected(() => upsertCalendarEvent({ id: updated.id, calendarId, title: updated.title, start: updated.start, end: updated.end, expectedUpdatedAt: "2000-01-01T00:00:00.000Z" }), "stale Exchange update");
      await rejected(() => upsertCalendarEvent({ id: updated.id, calendarId, title: updated.title, start: updated.start, end: updated.end }), "missing Exchange update revision");
      await rejected(() => deleteCalendarEvent(calendarId, updated.id, undefined, "2000-01-01T00:00:00.000Z"), "stale Exchange delete");
      await rejected(() => deleteCalendarEvent(calendarId, updated.id), "missing Exchange delete revision");
      await rejected(() => upsertCalendarEvent({ id: updated.id, calendarId, title: updated.title, start: updated.start, end: updated.end, recurrenceSeriesId: "series" }), "recurrence-input Exchange update");
      await database.query("UPDATE calendar_events SET provider_item_id = NULL, updated_at = now() WHERE id = $1", [updated.id]);
      const missingIdentity = (await listStoredCalendarEvents({ calendarIds: [calendarId], from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" })).find((event) => event.id === updated.id)!;
      await rejected(() => upsertCalendarEvent({ id: missingIdentity.id, calendarId, title: missingIdentity.title, start: missingIdentity.start, end: missingIdentity.end, expectedUpdatedAt: missingIdentity.updatedAt }), "missing Exchange identity update");
      await database.query("UPDATE calendar_events SET provider_item_id = 'event-1', is_recurring = true, updated_at = now() WHERE id = $1", [updated.id]);
      const recurringProtected = (await listStoredCalendarEvents({ calendarIds: [calendarId], from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" })).find((event) => event.id === updated.id)!;
      await rejected(() => upsertCalendarEvent({ id: recurringProtected.id, calendarId, title: recurringProtected.title, start: recurringProtected.start, end: recurringProtected.end, expectedUpdatedAt: recurringProtected.updatedAt }), "recurring Exchange update");
      await database.query("UPDATE calendar_events SET is_recurring = false, is_meeting = true, updated_at = now() WHERE id = $1", [updated.id]);
      const meetingProtected = (await listStoredCalendarEvents({ calendarIds: [calendarId], from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" })).find((event) => event.id === updated.id)!;
      await rejected(() => upsertCalendarEvent({ id: meetingProtected.id, calendarId, title: meetingProtected.title, start: meetingProtected.start, end: meetingProtected.end, expectedUpdatedAt: meetingProtected.updatedAt }), "meeting-protected Exchange update");
      console.log("REQ-MCP-EXCHANGE-01 Exchange stale/missing/meeting/recurring/recurrence guard: SOAP callCount=0");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
