import { getCalendarAccount, listCalendarAccounts, loadExchangeCalendarCredential } from "./calendar-account-repository";
import { exchangeSoapRequest, elementText, escapeXml, type ExchangeCredential } from "./exchange-ews-client";
import { syncCalDavAccount, isCalendarAccountSyncing } from "./caldav-sync";
import { runExchangeMailSync } from "./exchange-mail-sync";
import { getDatabase } from "./database";
import { getWorkspaceSyncSettings } from "./sync-settings";

type Listener = { controller: AbortController; timer?: ReturnType<typeof setTimeout>; subscription?: string; credential?: ExchangeCredential; failures: number };
declare global { var kalenderExchangeListeners: Map<string, Listener> | undefined; }

export async function ensureExchangeNotifications(): Promise<void> {
  const settings = await getWorkspaceSyncSettings();
  if (!settings.calendarSyncEnabled && !settings.mailSyncEnabled) { stopExchangeNotifications(); return; }
  const listeners = globalThis.kalenderExchangeListeners ??= new Map();
  for (const account of await listCalendarAccounts()) {
    if (account.providerId !== "exchange" || account.syncStatus === "paused" || listeners.has(account.id)) continue;
    const listener: Listener = { controller: new AbortController(), failures: 0 };
    listeners.set(account.id, listener);
    void listen(account.id, listener);
  }
}

export function stopExchangeNotifications(): void {
  for (const listener of globalThis.kalenderExchangeListeners?.values() ?? []) {
    listener.controller.abort();
    clearTimeout(listener.timer);
  }
  globalThis.kalenderExchangeListeners?.clear();
}

async function listen(accountId: string, listener: Listener): Promise<void> {
  const signal = listener.controller.signal;
  if (signal.aborted) return;
  let credential;
  try {
    const account = await getCalendarAccount(accountId);
    const settings = await getWorkspaceSyncSettings();
    if (!account || account.syncStatus === "paused" || !(account.calendarEnabled && settings.calendarSyncEnabled || account.mailEnabled && settings.mailSyncEnabled)) {
      if (listener.subscription && listener.credential) await exchangeSoapRequest(listener.credential, "Unsubscribe", `<m:Unsubscribe><m:SubscriptionId>${escapeXml(listener.subscription)}</m:SubscriptionId></m:Unsubscribe>`, AbortSignal.timeout(10_000)).catch(() => undefined);
      globalThis.kalenderExchangeListeners?.delete(accountId);
      return;
    }
    credential = await loadExchangeCalendarCredential(accountId);
    listener.credential = credential;
    if (!listener.subscription) {
      const xml = await exchangeSoapRequest(credential, "Subscribe", `<m:Subscribe><m:StreamingSubscriptionRequest SubscribeToAllFolders="true"><t:EventTypes><t:EventType>CreatedEvent</t:EventType><t:EventType>ModifiedEvent</t:EventType><t:EventType>DeletedEvent</t:EventType><t:EventType>MovedEvent</t:EventType><t:EventType>NewMailEvent</t:EventType></t:EventTypes></m:StreamingSubscriptionRequest></m:Subscribe>`, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      listener.subscription = elementText(xml, "SubscriptionId");
      if (!listener.subscription) throw new Error("Exchange 没有返回通知订阅标识");
    }
    await exchangeSoapRequest(credential, "GetStreamingEvents", `<m:GetStreamingEvents><m:SubscriptionIds><t:SubscriptionId>${escapeXml(listener.subscription)}</t:SubscriptionId></m:SubscriptionIds><m:ConnectionTimeout>1</m:ConnectionTimeout></m:GetStreamingEvents>`, AbortSignal.any([signal, AbortSignal.timeout(75_000)]), async (xml) => {
      if (!/<(?:[\w-]+:)?(?:Created|Modified|Deleted|Moved|NewMail)Event\b/.test(xml) || signal.aborted) return;
      if (account.calendarEnabled && settings.calendarSyncEnabled && !isCalendarAccountSyncing(accountId)) await syncCalDavAccount(accountId);
      if (account.mailEnabled && settings.mailSyncEnabled) {
        const database = await getDatabase();
        const mail = await database.query<{ id: string }>("SELECT id FROM accounts WHERE exchange_connection_id = (SELECT exchange_connection_id FROM calendar_accounts WHERE id = $1) AND enabled = true", [accountId]);
        if (mail.rows[0] && !globalThis.kalenderActiveMailSyncs?.has(mail.rows[0].id)) await runExchangeMailSync(mail.rows[0].id, 100);
      }
    });
    listener.failures = 0;
  } catch {
    listener.failures += 1;
    // The periodic schedulers remain the fallback when notifications are unavailable.
    if (listener.subscription && credential) await exchangeSoapRequest(credential, "Unsubscribe", `<m:Unsubscribe><m:SubscriptionId>${escapeXml(listener.subscription)}</m:SubscriptionId></m:Unsubscribe>`, AbortSignal.timeout(10_000)).catch(() => undefined);
    listener.subscription = undefined;
  }
  if (signal.aborted) return;
  listener.timer = setTimeout(() => void listen(accountId, listener), listener.failures ? Math.min(300_000, 5000 * 2 ** Math.min(listener.failures, 6)) : 1000);
  listener.timer.unref();
}
