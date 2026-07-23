import { MailProviderError } from "./errors.js";
import type { ConnectedMailAccount, MailProvider, ProviderId } from "./types.js";

export class MailProviderRegistry {
  readonly #providers = new Map<ProviderId, MailProvider>();

  register(provider: MailProvider): void {
    const providerId = provider.metadata.id.trim();
    if (!providerId) {
      throw new MailProviderError(
        "INVALID_REQUEST",
        "A mail provider must have a non-empty id",
      );
    }

    if (this.#providers.has(providerId)) {
      throw new MailProviderError(
        "CONFLICT",
        `Mail provider '${providerId}' is already registered`,
        { providerId },
      );
    }

    this.#providers.set(providerId, provider);
  }

  unregister(providerId: ProviderId): boolean {
    return this.#providers.delete(providerId);
  }

  has(providerId: ProviderId): boolean {
    return this.#providers.has(providerId);
  }

  get(providerId: ProviderId): MailProvider {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new MailProviderError(
        "NOT_FOUND",
        `Mail provider '${providerId}' is not registered`,
        { providerId },
      );
    }
    return provider;
  }

  resolve(account: ConnectedMailAccount): MailProvider {
    return this.get(account.providerId);
  }

  list(): readonly MailProvider[] {
    return [...this.#providers.values()];
  }
}
