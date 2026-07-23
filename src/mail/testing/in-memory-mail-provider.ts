import { MailProviderError } from "../errors.js";
import type {
  CalendarEvent,
  CalendarOperations,
  CalendarSummary,
  ListCalendarEventsInput,
  ListThreadsInput,
  MailFolder,
  MailMessage,
  MailOperations,
  MailProvider,
  MailSyncChange,
  MailSyncInput,
  MailThread,
  Page,
  ProviderAuthorizationOperations,
  ProviderCapabilities,
  ProviderContext,
  ProviderMetadata,
  ProviderConnectionTestResult,
  SendMailInput,
  UpdateMessageInput,
  UpsertCalendarEventInput,
} from "../types.js";

export interface InMemoryAccountSeed {
  readonly folders?: readonly MailFolder[];
  readonly messages?: readonly MailMessage[];
  readonly threads?: readonly MailThread[];
  readonly calendars?: readonly CalendarSummary[];
  readonly events?: readonly CalendarEvent[];
}

export interface InMemoryMailProviderOptions {
  readonly calendar?: boolean;
  readonly send?: boolean;
}

interface InMemoryAccountData {
  readonly folders: Map<string, MailFolder>;
  readonly messages: Map<string, MailMessage>;
  readonly threads: Map<string, MailThread>;
  readonly calendars: Map<string, CalendarSummary>;
  readonly events: Map<string, CalendarEvent>;
  readonly mailChanges: MailSyncChange[];
}

export class InMemoryMailProvider implements MailProvider {
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;
  readonly authorization: ProviderAuthorizationOperations;
  readonly mail: MailOperations;
  readonly calendar?: CalendarOperations;

  readonly #accounts = new Map<string, InMemoryAccountData>();
  #sequence = 0;

  constructor(
    providerId: string,
    displayName = `In-memory ${providerId}`,
    options: InMemoryMailProviderOptions = {},
  ) {
    const calendarEnabled = options.calendar ?? true;
    const sendEnabled = options.send ?? true;

    this.metadata = { id: providerId, displayName };
    this.capabilities = {
      authentication: "oauth2",
      mail: {
        folders: true,
        threads: true,
        attachments: true,
        drafts: false,
        send: sendEnabled,
        modify: true,
        incrementalSync: true,
        pushNotifications: false,
      },
      calendar: {
        read: calendarEnabled,
        write: calendarEnabled,
        incrementalSync: false,
      },
    };

    this.authorization = {
      createAuthorizationRequest: async (input) => {
        const state = input.state ?? `memory-state-${++this.#sequence}`;
        return {
          url: `memory://authorize/${providerId}?state=${encodeURIComponent(state)}`,
          state,
        };
      },
      exchangeAuthorizationCode: async (input) => ({
        kind: "oauth2",
        accessToken: `memory-access-${input.code}`,
        refreshToken: `memory-refresh-${input.code}`,
        scopes: [],
      }),
      refreshSession: async (session) => session,
      revokeSession: async () => undefined,
    };

    this.mail = {
      listFolders: async (context) => {
        this.assertNotAborted(context);
        return [...this.getAccount(context).folders.values()];
      },
      listThreads: async (context, input) => {
        this.assertNotAborted(context);
        const account = this.getAccount(context);
        const filtered = [...account.threads.values()]
          .filter((thread) => this.matchesThread(account, thread, input))
          .sort(
            (left, right) =>
              Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt),
          );
        return this.page(filtered, input.cursor, input.limit);
      },
      getThread: async (context, threadId) => {
        this.assertNotAborted(context);
        const account = this.getAccount(context);
        const thread = account.threads.get(threadId);
        if (!thread) {
          throw this.notFound(context, `Thread '${threadId}' was not found`);
        }
        const messages = thread.messageIds
          .map((messageId) => account.messages.get(messageId))
          .filter((message): message is MailMessage => message !== undefined)
          .sort(
            (left, right) =>
              Date.parse(left.receivedAt) - Date.parse(right.receivedAt),
          );
        return { thread, messages };
      },
      sync: async (context, input) => {
        this.assertNotAborted(context);
        const account = this.getAccount(context);
        const offset = this.parseCursor(input.cursor);
        const limit = this.normalizeLimit(input.limit);
        const changes = account.mailChanges.slice(offset, offset + limit);
        const nextOffset = offset + changes.length;
        return {
          changes,
          nextCursor: String(nextOffset),
          hasMore: nextOffset < account.mailChanges.length,
        };
      },
      sendMessage: async (context, input) => {
        this.assertNotAborted(context);
        if (!this.capabilities.mail.send) {
          throw new MailProviderError(
            "UNSUPPORTED",
            `${this.metadata.displayName} does not support sending mail`,
            {
              providerId: this.metadata.id,
              accountId: context.account.id,
            },
          );
        }
        return this.send(context, input);
      },
      updateMessage: async (context, input) => {
        this.assertNotAborted(context);
        return this.update(context, input);
      },
    };

    if (calendarEnabled) {
      this.calendar = {
        listCalendars: async (context) => {
          this.assertNotAborted(context);
          return [...this.getAccount(context).calendars.values()];
        },
        listEvents: async (context, input) => {
          this.assertNotAborted(context);
          return this.listEvents(context, input);
        },
        upsertEvent: async (context, input) => {
          this.assertNotAborted(context);
          return this.upsertEvent(context, input);
        },
        deleteEvent: async (context, calendarId, eventId) => {
          this.assertNotAborted(context);
          const account = this.getAccount(context);
          const event = account.events.get(eventId);
          if (!event || event.calendarId !== calendarId) {
            throw this.notFound(context, `Event '${eventId}' was not found`);
          }
          account.events.delete(eventId);
        },
      };
    }
  }

  async testConnection(context: ProviderContext): Promise<ProviderConnectionTestResult> {
    const startedAt = Date.now();
    this.assertNotAborted(context);
    const account = this.getAccount(context);
    const checks: ProviderConnectionTestResult["checks"] = [
      { name: "authentication", status: "passed" },
      {
        name: "mail_read",
        status: "passed",
        message: `${account.folders.size} folders available`,
      },
      this.calendar
        ? {
            name: "calendar_read",
            status: "passed",
            message: `${account.calendars.size} calendars available`,
          }
        : { name: "calendar_read", status: "skipped" },
    ];
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      identity: context.account.emailAddress,
      checks,
    };
  }

  seedAccount(accountId: string, seed: InMemoryAccountSeed = {}): void {
    const data: InMemoryAccountData = {
      folders: new Map((seed.folders ?? []).map((item) => [item.id, item])),
      messages: new Map((seed.messages ?? []).map((item) => [item.id, item])),
      threads: new Map((seed.threads ?? []).map((item) => [item.id, item])),
      calendars: new Map((seed.calendars ?? []).map((item) => [item.id, item])),
      events: new Map((seed.events ?? []).map((item) => [item.id, item])),
      mailChanges: [],
    };

    for (const folder of data.folders.values()) {
      data.mailChanges.push({ type: "upsert_folder", folder });
    }
    for (const thread of data.threads.values()) {
      data.mailChanges.push({ type: "upsert_thread", thread });
    }
    for (const message of data.messages.values()) {
      data.mailChanges.push({ type: "upsert_message", message });
    }

    this.#accounts.set(accountId, data);
  }

  private getAccount(context: ProviderContext): InMemoryAccountData {
    const account = this.#accounts.get(context.account.id);
    if (!account) {
      throw this.notFound(
        context,
        `Account '${context.account.id}' has not been seeded`,
      );
    }
    return account;
  }

  private matchesThread(
    account: InMemoryAccountData,
    thread: MailThread,
    input: ListThreadsInput,
  ): boolean {
    if (input.unreadOnly && thread.unreadCount === 0) {
      return false;
    }
    if (input.after && Date.parse(thread.lastMessageAt) <= Date.parse(input.after)) {
      return false;
    }
    if (
      input.before &&
      Date.parse(thread.lastMessageAt) >= Date.parse(input.before)
    ) {
      return false;
    }
    if (input.folderId) {
      const inFolder = thread.messageIds.some((messageId) =>
        account.messages.get(messageId)?.folderIds.includes(input.folderId!),
      );
      if (!inFolder) {
        return false;
      }
    }
    if (input.query) {
      const query = input.query.toLocaleLowerCase();
      const haystack = [
        thread.subject,
        thread.snippet,
        ...thread.participants.flatMap((participant) => [
          participant.name ?? "",
          participant.address,
        ]),
      ]
        .join(" ")
        .toLocaleLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }
    return true;
  }

  private send(context: ProviderContext, input: SendMailInput): MailMessage {
    const account = this.getAccount(context);
    const sequence = ++this.#sequence;
    const now = new Date().toISOString();
    const threadId = input.threadId ?? `${context.account.id}-thread-${sequence}`;
    const messageId = `${context.account.id}-message-${sequence}`;
    const sentFolder = [...account.folders.values()].find(
      (folder) => folder.role === "sent",
    );
    const from = input.from ?? {
      address: context.account.emailAddress,
      name: context.account.displayName,
    };
    const message: MailMessage = {
      id: messageId,
      providerMessageId: messageId,
      threadId,
      subject: input.subject,
      from,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      sentAt: now,
      receivedAt: now,
      snippet: (input.textBody ?? input.htmlBody ?? "").slice(0, 160),
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      isRead: true,
      isStarred: false,
      folderIds: sentFolder ? [sentFolder.id] : [],
      labelIds: [],
      attachments: (input.attachments ?? []).map((attachment, index) => ({
        id: `${messageId}-attachment-${index + 1}`,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: Math.floor((attachment.contentBase64.length * 3) / 4),
        inline: attachment.inline ?? false,
        contentId: attachment.contentId,
      })),
      providerData: input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    };

    const existingThread = account.threads.get(threadId);
    const thread: MailThread = {
      id: threadId,
      providerThreadId: existingThread?.providerThreadId ?? threadId,
      subject: existingThread?.subject ?? input.subject,
      snippet: message.snippet,
      participants: this.uniqueAddresses([
        ...(existingThread?.participants ?? []),
        from,
        ...input.to,
        ...(input.cc ?? []),
      ]),
      lastMessageAt: now,
      unreadCount: existingThread?.unreadCount ?? 0,
      messageIds: [...(existingThread?.messageIds ?? []), messageId],
    };

    account.messages.set(messageId, message);
    account.threads.set(threadId, thread);
    account.mailChanges.push(
      { type: "upsert_message", message },
      { type: "upsert_thread", thread },
    );
    return message;
  }

  private update(
    context: ProviderContext,
    input: UpdateMessageInput,
  ): MailMessage {
    const account = this.getAccount(context);
    const current = account.messages.get(input.messageId);
    if (!current) {
      throw this.notFound(
        context,
        `Message '${input.messageId}' was not found`,
      );
    }

    const labels = new Set(current.labelIds);
    for (const label of input.addLabelIds ?? []) {
      labels.add(label);
    }
    for (const label of input.removeLabelIds ?? []) {
      labels.delete(label);
    }

    const updated: MailMessage = {
      ...current,
      isRead: input.isRead ?? current.isRead,
      isStarred: input.isStarred ?? current.isStarred,
      folderIds: input.moveToFolderId
        ? [input.moveToFolderId]
        : current.folderIds,
      labelIds: [...labels],
    };
    account.messages.set(updated.id, updated);
    account.mailChanges.push({ type: "upsert_message", message: updated });

    const currentThread = account.threads.get(updated.threadId);
    if (currentThread) {
      const unreadCount = currentThread.messageIds.reduce(
        (count, messageId) =>
          count + (account.messages.get(messageId)?.isRead === false ? 1 : 0),
        0,
      );
      const thread = { ...currentThread, unreadCount };
      account.threads.set(thread.id, thread);
      account.mailChanges.push({ type: "upsert_thread", thread });
    }
    return updated;
  }

  private listEvents(
    context: ProviderContext,
    input: ListCalendarEventsInput,
  ): Page<CalendarEvent> {
    const account = this.getAccount(context);
    const calendarIds = input.calendarIds
      ? new Set(input.calendarIds)
      : undefined;
    const events = [...account.events.values()]
      .filter(
        (event) =>
          (!calendarIds || calendarIds.has(event.calendarId)) &&
          Date.parse(event.end) > Date.parse(input.from) &&
          Date.parse(event.start) < Date.parse(input.to),
      )
      .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
    return this.page(events, input.cursor, input.limit);
  }

  private upsertEvent(
    context: ProviderContext,
    input: UpsertCalendarEventInput,
  ): CalendarEvent {
    const account = this.getAccount(context);
    if (!account.calendars.has(input.calendarId)) {
      throw this.notFound(
        context,
        `Calendar '${input.calendarId}' was not found`,
      );
    }
    const id = input.id ?? `${context.account.id}-event-${++this.#sequence}`;
    const current = account.events.get(id);
    const event: CalendarEvent = {
      id,
      providerEventId: current?.providerEventId ?? id,
      calendarId: input.calendarId,
      title: input.title,
      description: input.description,
      location: input.location,
      start: input.start,
      end: input.end,
      timeZone: input.timeZone,
      allDay: input.allDay ?? false,
      attendees: input.attendees ?? [],
      meetingUrl: current?.meetingUrl,
      status: current?.status ?? "confirmed",
      providerData: input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : current?.providerData,
    };
    account.events.set(id, event);
    return event;
  }

  private page<T>(
    items: readonly T[],
    cursor?: string,
    requestedLimit?: number,
  ): Page<T> {
    const offset = this.parseCursor(cursor);
    const limit = this.normalizeLimit(requestedLimit);
    const pageItems = items.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    return {
      items: pageItems,
      nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
    };
  }

  private parseCursor(cursor?: string): number {
    if (cursor === undefined) {
      return 0;
    }
    const parsed = Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new MailProviderError(
        "INVALID_REQUEST",
        `Invalid in-memory cursor '${cursor}'`,
        { providerId: this.metadata.id },
      );
    }
    return parsed;
  }

  private normalizeLimit(limit?: number): number {
    return Math.max(1, Math.min(limit ?? 50, 100));
  }

  private uniqueAddresses(
    addresses: readonly { readonly address: string; readonly name?: string }[],
  ): readonly { readonly address: string; readonly name?: string }[] {
    const unique = new Map<string, { readonly address: string; readonly name?: string }>();
    for (const address of addresses) {
      unique.set(address.address.toLocaleLowerCase(), address);
    }
    return [...unique.values()];
  }

  private assertNotAborted(context: ProviderContext): void {
    context.signal?.throwIfAborted();
  }

  private notFound(context: ProviderContext, message: string): MailProviderError {
    return new MailProviderError("NOT_FOUND", message, {
      providerId: this.metadata.id,
      accountId: context.account.id,
    });
  }
}
