export type ProviderId = string;
export type AccountId = string;
export type ISODateTime = string;

export interface ConnectedMailAccount {
  readonly id: AccountId;
  readonly providerId: ProviderId;
  readonly emailAddress: string;
  readonly displayName?: string;
  readonly enabled: boolean;
}

export interface OAuth2Session {
  readonly kind: "oauth2";
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: ISODateTime;
  readonly scopes: readonly string[];
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface BasicAuthSession {
  readonly kind: "basic";
  readonly username: string;
  readonly password: string;
}

export interface MailServerConnection {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
}

export interface ImapSmtpSession {
  readonly kind: "imap_smtp";
  readonly imap: MailServerConnection;
  readonly smtp: MailServerConnection;
}

export type ProviderSession = OAuth2Session | BasicAuthSession | ImapSmtpSession;

/**
 * Server-side execution context. A ProviderSession contains secrets and must
 * never be serialized to a browser or written to application logs.
 */
export interface ProviderContext {
  readonly account: ConnectedMailAccount;
  readonly session: ProviderSession;
  readonly signal?: AbortSignal;
}

export interface AuthorizationStartInput {
  readonly callbackUrl: string;
  readonly state?: string;
  readonly loginHint?: string;
  readonly scopes?: readonly string[];
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier?: string;
}

export interface AuthorizationCallbackInput {
  readonly code: string;
  readonly callbackUrl: string;
  readonly state?: string;
  readonly codeVerifier?: string;
}

export interface ProviderAuthorizationOperations {
  createAuthorizationRequest(
    input: AuthorizationStartInput,
  ): Promise<AuthorizationRequest>;
  exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<ProviderSession>;
  refreshSession(session: ProviderSession): Promise<ProviderSession>;
  revokeSession(session: ProviderSession): Promise<void>;
}

export interface ProviderCapabilities {
  readonly authentication: "oauth2" | "basic" | "oauth2_or_basic";
  readonly mail: {
    readonly folders: boolean;
    readonly threads: boolean;
    readonly attachments: boolean;
    readonly drafts: boolean;
    readonly send: boolean;
    readonly modify: boolean;
    readonly incrementalSync: boolean;
    readonly pushNotifications: boolean;
  };
  readonly calendar: {
    readonly read: boolean;
    readonly write: boolean;
    readonly incrementalSync: boolean;
  };
}

export interface ProviderMetadata {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly icon?: string;
}

export interface ProviderConnectionCheck {
  readonly name:
    | "authentication"
    | "mail_read"
    | "smtp_connection"
    | "calendar_read";
  readonly status: "passed" | "skipped";
  readonly message?: string;
}

/**
 * A successful, read-only connection probe. Providers throw MailProviderError
 * when authentication, networking, or permissions fail.
 */
export interface ProviderConnectionTestResult {
  readonly ok: true;
  readonly checkedAt: ISODateTime;
  readonly latencyMs: number;
  readonly identity: string;
  readonly checks: readonly ProviderConnectionCheck[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface MailAddress {
  readonly address: string;
  readonly name?: string;
}

export type MailFolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "all"
  | "trash"
  | "spam"
  | "custom";

export interface MailFolder {
  readonly id: string;
  readonly providerFolderId: string;
  readonly name: string;
  readonly role: MailFolderRole;
  readonly parentId?: string;
  readonly unreadCount?: number;
  readonly totalCount?: number;
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface MailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly inline: boolean;
  readonly contentId?: string;
}

export interface MailMessage {
  readonly id: string;
  readonly providerMessageId: string;
  readonly threadId: string;
  readonly subject: string;
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly bcc: readonly MailAddress[];
  readonly sentAt: ISODateTime;
  readonly receivedAt: ISODateTime;
  readonly snippet: string;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly folderIds: readonly string[];
  readonly labelIds: readonly string[];
  readonly attachments: readonly MailAttachment[];
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface MailThread {
  readonly id: string;
  readonly providerThreadId: string;
  readonly subject: string;
  readonly snippet: string;
  readonly participants: readonly MailAddress[];
  readonly lastMessageAt: ISODateTime;
  readonly unreadCount: number;
  readonly messageIds: readonly string[];
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface MailThreadDetails {
  readonly thread: MailThread;
  readonly messages: readonly MailMessage[];
}

export interface ListThreadsInput {
  readonly folderId?: string;
  readonly query?: string;
  readonly unreadOnly?: boolean;
  readonly after?: ISODateTime;
  readonly before?: ISODateTime;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface OutgoingAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
  readonly inline?: boolean;
  readonly contentId?: string;
}

export interface SendMailInput {
  readonly from?: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc?: readonly MailAddress[];
  readonly bcc?: readonly MailAddress[];
  readonly subject: string;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly threadId?: string;
  readonly inReplyToMessageId?: string;
  readonly attachments?: readonly OutgoingAttachment[];
  readonly idempotencyKey?: string;
}

export interface UpdateMessageInput {
  readonly messageId: string;
  readonly isRead?: boolean;
  readonly isStarred?: boolean;
  readonly moveToFolderId?: string;
  readonly addLabelIds?: readonly string[];
  readonly removeLabelIds?: readonly string[];
}

export type MailSyncChange =
  | { readonly type: "upsert_folder"; readonly folder: MailFolder }
  | { readonly type: "delete_folder"; readonly folderId: string }
  | { readonly type: "upsert_thread"; readonly thread: MailThread }
  | { readonly type: "delete_thread"; readonly threadId: string }
  | { readonly type: "upsert_message"; readonly message: MailMessage }
  | { readonly type: "delete_message"; readonly messageId: string };

export interface MailSyncInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MailSyncPage {
  readonly changes: readonly MailSyncChange[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface MailOperations {
  listFolders(context: ProviderContext): Promise<readonly MailFolder[]>;
  listThreads(
    context: ProviderContext,
    input: ListThreadsInput,
  ): Promise<Page<MailThread>>;
  getThread(
    context: ProviderContext,
    threadId: string,
  ): Promise<MailThreadDetails>;
  sync(
    context: ProviderContext,
    input: MailSyncInput,
  ): Promise<MailSyncPage>;
  sendMessage(
    context: ProviderContext,
    input: SendMailInput,
  ): Promise<MailMessage>;
  updateMessage(
    context: ProviderContext,
    input: UpdateMessageInput,
  ): Promise<MailMessage>;
}

export interface CalendarSummary {
  readonly id: string;
  readonly providerCalendarId: string;
  readonly name: string;
  readonly color?: string;
  readonly readOnly: boolean;
  readonly primary: boolean;
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface CalendarEvent {
  readonly id: string;
  readonly providerEventId: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly timeZone?: string;
  readonly allDay: boolean;
  readonly attendees: readonly MailAddress[];
  readonly meetingUrl?: string;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface ListCalendarEventsInput {
  readonly calendarIds?: readonly string[];
  readonly from: ISODateTime;
  readonly to: ISODateTime;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface UpsertCalendarEventInput {
  readonly id?: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly timeZone?: string;
  readonly allDay?: boolean;
  readonly attendees?: readonly MailAddress[];
  readonly idempotencyKey?: string;
}

export interface CalendarProvider {
  listCalendars(context: ProviderContext): Promise<readonly CalendarSummary[]>;
  listEvents(
    context: ProviderContext,
    input: ListCalendarEventsInput,
  ): Promise<Page<CalendarEvent>>;
  upsertEvent(
    context: ProviderContext,
    input: UpsertCalendarEventInput,
  ): Promise<CalendarEvent>;
  deleteEvent(
    context: ProviderContext,
    calendarId: string,
    eventId: string,
  ): Promise<void>;
}

export type CalendarOperations = CalendarProvider;

export interface MailProvider {
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;
  readonly authorization: ProviderAuthorizationOperations;
  testConnection(context: ProviderContext): Promise<ProviderConnectionTestResult>;
  readonly mail: MailOperations;
  readonly calendar?: CalendarProvider;
}

export interface ProviderContextFactory {
  create(
    account: ConnectedMailAccount,
    signal?: AbortSignal,
  ): Promise<ProviderContext>;
}
