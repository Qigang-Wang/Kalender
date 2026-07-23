import {
  MailProviderError,
  normalizeMailProviderError,
  type MailProviderErrorCode,
} from "./errors.js";
import { MailProviderRegistry } from "./registry.js";
import type {
  CalendarEvent,
  CalendarSummary,
  ConnectedMailAccount,
  ListCalendarEventsInput,
  ListThreadsInput,
  MailMessage,
  MailProvider,
  MailSyncInput,
  MailSyncPage,
  MailThread,
  MailThreadDetails,
  Page,
  ProviderContext,
  ProviderContextFactory,
  ProviderConnectionTestResult,
  SendMailInput,
  UpdateMessageInput,
  UpsertCalendarEventInput,
} from "./types.js";

export interface UnifiedThread {
  readonly accountId: string;
  readonly providerId: string;
  readonly accountEmailAddress: string;
  readonly thread: MailThread;
}

export interface UnifiedInboxFailure {
  readonly accountId: string;
  readonly providerId: string;
  readonly code: MailProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface UnifiedInboxInput
  extends Omit<ListThreadsInput, "cursor" | "limit"> {
  readonly cursors?: Readonly<Record<string, string | undefined>>;
  readonly limitPerAccount?: number;
}

export interface UnifiedInboxPage {
  readonly items: readonly UnifiedThread[];
  readonly nextCursors: Readonly<Record<string, string | undefined>>;
  readonly failures: readonly UnifiedInboxFailure[];
}

export class UnifiedMailService {
  constructor(
    private readonly registry: MailProviderRegistry,
    private readonly contextFactory: ProviderContextFactory,
  ) {}

  async testConnection(
    account: ConnectedMailAccount,
    signal?: AbortSignal,
  ): Promise<ProviderConnectionTestResult> {
    return this.run(account, signal, (provider, context) =>
      provider.testConnection(context),
    );
  }

  async listThreads(
    account: ConnectedMailAccount,
    input: ListThreadsInput = {},
    signal?: AbortSignal,
  ): Promise<Page<MailThread>> {
    return this.run(account, signal, (provider, context) =>
      provider.mail.listThreads(context, input),
    );
  }

  async listUnifiedInbox(
    accounts: readonly ConnectedMailAccount[],
    input: UnifiedInboxInput = {},
    signal?: AbortSignal,
  ): Promise<UnifiedInboxPage> {
    const enabledAccounts = accounts.filter((account) => account.enabled);
    const limitPerAccount = Math.max(1, Math.min(input.limitPerAccount ?? 25, 100));

    const results = await Promise.all(
      enabledAccounts.map(async (account) => {
        try {
          const page = await this.listThreads(
            account,
            {
              folderId: input.folderId,
              query: input.query,
              unreadOnly: input.unreadOnly,
              after: input.after,
              before: input.before,
              cursor: input.cursors?.[account.id],
              limit: limitPerAccount,
            },
            signal,
          );
          return { ok: true, account, page } as const;
        } catch (error) {
          const normalized = normalizeMailProviderError(error, {
            accountId: account.id,
            providerId: account.providerId,
          });
          return { ok: false, account, error: normalized } as const;
        }
      }),
    );

    const items: UnifiedThread[] = [];
    const failures: UnifiedInboxFailure[] = [];
    const nextCursors: Record<string, string | undefined> = {};

    for (const result of results) {
      if (!result.ok) {
        failures.push({
          accountId: result.account.id,
          providerId: result.account.providerId,
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        });
        continue;
      }

      nextCursors[result.account.id] = result.page.nextCursor;
      for (const thread of result.page.items) {
        items.push({
          accountId: result.account.id,
          providerId: result.account.providerId,
          accountEmailAddress: result.account.emailAddress,
          thread,
        });
      }
    }

    items.sort(
      (left, right) =>
        Date.parse(right.thread.lastMessageAt) -
        Date.parse(left.thread.lastMessageAt),
    );

    return { items, nextCursors, failures };
  }

  async getThread(
    account: ConnectedMailAccount,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<MailThreadDetails> {
    return this.run(account, signal, (provider, context) =>
      provider.mail.getThread(context, threadId),
    );
  }

  async sync(
    account: ConnectedMailAccount,
    input: MailSyncInput = {},
    signal?: AbortSignal,
  ): Promise<MailSyncPage> {
    return this.run(account, signal, (provider, context) => {
      this.requireCapability(
        provider.capabilities.mail.incrementalSync,
        provider,
        account,
        "incremental mail sync",
      );
      return provider.mail.sync(context, input);
    });
  }

  async sendMessage(
    account: ConnectedMailAccount,
    input: SendMailInput,
    signal?: AbortSignal,
  ): Promise<MailMessage> {
    return this.run(account, signal, (provider, context) => {
      this.requireCapability(
        provider.capabilities.mail.send,
        provider,
        account,
        "sending mail",
      );
      return provider.mail.sendMessage(context, input);
    });
  }

  async updateMessage(
    account: ConnectedMailAccount,
    input: UpdateMessageInput,
    signal?: AbortSignal,
  ): Promise<MailMessage> {
    return this.run(account, signal, (provider, context) => {
      this.requireCapability(
        provider.capabilities.mail.modify,
        provider,
        account,
        "modifying mail",
      );
      return provider.mail.updateMessage(context, input);
    });
  }

  async listCalendars(
    account: ConnectedMailAccount,
    signal?: AbortSignal,
  ): Promise<readonly CalendarSummary[]> {
    return this.run(account, signal, (provider, context) => {
      this.requireCalendar(provider, account, "reading calendars");
      return provider.calendar!.listCalendars(context);
    });
  }

  async listCalendarEvents(
    account: ConnectedMailAccount,
    input: ListCalendarEventsInput,
    signal?: AbortSignal,
  ): Promise<Page<CalendarEvent>> {
    return this.run(account, signal, (provider, context) => {
      this.requireCalendar(provider, account, "reading calendar events");
      return provider.calendar!.listEvents(context, input);
    });
  }

  async upsertCalendarEvent(
    account: ConnectedMailAccount,
    input: UpsertCalendarEventInput,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    return this.run(account, signal, (provider, context) => {
      this.requireCalendar(provider, account, "writing calendar events", true);
      return provider.calendar!.upsertEvent(context, input);
    });
  }

  async deleteCalendarEvent(
    account: ConnectedMailAccount,
    calendarId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.run(account, signal, (provider, context) => {
      this.requireCalendar(provider, account, "deleting calendar events", true);
      return provider.calendar!.deleteEvent(context, calendarId, eventId);
    });
  }

  private async run<T>(
    account: ConnectedMailAccount,
    signal: AbortSignal | undefined,
    operation: (
      provider: MailProvider,
      context: ProviderContext,
    ) => Promise<T>,
  ): Promise<T> {
    if (!account.enabled) {
      throw new MailProviderError(
        "INVALID_REQUEST",
        `Mail account '${account.id}' is disabled`,
        { providerId: account.providerId, accountId: account.id },
      );
    }

    const provider = this.registry.resolve(account);
    try {
      const context = await this.contextFactory.create(account, signal);
      return await operation(provider, context);
    } catch (error) {
      throw normalizeMailProviderError(error, {
        providerId: provider.metadata.id,
        accountId: account.id,
      });
    }
  }

  private requireCalendar(
    provider: MailProvider,
    account: ConnectedMailAccount,
    feature: string,
    write = false,
  ): void {
    const supported =
      provider.calendar !== undefined &&
      (write
        ? provider.capabilities.calendar.write
        : provider.capabilities.calendar.read);
    this.requireCapability(supported, provider, account, feature);
  }

  private requireCapability(
    supported: boolean,
    provider: MailProvider,
    account: ConnectedMailAccount,
    feature: string,
  ): void {
    if (!supported) {
      throw new MailProviderError(
        "UNSUPPORTED",
        `${provider.metadata.displayName} does not support ${feature}`,
        { providerId: provider.metadata.id, accountId: account.id },
      );
    }
  }
}
