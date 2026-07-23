import { runExchangeMailSync } from "./exchange-mail-sync";
import { runImapSync, type SyncSummary } from "./imap-sync";
import { getAccount } from "./mail-repository";

export async function runMailSync(accountId: string, maximumMessages = 100): Promise<SyncSummary> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("Account was not found");
  return account.providerId === "exchange-ews"
    ? runExchangeMailSync(accountId, maximumMessages)
    : runImapSync(accountId, maximumMessages);
}
