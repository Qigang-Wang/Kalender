import { getDatabase } from "./database";
import { exchangeSoapRequest, elementText, elementContents, escapeXml, ExchangeEwsError, type ExchangeCredential } from "./exchange-ews-client";

/** SyncFolderItems detects changes; CalendarView must still expand recurring instances. */
export async function checkExchangeCalendarChanges(credential: ExchangeCredential, calendarId: string, folderId: string, signal: AbortSignal) {
  const database = await getDatabase();
  const day = new Date().toISOString().slice(0, 10);
  const cached = (await database.query<{ sync_state: string; range_day: string }>("SELECT sync_state, range_day::text FROM exchange_calendar_sync_state WHERE calendar_id = $1", [calendarId])).rows[0];
  let cursor: string | undefined = cached?.sync_state;
  let changed = !cached || cached.range_day !== day;
  for (let page = 0; page < 100; page++) {
    let xml: string;
    try {
      xml = await exchangeSoapRequest(credential, "SyncFolderItems", `<m:SyncFolderItems><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:SyncFolderId><t:FolderId Id="${escapeXml(folderId)}"/></m:SyncFolderId>${cursor ? `<m:SyncState>${escapeXml(cursor)}</m:SyncState>` : ""}<m:MaxChangesReturned>512</m:MaxChangesReturned><m:SyncScope>NormalItems</m:SyncScope></m:SyncFolderItems>`, signal);
    } catch (error) {
      if (cursor && error instanceof ExchangeEwsError && error.responseCode === "ErrorInvalidSyncStateData") { cursor = undefined; changed = true; continue; }
      throw error;
    }
    const next = elementText(xml, "SyncState");
    if (!next) throw new Error("Exchange 日历增量同步未返回游标");
    changed ||= ["Create", "Update", "Delete"].some((tag) => elementContents(xml, tag).length > 0);
    cursor = next;
    if (elementText(xml, "IncludesLastItemInRange") === "true") return {
      changed,
      commit: async () => {
        await database.query(`INSERT INTO exchange_calendar_sync_state (calendar_id, sync_state, range_day) VALUES ($1,$2,$3) ON CONFLICT (calendar_id) DO UPDATE SET sync_state = EXCLUDED.sync_state, range_day = EXCLUDED.range_day, updated_at = now()`, [calendarId, next, day]);
      },
    };
  }
  throw new Error("Exchange 日历同步变更过多，请稍后重试");
}
