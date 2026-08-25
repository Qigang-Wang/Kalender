import type { CalendarEvent } from "../../../../src/mail/types";

import type { UpsertCalendarEventInput } from "../../../../src/mail/types";
import {
  assertExchangeSuccess,
  attributeValue,
  elementContent,
  elementContents,
  elementText,
  escapeXml,
  exchangeSoapRequest,
  ExchangeEwsError,
  openingTag,
  parseExchangeCredential,
  RWTH_EWS_URL,
  toExchangePublicError,
  type ExchangeCredential,
} from "./exchange-ews-client";

export { RWTH_EWS_URL };
export type ExchangeCalendarCredential = ExchangeCredential;

export interface ExchangeCalendarFolder {
  readonly folderId: string;
  readonly changeKey?: string;
  readonly name: string;
}

export interface ExchangeCalendarEvent extends CalendarEvent {
  readonly etag?: string;
  readonly sourceUrl: string;
  readonly itemId: string;
  readonly changeKey?: string;
  readonly isMeeting: boolean;
  readonly isRecurring: boolean;
  readonly isOrganizer?: boolean;
}

export interface ExchangeItemIdentity {
  readonly itemId: string;
  readonly changeKey?: string;
}

export class ExchangeCalendarError extends ExchangeEwsError {}

export function parseExchangeCalendarCredential(input: unknown): ExchangeCalendarCredential {
  return parseExchangeCredential(input);
}

export async function discoverExchangeCalendar(
  credential: ExchangeCalendarCredential,
  signal?: AbortSignal,
): Promise<ExchangeCalendarFolder> {
  const xml = await exchangeSoapRequest(credential, "GetFolder", `
    <m:GetFolder>
      <m:FolderShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties><t:FieldURI FieldURI="folder:DisplayName"/></t:AdditionalProperties>
      </m:FolderShape>
      <m:FolderIds><t:DistinguishedFolderId Id="calendar"/></m:FolderIds>
    </m:GetFolder>`, signal);
  return parseExchangeFolderResponse(xml);
}

export async function fetchExchangeCalendarEvents(
  credential: ExchangeCalendarCredential,
  folder: ExchangeCalendarFolder,
  input: { readonly from: string; readonly to: string },
  signal?: AbortSignal,
): Promise<readonly ExchangeCalendarEvent[]> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    throw new ExchangeCalendarError("INVALID_RANGE", "Zeitbereich von Exchange-Kalendern synchronisieren ist nicht gültig", 400);
  }
  const results = new Map<string, ExchangeCalendarEvent>();
  let cursor = from;
  while (cursor < to) {
    const windowEnd = new Date(Math.min(to.getTime(), cursor.getTime() + 90 * 86_400_000));
    const xml = await exchangeSoapRequest(credential, "FindItem", `
      <m:FindItem Traversal="Shallow">
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="item:Subject"/>
            <t:FieldURI FieldURI="item:LastModifiedTime"/>
            <t:FieldURI FieldURI="calendar:Start"/>
            <t:FieldURI FieldURI="calendar:End"/>
            <t:FieldURI FieldURI="calendar:IsAllDayEvent"/>
            <t:FieldURI FieldURI="calendar:IsCancelled"/>
            <t:FieldURI FieldURI="calendar:Location"/>
            <t:FieldURI FieldURI="calendar:LegacyFreeBusyStatus"/>
            <t:FieldURI FieldURI="calendar:RequiredAttendees"/>
            <t:FieldURI FieldURI="calendar:OptionalAttendees"/>
            <t:FieldURI FieldURI="calendar:UID"/>
          </t:AdditionalProperties>
        </m:ItemShape>
        <m:CalendarView StartDate="${escapeXml(cursor.toISOString())}" EndDate="${escapeXml(windowEnd.toISOString())}" MaxEntriesReturned="1000"/>
        <m:ParentFolderIds><t:FolderId Id="${escapeXml(folder.folderId)}"${folder.changeKey ? ` ChangeKey="${escapeXml(folder.changeKey)}"` : ""}/></m:ParentFolderIds>
      </m:FindItem>`, signal);
    if (/IncludesLastItemInRange\s*=\s*["']false["']/i.test(xml)) {
      throw new ExchangeCalendarError("TOO_MANY_EVENTS", "Wechselkalender überschreiten 1.000 Einträge in einem einzigen Synchronisationsintervall, bitte den Synchronisationsbereich verkürzen", 409);
    }
    const summaries = parseExchangeEventsResponse(xml, credential.serverUrl);
    const detailed = await fetchExchangeCalendarEventDetails(credential, summaries, signal);
    for (const event of detailed) results.set(event.providerEventId, event);
    cursor = windowEnd;
  }
  return [...results.values()].sort((left, right) => left.start.localeCompare(right.start));
}

export async function fetchExchangeCalendarEventDetails(
  credential: ExchangeCalendarCredential,
  events: readonly ExchangeCalendarEvent[],
  signal?: AbortSignal,
): Promise<readonly ExchangeCalendarEvent[]> {
  const detailed: ExchangeCalendarEvent[] = [];
  for (let index = 0; index < events.length; index += 20) {
    const batch = events.slice(index, index + 20);
    const xml = await exchangeSoapRequest(credential, "GetItem", `
      <m:GetItem>
        <m:ItemShape>
          <t:BaseShape>AllProperties</t:BaseShape>
          <t:BodyType>Text</t:BodyType>
        </m:ItemShape>
        <m:ItemIds>${batch.map((event) => `<t:ItemId Id="${escapeXml(event.itemId)}"${event.changeKey ? ` ChangeKey="${escapeXml(event.changeKey)}"` : ""}/>`).join("")}</m:ItemIds>
      </m:GetItem>`, signal);
    detailed.push(...parseExchangeEventsResponse(xml, credential.serverUrl));
  }
  return detailed;
}

export async function createExchangeCalendarEvent(
  credential: ExchangeCalendarCredential,
  folder: ExchangeCalendarFolder,
  input: UpsertCalendarEventInput,
  signal?: AbortSignal,
): Promise<ExchangeCalendarEvent> {
  const xml = await exchangeSoapRequest(credential, "CreateItem", `
    <m:CreateItem SendMeetingInvitations="SendToNone">
      <m:SavedItemFolderId><t:FolderId Id="${escapeXml(folder.folderId)}"${folder.changeKey ? ` ChangeKey="${escapeXml(folder.changeKey)}"` : ""}/></m:SavedItemFolderId>
      <m:Items>${exchangeCalendarItemXml(input)}</m:Items>
    </m:CreateItem>`, signal);
  return fetchExchangeCalendarEventByIdentity(credential, parseExchangeItemIdentity(xml), signal);
}

export async function updateExchangeCalendarEvent(
  credential: ExchangeCalendarCredential,
  identity: ExchangeItemIdentity,
  input: UpsertCalendarEventInput,
  signal?: AbortSignal,
): Promise<ExchangeCalendarEvent> {
  const xml = await exchangeSoapRequest(credential, "UpdateItem", `
    <m:UpdateItem ConflictResolution="AutoResolve" MessageDisposition="SaveOnly" SendMeetingInvitationsOrCancellations="SendToNone">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="${escapeXml(identity.itemId)}"${identity.changeKey ? ` ChangeKey="${escapeXml(identity.changeKey)}"` : ""}/>
          <t:Updates>
            ${exchangeSetField("item:Subject", `<t:Subject>${escapeXml(input.title)}</t:Subject>`)}
            ${exchangeSetField("item:Body", `<t:Body BodyType="Text">${escapeXml(input.description ?? "")}</t:Body>`)}
            ${exchangeSetField("calendar:Location", `<t:Location>${escapeXml(input.location ?? "")}</t:Location>`)}
            ${exchangeSetField("calendar:Start", `<t:Start>${escapeXml(input.start)}</t:Start>`)}
            ${exchangeSetField("calendar:End", `<t:End>${escapeXml(input.end)}</t:End>`)}
            ${exchangeSetField("calendar:IsAllDayEvent", `<t:IsAllDayEvent>${input.allDay === true}</t:IsAllDayEvent>`)}
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>`, signal);
  const responseIdentity = parseExchangeItemIdentity(xml, identity);
  return fetchExchangeCalendarEventByIdentity(credential, responseIdentity, signal);
}

export async function deleteExchangeCalendarEvent(
  credential: ExchangeCalendarCredential,
  identity: ExchangeItemIdentity,
  signal?: AbortSignal,
): Promise<void> {
  await exchangeSoapRequest(credential, "DeleteItem", `
    <m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToNone">
      <m:ItemIds><t:ItemId Id="${escapeXml(identity.itemId)}"${identity.changeKey ? ` ChangeKey="${escapeXml(identity.changeKey)}"` : ""}/></m:ItemIds>
    </m:DeleteItem>`, signal);
}

export async function fetchExchangeCalendarEventByIdentity(
  credential: ExchangeCalendarCredential,
  identity: ExchangeItemIdentity,
  signal?: AbortSignal,
): Promise<ExchangeCalendarEvent> {
  const seed: ExchangeCalendarEvent = {
    id: identity.itemId,
    providerEventId: identity.itemId,
    calendarId: "exchange:calendar",
    title: "",
    start: new Date(0).toISOString(),
    end: new Date(1).toISOString(),
    allDay: false,
    attendees: [],
    status: "confirmed",
    sourceUrl: credential.serverUrl,
    itemId: identity.itemId,
    changeKey: identity.changeKey,
    isMeeting: false,
    isRecurring: false,
  };
  const [event] = await fetchExchangeCalendarEventDetails(credential, [seed], signal);
  if (!event) throw new ExchangeCalendarError("ITEM_NOT_FOUND", "Exchange hat das gerade gespeicherte Kalenderereignis nicht zurückgegeben", 502);
  return event;
}

export function parseExchangeFolderResponse(xml: string): ExchangeCalendarFolder {
  assertExchangeSuccess(xml);
  const folder = elementContent(xml, "CalendarFolder") ?? elementContent(xml, "Folder");
  if (!folder) throw new ExchangeCalendarError("NO_CALENDAR", "kein lesbarer Standardkalender im Exchange-Konto gefunden", 409);
  const folderIdTag = openingTag(folder, "FolderId");
  const folderId = folderIdTag ? attributeValue(folderIdTag, "Id") : undefined;
  if (!folderId) throw new ExchangeCalendarError("INVALID_RESPONSE", "Kalenderordner, der von Exchange zurückgegeben wird, ist nicht markiert", 502);
  return {
    folderId,
    changeKey: folderIdTag ? attributeValue(folderIdTag, "ChangeKey") : undefined,
    name: elementText(folder, "DisplayName") || "Austauschkalender",
  };
}

export function parseExchangeEventsResponse(xml: string, sourceUrl: string): readonly ExchangeCalendarEvent[] {
  assertExchangeSuccess(xml);
  return elementContents(xml, "CalendarItem").flatMap((item) => {
    const itemIdTag = openingTag(item, "ItemId");
    const itemId = itemIdTag ? attributeValue(itemIdTag, "Id") : undefined;
    const startValue = elementText(item, "Start");
    const endValue = elementText(item, "End");
    if (!itemId || !startValue || !endValue) return [];
    const start = new Date(startValue);
    const end = new Date(endValue);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return [];
    const providerEventId = `${elementText(item, "UID") || itemId}:${start.toISOString()}`;
    const attendees = [
      ...parseExchangeAttendees(elementContent(item, "RequiredAttendees")),
      ...parseExchangeAttendees(elementContent(item, "OptionalAttendees")),
    ];
    const freeBusy = elementText(item, "LegacyFreeBusyStatus").toLocaleLowerCase();
    const availability = exchangeAvailability(freeBusy);
    const cancelled = elementText(item, "IsCancelled").toLocaleLowerCase() === "true";
    const changeKey = itemIdTag ? attributeValue(itemIdTag, "ChangeKey") : undefined;
    const calendarItemType = elementText(item, "CalendarItemType").toLocaleLowerCase();
    return [{
      id: providerEventId,
      providerEventId,
      calendarId: "exchange:calendar",
      title: elementText(item, "Subject") || "Kein Titel",
      description: elementText(item, "Body") || undefined,
      location: elementText(item, "Location") || undefined,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: "Europe/Berlin",
      allDay: elementText(item, "IsAllDayEvent").toLocaleLowerCase() === "true",
      attendees,
      meetingUrl: elementText(item, "OnlineMeetingUrl") || undefined,
      status: cancelled ? "cancelled" : freeBusy === "tentative" ? "tentative" : "confirmed",
      availability,
      etag: changeKey ?? (elementText(item, "LastModifiedTime") || undefined),
      sourceUrl,
      itemId,
      changeKey,
      isMeeting: elementText(item, "IsMeeting").toLocaleLowerCase() === "true",
      isRecurring: elementText(item, "IsRecurring").toLocaleLowerCase() === "true" || Boolean(calendarItemType && calendarItemType !== "single"),
      isOrganizer: elementText(item, "IsOrganizer") ? elementText(item, "IsOrganizer").toLocaleLowerCase() === "true" : undefined,
      providerData: { providerId: "exchange", itemId, changeKey },
    } satisfies ExchangeCalendarEvent];
  });
}

export function toExchangeCalendarPublicError(error: unknown): { readonly code: string; readonly message: string; readonly status: number } {
  return toExchangePublicError(error);
}

function exchangeAvailability(value: string): NonNullable<CalendarEvent["availability"]> {
  if (value === "free") return "free";
  if (value === "tentative") return "tentative";
  if (value === "oof") return "oof";
  if (value === "workingelsewhere" || value === "working_elsewhere") return "working_elsewhere";
  return "busy";
}

function exchangeAvailabilityValue(value?: CalendarEvent["availability"]): string {
  if (value === "free") return "Free";
  if (value === "tentative") return "Tentative";
  if (value === "oof") return "OOF";
  if (value === "working_elsewhere") return "WorkingElsewhere";
  return "Busy";
}

function exchangeCalendarItemXml(input: UpsertCalendarEventInput): string {
  return `<t:CalendarItem>
    <t:Subject>${escapeXml(input.title)}</t:Subject>
    <t:Body BodyType="Text">${escapeXml(input.description ?? "")}</t:Body>
    <t:Start>${escapeXml(input.start)}</t:Start>
    <t:End>${escapeXml(input.end)}</t:End>
    <t:IsAllDayEvent>${input.allDay === true}</t:IsAllDayEvent>
    <t:LegacyFreeBusyStatus>${exchangeAvailabilityValue(input.availability)}</t:LegacyFreeBusyStatus>
    <t:Location>${escapeXml(input.location ?? "")}</t:Location>
  </t:CalendarItem>`;
}

function exchangeSetField(fieldUri: string, valueXml: string): string {
  return `<t:SetItemField><t:FieldURI FieldURI="${fieldUri}"/><t:CalendarItem>${valueXml}</t:CalendarItem></t:SetItemField>`;
}

function parseExchangeItemIdentity(xml: string, fallback?: ExchangeItemIdentity): ExchangeItemIdentity {
  const itemIdTag = openingTag(elementContent(xml, "CalendarItem") ?? xml, "ItemId");
  const itemId = itemIdTag ? attributeValue(itemIdTag, "Id") : fallback?.itemId;
  if (!itemId) throw new ExchangeCalendarError("INVALID_RESPONSE", "Austausch erfolgreich gespeichert, aber nicht die Kalender-Ereignis-ID zurückgegeben", 502);
  return {
    itemId,
    changeKey: itemIdTag ? attributeValue(itemIdTag, "ChangeKey") ?? fallback?.changeKey : fallback?.changeKey,
  };
}

function parseExchangeAttendees(xml?: string): readonly { readonly address: string; readonly name?: string }[] {
  if (!xml) return [];
  return elementContents(xml, "Attendee").flatMap((attendee) => {
    const mailbox = elementContent(attendee, "Mailbox") ?? attendee;
    const address = elementText(mailbox, "EmailAddress");
    return address ? [{ address, name: elementText(mailbox, "Name") || undefined }] : [];
  });
}
