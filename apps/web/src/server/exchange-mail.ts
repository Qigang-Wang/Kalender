import { createHash } from "node:crypto";

import {
  attributeValue,
  decodeXml,
  elementContent,
  elementContents,
  elementText,
  escapeXml,
  exchangeSoapRequest,
  ExchangeEwsError,
  openingTag,
  type ExchangeCredential,
} from "./exchange-ews-client";

const DAYLINE_DRAFT_PROPERTY = '<t:ExtendedFieldURI PropertySetId="d672a86d-8b6b-4b4d-9ca8-0bc9fe919f63" PropertyName="DaylineDraftId" PropertyType="String"/>';

export async function findExchangeDraftByLocalId(credential: ExchangeCredential, localId: string): Promise<{ itemId: string; changeKey: string } | undefined> {
  const xml = await exchangeSoapRequest(credential, "FindItem", `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="2" Offset="0" BasePoint="Beginning"/><m:Restriction><t:IsEqualTo>${DAYLINE_DRAFT_PROPERTY}<t:FieldURIOrConstant><t:Constant Value="${escapeXml(localId)}"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction><m:ParentFolderIds><t:DistinguishedFolderId Id="drafts"/></m:ParentFolderIds></m:FindItem>`, AbortSignal.timeout(30000));
  const matches = parseMessageIdentities(xml);
  if (matches.length > 1) throw new ExchangeEwsError("REMOTE_CONFLICT", "Exchange 中存在多个关联草稿，请先在邮箱中核对", 409);
  const match = matches[0];
  return match?.changeKey ? { itemId: match.itemId, changeKey: match.changeKey } : undefined;
}

export interface ExchangeMailFolder {
  readonly folderId: string;
  readonly changeKey?: string;
  readonly name: string;
  readonly role: "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "other";
  readonly parentFolderId?: string;
  readonly unreadCount?: number;
  readonly totalCount?: number;
  readonly sortOrder?: number;
}

export interface ExchangeMailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly inline: boolean;
  readonly contentId?: string;
}

export interface ExchangeMailMessage {
  readonly itemId: string;
  readonly changeKey?: string;
  readonly conversationId?: string;
  readonly internetMessageId?: string;
  readonly subject: string;
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc: readonly { readonly address: string; readonly name?: string }[];
  readonly bcc?: readonly { readonly address: string; readonly name?: string }[];
  readonly isDraft?: boolean;
  readonly localDraftId?: string;
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly sizeBytes?: number;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly snippet: string;
  readonly attachments: readonly ExchangeMailAttachment[];
}

export interface ExchangeMailSyncChanges {
  readonly syncState: string;
  readonly includesLastItem: boolean;
  readonly messages: readonly ExchangeMailMessage[];
  readonly deletedItemIds: readonly string[];
  readonly readFlagChanges: readonly { readonly itemId: string; readonly isRead: boolean }[];
}

export interface ExchangeSendAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly inline?: boolean;
  readonly contentId?: string;
}

const distinguishedFolders = [
  ["inbox", "inbox"],
  ["sentitems", "sent"],
  ["drafts", "drafts"],
  ["deleteditems", "trash"],
  ["junkemail", "junk"],
] as const;

export async function discoverExchangeMailbox(
  credential: ExchangeCredential,
  signal?: AbortSignal,
): Promise<readonly ExchangeMailFolder[]> {
  const distinguishedXml = await exchangeSoapRequest(credential, "GetFolder", `
    <m:GetFolder>
      <m:FolderShape><t:BaseShape>AllProperties</t:BaseShape></m:FolderShape>
      <m:FolderIds>${distinguishedFolders.map(([id]) => `<t:DistinguishedFolderId Id="${id}"/>`).join("")}</m:FolderIds>
    </m:GetFolder>`, signal);
  const distinguished = parseExchangeMailboxFolders(distinguishedXml);
  const roles = new Map(distinguished.map((folder) => [folder.folderId, folder.role]));
  const discovered: ExchangeMailFolder[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const xml = await exchangeSoapRequest(credential, "FindFolder", `
      <m:FindFolder Traversal="Deep">
        <m:FolderShape><t:BaseShape>AllProperties</t:BaseShape></m:FolderShape>
        <m:IndexedPageFolderView MaxEntriesReturned="1000" Offset="${offset}" BasePoint="Beginning"/>
        <m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>
      </m:FindFolder>`, signal);
    discovered.push(...parseExchangeFolderTree(xml, roles).map((folder, index) => ({ ...folder, sortOrder: offset + index })));
    const rootTag = openingTag(xml, "RootFolder");
    if (!rootTag || attributeValue(rootTag, "IncludesLastItemInRange")?.toLocaleLowerCase() !== "false") break;
    const nextOffset = Number.parseInt(attributeValue(rootTag, "IndexedPagingOffset") ?? "", 10);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) break;
    offset = nextOffset;
  }
  const merged = new Map<string, ExchangeMailFolder>();
  for (const folder of [...distinguished, ...discovered]) merged.set(folder.folderId, folder);
  return [...merged.values()];
}

export function parseExchangeMailboxFolders(xml: string): readonly ExchangeMailFolder[] {
  // Exchange commonly serializes mail folders as the generic t:Folder type.
  // Some server versions use t:MessageFolder, so accept both without relying on
  // locale-specific display names such as "Posteingang".
  const folders = [...elementContents(xml, "MessageFolder"), ...elementContents(xml, "Folder")];
  return folders.flatMap((folder, index) => {
    const tag = openingTag(folder, "FolderId");
    const folderId = tag ? attributeValue(tag, "Id") : undefined;
    if (!folderId) return [];
    return [{
      folderId,
      changeKey: tag ? attributeValue(tag, "ChangeKey") : undefined,
      name: elementText(folder, "DisplayName") || distinguishedFolders[index]?.[0] || "Exchange",
      role: distinguishedFolders[index]?.[1] ?? "other",
      unreadCount: optionalNumber(elementText(folder, "UnreadCount")),
      totalCount: optionalNumber(elementText(folder, "TotalCount")),
      sortOrder: index,
    } satisfies ExchangeMailFolder];
  });
}

export function parseExchangeFolderTree(
  xml: string,
  roles: ReadonlyMap<string, ExchangeMailFolder["role"]> = new Map(),
): readonly ExchangeMailFolder[] {
  const folders = [...elementContents(xml, "MessageFolder"), ...elementContents(xml, "Folder")];
  return folders.flatMap((folder, index) => {
    const tag = openingTag(folder, "FolderId");
    const folderId = tag ? attributeValue(tag, "Id") : undefined;
    if (!folderId) return [];
    const parentTag = openingTag(folder, "ParentFolderId");
    return [{
      folderId,
      changeKey: tag ? attributeValue(tag, "ChangeKey") : undefined,
      name: elementText(folder, "DisplayName") || "Exchange",
      role: roles.get(folderId) ?? inferExchangeFolderRole(elementText(folder, "DisplayName")),
      parentFolderId: parentTag ? attributeValue(parentTag, "Id") : undefined,
      unreadCount: optionalNumber(elementText(folder, "UnreadCount")),
      totalCount: optionalNumber(elementText(folder, "TotalCount")),
      sortOrder: index,
    } satisfies ExchangeMailFolder];
  });
}

function inferExchangeFolderRole(name: string): ExchangeMailFolder["role"] {
  const normalized = name.trim().toLocaleLowerCase("de-DE");
  if (["archive", "archiv"].includes(normalized)) return "archive";
  return "other";
}

export async function fetchExchangeMailMessages(
  credential: ExchangeCredential,
  folder: ExchangeMailFolder,
  maximumMessages: number,
  signal?: AbortSignal,
): Promise<readonly ExchangeMailMessage[]> {
  const limit = Math.max(1, Math.min(maximumMessages, 500));
  const xml = await exchangeSoapRequest(credential, "FindItem", `
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="item:DateTimeSent"/>
          <t:FieldURI FieldURI="item:Size"/>
          <t:FieldURI FieldURI="message:IsRead"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${limit}" Offset="0" BasePoint="Beginning"/>
      <m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder>
      <m:ParentFolderIds><t:FolderId Id="${escapeXml(folder.folderId)}"/></m:ParentFolderIds>
    </m:FindItem>`, signal);
  const identities = parseMessageIdentities(xml);
  return fetchExchangeMailMessageDetails(credential, identities, signal);
}

export async function fetchExchangeMailMessageDetails(
  credential: ExchangeCredential,
  identities: readonly { readonly itemId: string; readonly changeKey?: string }[],
  signal?: AbortSignal,
): Promise<readonly ExchangeMailMessage[]> {
  if (!identities.length) return [];
  const messages: ExchangeMailMessage[] = [];
  for (let index = 0; index < identities.length; index += 20) {
    const batch = identities.slice(index, index + 20);
    const details = await exchangeSoapRequest(credential, "GetItem", `
      <m:GetItem>
        <m:ItemShape>
          <t:BaseShape>AllProperties</t:BaseShape>
          <t:BodyType>HTML</t:BodyType>
          <t:AdditionalProperties>${DAYLINE_DRAFT_PROPERTY}</t:AdditionalProperties>
        </m:ItemShape>
        <m:ItemIds>${batch.map((item) => `<t:ItemId Id="${escapeXml(item.itemId)}"${item.changeKey ? ` ChangeKey="${escapeXml(item.changeKey)}"` : ""}/>`).join("")}</m:ItemIds>
      </m:GetItem>`, signal);
    messages.push(...parseExchangeMessages(details));
  }
  return messages;
}

export async function fetchExchangeMailMimeContent(
  credential: ExchangeCredential,
  itemId: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const xml = await exchangeSoapRequest(credential, "GetItem", `
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:IncludeMimeContent>true</t:IncludeMimeContent>
      </m:ItemShape>
      <m:ItemIds><t:ItemId Id="${escapeXml(itemId)}"/></m:ItemIds>
    </m:GetItem>`, signal);
  const encoded = elementText(xml, "MimeContent").replace(/\s+/g, "");
  if (!encoded) return undefined;
  if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new Error("Exchange 返回了无效的 MIME 内容");
  const content = Buffer.from(encoded, "base64");
  if (content.byteLength > 25 * 1024 * 1024) throw new Error("邮件 MIME 内容超过 25 MB 安全上限");
  return new Uint8Array(content);
}

export async function syncExchangeMailFolder(
  credential: ExchangeCredential,
  folder: ExchangeMailFolder,
  syncState: string | undefined,
  maximumChanges: number,
  signal?: AbortSignal,
): Promise<ExchangeMailSyncChanges> {
  const xml = await exchangeSoapRequest(credential, "SyncFolderItems", `
    <m:SyncFolderItems>
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
      <m:SyncFolderId><t:FolderId Id="${escapeXml(folder.folderId)}"/></m:SyncFolderId>
      ${syncState ? `<m:SyncState>${escapeXml(syncState)}</m:SyncState>` : ""}
      <m:MaxChangesReturned>${Math.max(1, Math.min(maximumChanges, 512))}</m:MaxChangesReturned>
      <m:SyncScope>NormalItems</m:SyncScope>
    </m:SyncFolderItems>`, signal);
  const response = elementContent(xml, "SyncFolderItemsResponseMessage") ?? xml;
  const changes = elementContent(response, "Changes") ?? "";
  const changedIdentities = ["Create", "Update"].flatMap((name) =>
    elementContents(changes, name).flatMap((change) => parseMessageIdentities(change)),
  );
  const deletedItemIds = elementContents(changes, "Delete").flatMap((change) => {
    const tag = openingTag(change, "ItemId");
    const itemId = tag ? attributeValue(tag, "Id") : undefined;
    return itemId ? [itemId] : [];
  });
  const readFlagChanges = elementContents(changes, "ReadFlagChange").flatMap((change) => {
    const tag = openingTag(change, "ItemId");
    const itemId = tag ? attributeValue(tag, "Id") : undefined;
    return itemId ? [{ itemId, isRead: elementText(change, "IsRead").toLocaleLowerCase() === "true" }] : [];
  });
  const nextState = elementText(response, "SyncState");
  if (!nextState) throw new Error("Exchange 增量同步没有返回同步游标");
  return {
    syncState: nextState,
    includesLastItem: elementText(response, "IncludesLastItemInRange").toLocaleLowerCase() !== "false",
    messages: await fetchExchangeMailMessageDetails(credential, uniqueIdentities(changedIdentities), signal),
    deletedItemIds,
    readFlagChanges,
  };
}

export function exchangeMessageLocalId(accountId: string, itemId: string): string {
  return `exchange-message:${digest(`${accountId}:${itemId}`, 28)}`;
}

export function exchangeFolderLocalId(accountId: string, folderId: string): string {
  return `exchange-folder:${digest(`${accountId}:${folderId}`, 28)}`;
}

export function exchangeThreadLocalId(accountId: string, conversationId: string | undefined, itemId: string): string {
  return `exchange-thread:${digest(`${accountId}:${conversationId || itemId}`, 28)}`;
}

export function exchangeProviderUid(itemId: string): number {
  return Math.max(1, Number.parseInt(digest(itemId, 7), 16) & 0x7fffffff);
}

export async function updateExchangeMessageFlags(
  credential: ExchangeCredential,
  itemId: string,
  input: { readonly isRead: boolean; readonly isStarred: boolean },
  signal?: AbortSignal,
): Promise<void> {
  const identityXml = await exchangeSoapRequest(credential, "GetItem", `
    <m:GetItem>
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
      <m:ItemIds><t:ItemId Id="${escapeXml(itemId)}"/></m:ItemIds>
    </m:GetItem>`, signal);
  const currentTag = openingTag(elementContent(identityXml, "Message") ?? identityXml, "ItemId");
  const changeKey = currentTag ? attributeValue(currentTag, "ChangeKey") : undefined;
  if (!changeKey) throw new Error("Exchange 没有返回邮件的最新 ChangeKey");
  const now = new Date();
  const due = new Date(now.getTime() + 7 * 86_400_000);
  const flag = input.isStarred
    ? `<t:Flag><t:FlagStatus>Flagged</t:FlagStatus><t:StartDate>${now.toISOString()}</t:StartDate><t:DueDate>${due.toISOString()}</t:DueDate></t:Flag>`
    : `<t:Flag><t:FlagStatus>NotFlagged</t:FlagStatus></t:Flag>`;
  await exchangeSoapRequest(credential, "UpdateItem", `
    <m:UpdateItem ConflictResolution="AutoResolve" MessageDisposition="SaveOnly">
      <m:ItemChanges><t:ItemChange>
        <t:ItemId Id="${escapeXml(itemId)}" ChangeKey="${escapeXml(changeKey)}"/>
        <t:Updates>
          <t:SetItemField><t:FieldURI FieldURI="message:IsRead"/><t:Message><t:IsRead>${input.isRead}</t:IsRead></t:Message></t:SetItemField>
          <t:SetItemField><t:FieldURI FieldURI="item:Flag"/><t:Message>${flag}</t:Message></t:SetItemField>
        </t:Updates>
      </t:ItemChange></m:ItemChanges>
    </m:UpdateItem>`, signal);
}

export async function moveExchangeMessage(
  credential: ExchangeCredential,
  itemId: string,
  destinationFolderId: string,
  signal?: AbortSignal,
): Promise<void> {
  await exchangeSoapRequest(credential, "MoveItem", `
    <m:MoveItem>
      <m:ToFolderId><t:FolderId Id="${escapeXml(destinationFolderId)}"/></m:ToFolderId>
      <m:ItemIds><t:ItemId Id="${escapeXml(itemId)}"/></m:ItemIds>
    </m:MoveItem>`, signal);
}

export async function createExchangeMailFolder(
  credential: ExchangeCredential,
  name: string,
  parentFolderId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const xml = await exchangeSoapRequest(credential, "CreateFolder", `
    <m:CreateFolder>
      <m:ParentFolderId>${parentFolderId
        ? `<t:FolderId Id="${escapeXml(parentFolderId)}"/>`
        : `<t:DistinguishedFolderId Id="msgfolderroot"/>`}</m:ParentFolderId>
      <m:Folders><t:Folder><t:FolderClass>IPF.Note</t:FolderClass><t:DisplayName>${escapeXml(name)}</t:DisplayName></t:Folder></m:Folders>
    </m:CreateFolder>`, signal);
  const folderTag = openingTag(elementContent(xml, "Folders") ?? xml, "FolderId");
  const folderId = folderTag ? attributeValue(folderTag, "Id") : undefined;
  if (!folderId) throw new Error("Exchange 创建了文件夹，但没有返回文件夹标识");
  return folderId;
}

export async function renameExchangeMailFolder(
  credential: ExchangeCredential,
  folderId: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const identityXml = await exchangeSoapRequest(credential, "GetFolder", `
    <m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
      <m:FolderIds><t:FolderId Id="${escapeXml(folderId)}"/></m:FolderIds></m:GetFolder>`, signal);
  const currentTag = openingTag(elementContent(identityXml, "Folders") ?? identityXml, "FolderId");
  const changeKey = currentTag ? attributeValue(currentTag, "ChangeKey") : undefined;
  if (!changeKey) throw new Error("Exchange 没有返回文件夹的最新 ChangeKey");
  await exchangeSoapRequest(credential, "UpdateFolder", `
    <m:UpdateFolder><m:FolderChanges><t:FolderChange>
      <t:FolderId Id="${escapeXml(folderId)}" ChangeKey="${escapeXml(changeKey)}"/>
      <t:Updates><t:SetFolderField><t:FieldURI FieldURI="folder:DisplayName"/>
        <t:Folder><t:DisplayName>${escapeXml(name)}</t:DisplayName></t:Folder>
      </t:SetFolderField></t:Updates>
    </t:FolderChange></m:FolderChanges></m:UpdateFolder>`, signal);
}

export async function moveExchangeMailFolder(
  credential: ExchangeCredential,
  folderId: string,
  parentFolderId?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const xml = await exchangeSoapRequest(credential, "MoveFolder", `
    <m:MoveFolder>
      <m:ToFolderId>${parentFolderId
        ? `<t:FolderId Id="${escapeXml(parentFolderId)}"/>`
        : `<t:DistinguishedFolderId Id="msgfolderroot"/>`}</m:ToFolderId>
      <m:FolderIds><t:FolderId Id="${escapeXml(folderId)}"/></m:FolderIds>
    </m:MoveFolder>`, signal);
  const folderTag = openingTag(elementContent(xml, "Folders") ?? xml, "FolderId");
  return folderTag ? attributeValue(folderTag, "Id") : undefined;
}

export async function deleteExchangeMailFolder(
  credential: ExchangeCredential,
  folderId: string,
  signal?: AbortSignal,
): Promise<void> {
  await exchangeSoapRequest(credential, "DeleteFolder", `
    <m:DeleteFolder DeleteType="MoveToDeletedItems">
      <m:FolderIds><t:FolderId Id="${escapeXml(folderId)}"/></m:FolderIds>
    </m:DeleteFolder>`, signal);
}

export interface ExchangeDraftInput {
  readonly localDraftId?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
  readonly attachments: readonly ExchangeSendAttachment[];
  readonly replyToItemId?: string;
}

export async function saveExchangeMailDraft(
  credential: ExchangeCredential,
  input: ExchangeDraftInput,
  identity?: { itemId: string; changeKey: string },
  signal?: AbortSignal,
  onCreated?: (identity: { itemId: string; changeKey: string }) => Promise<void>,
): Promise<{ itemId: string; changeKey: string }> {
  const current = identity ? (await fetchExchangeMailMessageDetails(credential, [{ itemId: identity.itemId }], signal))[0] : undefined;
  if (identity && (!current?.isDraft || current.changeKey !== identity.changeKey)) throw new ExchangeEwsError("REMOTE_CONFLICT", "Exchange 草稿已被修改或发送，请先解决版本冲突", 409);
  let replyId: string | undefined;
  if (input.replyToItemId) {
    const xml = await exchangeSoapRequest(credential, "GetItem", `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="message:InternetMessageId"/></t:AdditionalProperties></m:ItemShape><m:ItemIds><t:ItemId Id="${escapeXml(input.replyToItemId)}"/></m:ItemIds></m:GetItem>`, signal);
    replyId = elementText(xml, "InternetMessageId") || undefined;
  }
  const fields: Array<[string, string]> = [
    ["item:Subject", `<t:Subject>${escapeXml(input.subject)}</t:Subject>`],
    ["item:Body", `<t:Body BodyType="${input.htmlBody ? "HTML" : "Text"}">${escapeXml(input.htmlBody ?? input.textBody)}</t:Body>`],
    ...(replyId ? [["item:InReplyTo", `<t:InReplyTo>${escapeXml(replyId)}</t:InReplyTo>`]] as Array<[string, string]> : []),
    ...(!identity && input.localDraftId ? [["", `<t:ExtendedProperty>${DAYLINE_DRAFT_PROPERTY}<t:Value>${escapeXml(input.localDraftId)}</t:Value></t:ExtendedProperty>`]] as Array<[string, string]> : []),
    ["message:ToRecipients", recipientXml("ToRecipients", input.to)],
    ["message:CcRecipients", recipientXml("CcRecipients", input.cc)],
    ["message:BccRecipients", recipientXml("BccRecipients", input.bcc)],
    ...(replyId ? [["message:References", `<t:References>${escapeXml(replyId)}</t:References>`]] as Array<[string, string]> : []),
  ];
  const xml = identity
    ? await exchangeSoapRequest(credential, "UpdateItem", `<m:UpdateItem ConflictResolution="NeverOverwrite" MessageDisposition="SaveOnly"><m:ItemChanges><t:ItemChange><t:ItemId Id="${escapeXml(identity.itemId)}" ChangeKey="${escapeXml(identity.changeKey)}"/><t:Updates>${fields.map(([uri, value]) => value ? `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:Message>${value}</t:Message></t:SetItemField>` : `<t:DeleteItemField><t:FieldURI FieldURI="${uri}"/></t:DeleteItemField>`).join("")}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`, signal)
    : await exchangeSoapRequest(credential, "CreateItem", `<m:CreateItem MessageDisposition="SaveOnly"><m:SavedItemFolderId><t:DistinguishedFolderId Id="drafts"/></m:SavedItemFolderId><m:Items><t:Message>${fields.map(([, value]) => value).join("")}</t:Message></m:Items></m:CreateItem>`, signal);
  const itemTag = openingTag(elementContent(xml, "Message") ?? xml, "ItemId");
  const itemId = itemTag ? attributeValue(itemTag, "Id") : identity?.itemId;
  let changeKey = itemTag ? attributeValue(itemTag, "ChangeKey") : undefined;
  if (!itemId || !changeKey) throw new Error("Exchange 草稿缺少版本标识");
  if (!identity) await onCreated?.({ itemId, changeKey });
  if (current?.attachments.length) {
    const deleted = await exchangeSoapRequest(credential, "DeleteAttachment", `<m:DeleteAttachment><m:AttachmentIds>${current.attachments.map((attachment) => `<t:AttachmentId Id="${escapeXml(attachment.id)}"/>`).join("")}</m:AttachmentIds></m:DeleteAttachment>`, signal);
    changeKey = attributeValue(deleted.match(/<(?:[\w-]+:)?RootItemId\b[^>]*>/g)?.at(-1) ?? "", "RootItemChangeKey") ?? changeKey;
  }
  if (input.attachments.length) {
    const attached = await exchangeSoapRequest(credential, "CreateAttachment", `<m:CreateAttachment><m:ParentItemId Id="${escapeXml(itemId)}" ChangeKey="${escapeXml(changeKey)}"/><m:Attachments>${input.attachments.map((attachment) => `<t:FileAttachment><t:Name>${escapeXml(attachment.filename)}</t:Name><t:ContentType>${escapeXml(attachment.contentType)}</t:ContentType>${attachment.contentId ? `<t:ContentId>${escapeXml(attachment.contentId)}</t:ContentId>` : ""}<t:IsInline>${Boolean(attachment.inline)}</t:IsInline><t:Content>${Buffer.from(attachment.content).toString("base64")}</t:Content></t:FileAttachment>`).join("")}</m:Attachments></m:CreateAttachment>`, signal);
    changeKey = attributeValue(attached.match(/<(?:[\w-]+:)?AttachmentId\b[^>]*>/g)?.at(-1) ?? "", "RootItemChangeKey") ?? changeKey;
  }
  return { itemId, changeKey };
}

export async function sendExchangeMessage(credential: ExchangeCredential, input: ExchangeDraftInput, signal?: AbortSignal, identity?: { itemId: string; changeKey: string }): Promise<string> {
  const draft = await saveExchangeMailDraft(credential, input, identity, signal);
  await sendExchangeSavedDraft(credential, draft, signal);
  return draft.itemId;
}

export async function sendExchangeSavedDraft(credential: ExchangeCredential, identity: { itemId: string; changeKey: string }, signal?: AbortSignal) {
  await exchangeSoapRequest(credential, "SendItem", `<m:SendItem SaveItemToFolder="true"><m:ItemIds><t:ItemId Id="${escapeXml(identity.itemId)}" ChangeKey="${escapeXml(identity.changeKey)}"/></m:ItemIds><m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId></m:SendItem>`, signal);
}

export async function deleteExchangeDraft(credential: ExchangeCredential, identity: { itemId: string; changeKey: string }) {
  const current = (await fetchExchangeMailMessageDetails(credential, [{ itemId: identity.itemId }], AbortSignal.timeout(30000)))[0];
  if (!current?.isDraft || current.changeKey !== identity.changeKey) throw new ExchangeEwsError("REMOTE_CONFLICT", "Exchange 草稿已变化，请先同步", 409);
  await exchangeSoapRequest(credential, "DeleteItem", `<m:DeleteItem DeleteType="MoveToDeletedItems"><m:ItemIds><t:ItemId Id="${escapeXml(identity.itemId)}" ChangeKey="${escapeXml(identity.changeKey)}"/></m:ItemIds></m:DeleteItem>`, AbortSignal.timeout(30000));
}

export async function getExchangeAttachment(
  credential: ExchangeCredential,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<{ readonly filename: string; readonly contentType: string; readonly content: Uint8Array }> {
  const xml = await exchangeSoapRequest(credential, "GetAttachment", `
    <m:GetAttachment>
      <m:AttachmentShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:AttachmentShape>
      <m:AttachmentIds><t:AttachmentId Id="${escapeXml(attachmentId)}"/></m:AttachmentIds>
    </m:GetAttachment>`, signal);
  const itemAttachment = elementContent(xml, "ItemAttachment");
  const attachment = elementContent(xml, "FileAttachment") ?? itemAttachment;
  if (!attachment) throw new Error("Exchange 没有返回附件");
  const content = elementText(attachment, itemAttachment ? "MimeContent" : "Content");
  if (!content) throw new Error("Exchange 附件内容为空");
  return {
    filename: itemAttachment ? `${(elementText(attachment, "Name") || "message").replace(/\.eml$/i, "")}.eml` : elementText(attachment, "Name") || "attachment",
    contentType: itemAttachment ? "message/rfc822" : elementText(attachment, "ContentType") || "application/octet-stream",
    content: new Uint8Array(Buffer.from(content, "base64")),
  };
}

function parseMessageIdentities(xml: string): readonly { readonly itemId: string; readonly changeKey?: string }[] {
  return elementContents(xml, "Message").flatMap((message) => {
    const tag = openingTag(message, "ItemId");
    const itemId = tag ? attributeValue(tag, "Id") : undefined;
    return itemId ? [{ itemId, changeKey: attributeValue(tag!, "ChangeKey") }] : [];
  });
}

function uniqueIdentities(input: readonly { readonly itemId: string; readonly changeKey?: string }[]) {
  return [...new Map(input.map((item) => [item.itemId, item])).values()];
}

export function parseExchangeMessages(xml: string): readonly ExchangeMailMessage[] {
  return elementContents(xml, "Message").flatMap((message) => {
    const itemTag = openingTag(message, "ItemId");
    const itemId = itemTag ? attributeValue(itemTag, "Id") : undefined;
    if (!itemId) return [];
    const conversationTag = openingTag(message, "ConversationId");
    const conversationId = conversationTag ? attributeValue(conversationTag, "Id") : undefined;
    const bodyTag = openingTag(message, "Body");
    const rawBody = elementContent(message, "Body");
    const body = rawBody === undefined ? undefined : decodeXml(rawBody).trim();
    const bodyType = bodyTag ? attributeValue(bodyTag, "BodyType")?.toLocaleLowerCase() : undefined;
    const receivedAt = validDate(elementText(message, "DateTimeReceived")) ?? validDate(elementText(message, "DateTimeSent")) ?? new Date().toISOString();
    const sentAt = validDate(elementText(message, "DateTimeSent")) ?? receivedAt;
    const sender = parseMailbox(elementContent(message, "From")) ?? parseMailbox(elementContent(message, "Sender")) ?? { address: "unknown@invalid.local" };
    const htmlBody = bodyType === "html" ? body : undefined;
    const textBody = bodyType === "html" ? undefined : body;
    const preview = elementText(message, "Preview") || bodyToSnippet(body ?? "");
    return [{
      itemId,
      changeKey: itemTag ? attributeValue(itemTag, "ChangeKey") : undefined,
      conversationId,
      internetMessageId: elementText(message, "InternetMessageId") || undefined,
      subject: elementText(message, "Subject") || "(无主题)",
      from: sender,
      to: parseMailboxes(elementContent(message, "ToRecipients")),
      cc: parseMailboxes(elementContent(message, "CcRecipients")),
      bcc: parseMailboxes(elementContent(message, "BccRecipients")),
      isDraft: elementText(message, "IsDraft") === "true",
      localDraftId: elementText(elementContents(message, "ExtendedProperty").find((property) => attributeValue(openingTag(property, "ExtendedFieldURI") ?? "", "PropertyName") === "DaylineDraftId" && attributeValue(openingTag(property, "ExtendedFieldURI") ?? "", "PropertySetId")?.toLowerCase() === "d672a86d-8b6b-4b4d-9ca8-0bc9fe919f63") ?? "", "Value") || undefined,
      sentAt,
      receivedAt,
      isRead: elementText(message, "IsRead").toLocaleLowerCase() === "true",
      isStarred: elementText(message, "FlagStatus").toLocaleLowerCase() === "flagged",
      sizeBytes: optionalNumber(elementText(message, "Size")),
      textBody,
      htmlBody,
      snippet: preview,
      attachments: parseAttachments(message),
    } satisfies ExchangeMailMessage];
  });
}

function parseAttachments(message: string): readonly ExchangeMailAttachment[] {
  const items = [...elementContents(message, "FileAttachment"), ...elementContents(message, "ItemAttachment")];
  return items.flatMap((attachment) => {
    const tag = openingTag(attachment, "AttachmentId");
    const id = tag ? attributeValue(tag, "Id") : undefined;
    if (!id) return [];
    return [{
      id,
      filename: elementText(attachment, "Name") || "attachment",
      contentType: elementText(attachment, "ContentType") || "application/octet-stream",
      sizeBytes: optionalNumber(elementText(attachment, "Size")) ?? 0,
      inline: elementText(attachment, "IsInline").toLocaleLowerCase() === "true",
      contentId: elementText(attachment, "ContentId") || undefined,
    }];
  });
}

function parseMailbox(xml?: string): { readonly address: string; readonly name?: string } | undefined {
  if (!xml) return undefined;
  const mailbox = elementContent(xml, "Mailbox") ?? xml;
  const address = elementText(mailbox, "EmailAddress");
  return address ? { address, name: elementText(mailbox, "Name") || undefined } : undefined;
}

function parseMailboxes(xml?: string): readonly { readonly address: string; readonly name?: string }[] {
  if (!xml) return [];
  return elementContents(xml, "Mailbox").flatMap((mailbox) => {
    const address = elementText(mailbox, "EmailAddress");
    return address ? [{ address, name: elementText(mailbox, "Name") || undefined }] : [];
  });
}

function bodyToSnippet(value: string): string {
  const plain = decodeXml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return plain.length > 240 ? `${plain.slice(0, 237)}…` : plain;
}

function optionalNumber(value: string): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function validDate(value: string): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function recipientXml(name: "ToRecipients" | "CcRecipients" | "BccRecipients", addresses: readonly string[]): string {
  if (!addresses.length) return "";
  return `<t:${name}>${addresses.map((address) => `<t:Mailbox><t:EmailAddress>${escapeXml(address)}</t:EmailAddress></t:Mailbox>`).join("")}</t:${name}>`;
}
