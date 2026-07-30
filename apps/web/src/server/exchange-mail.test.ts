function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const { parseExchangeFolderTree, parseExchangeMailboxFolders, parseExchangeMessages } = await import("./exchange-mail");
  const {
    assertExchangeSuccess,
    ExchangeEwsError,
    isExchangeItemNotFoundError,
  } = await import("./exchange-ews-client");
  const folderXml = `<s:Envelope><s:Body><m:GetFolderResponse><m:ResponseMessages>
    <m:GetFolderResponseMessage><m:ResponseCode>NoError</m:ResponseCode><m:Folders>
      <t:Folder><t:FolderId Id="inbox-id" ChangeKey="inbox-key"/><t:DisplayName>Posteingang</t:DisplayName><t:TotalCount>42</t:TotalCount><t:UnreadCount>7</t:UnreadCount></t:Folder>
      <t:Folder><t:FolderId Id="sent-id"/><t:DisplayName>Gesendete Elemente</t:DisplayName><t:TotalCount>12</t:TotalCount><t:UnreadCount>0</t:UnreadCount></t:Folder>
    </m:Folders></m:GetFolderResponseMessage>
  </m:ResponseMessages></m:GetFolderResponse></s:Body></s:Envelope>`;
  const folders = parseExchangeMailboxFolders(folderXml);
  assert(folders.length === 2, "generic EWS Folder nodes are accepted");
  assert(folders[0]?.role === "inbox" && folders[0]?.unreadCount === 7, "localized inbox is mapped by distinguished folder order");
  assert(folders[1]?.role === "sent", "sent folder role is retained independently of localized display name");

  const treeXml = `<s:Envelope><s:Body><m:FindFolderResponse><m:ResponseMessages>
    <m:FindFolderResponseMessage><m:ResponseCode>NoError</m:ResponseCode><m:RootFolder IncludesLastItemInRange="true"><t:Folders>
      <t:Folder><t:FolderId Id="projects"/><t:ParentFolderId Id="root"/><t:DisplayName>Projekte</t:DisplayName><t:TotalCount>8</t:TotalCount></t:Folder>
      <t:Folder><t:FolderId Id="project-a"/><t:ParentFolderId Id="projects"/><t:DisplayName>Projekt A</t:DisplayName><t:UnreadCount>2</t:UnreadCount></t:Folder>
    </t:Folders></m:RootFolder></m:FindFolderResponseMessage>
  </m:ResponseMessages></m:FindFolderResponse></s:Body></s:Envelope>`;
  const tree = parseExchangeFolderTree(treeXml);
  assert(tree.length === 2, "deep EWS folder results are accepted");
  assert(tree[1]?.parentFolderId === "projects", "nested EWS folder parent identity is retained");

  const messageXml = `<s:Envelope><s:Body><m:GetItemResponse><m:ResponseMessages>
    <m:GetItemResponseMessage><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message>
      <t:ItemId Id="item-1" ChangeKey="change-1"/><t:ConversationId Id="conversation-1"/>
      <t:Subject>测试 &amp; Mail</t:Subject><t:Body BodyType="HTML">&lt;p&gt;Hello&lt;/p&gt;</t:Body>
      <t:DateTimeReceived>2026-07-22T08:00:00Z</t:DateTimeReceived><t:DateTimeSent>2026-07-22T07:59:00Z</t:DateTimeSent>
      <t:From><t:Mailbox><t:Name>Anna</t:Name><t:EmailAddress>anna@example.test</t:EmailAddress></t:Mailbox></t:From>
      <t:ToRecipients><t:Mailbox><t:EmailAddress>adam@example.test</t:EmailAddress></t:Mailbox></t:ToRecipients>
      <t:IsRead>false</t:IsRead><t:Size>1234</t:Size><t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag>
      <t:Attachments>
        <t:FileAttachment><t:AttachmentId Id="attachment-1"/><t:Name>report.pdf</t:Name><t:ContentType>application/pdf</t:ContentType><t:Size>99</t:Size></t:FileAttachment>
        <t:FileAttachment><t:AttachmentId Id="attachment-2"/><t:Name>logo.png</t:Name><t:ContentType>image/png</t:ContentType><t:Size>42</t:Size><t:IsInline>true</t:IsInline><t:ContentId>logo@example.test</t:ContentId></t:FileAttachment>
      </t:Attachments>
    </t:Message></m:Items></m:GetItemResponseMessage>
  </m:ResponseMessages></m:GetItemResponse></s:Body></s:Envelope>`;
  const messages = parseExchangeMessages(messageXml);
  assert(messages.length === 1, "EWS Message is parsed");
  assert(messages[0]?.subject === "测试 & Mail", "message subject entities are decoded");
  assert(messages[0]?.htmlBody === "<p>Hello</p>", "HTML body is decoded");
  assert(messages[0]?.from.address === "anna@example.test", "sender is parsed");
  assert(messages[0]?.isRead === false && messages[0]?.isStarred === true, "read and flag states are parsed");
  assert(messages[0]?.attachments[0]?.id === "attachment-1", "attachment identity is retained for lazy download");
  assert(messages[0]?.attachments[1]?.inline && messages[0]?.attachments[1]?.contentId === "logo@example.test", "inline attachment CID is retained");

  const missingItemXml = `<s:Envelope><s:Body><m:MoveItemResponse><m:ResponseMessages>
    <m:MoveItemResponseMessage ResponseClass="Error">
      <m:MessageText>The specified object was not found in the store.</m:MessageText>
      <m:ResponseCode>ErrorItemNotFound</m:ResponseCode>
    </m:MoveItemResponseMessage>
  </m:ResponseMessages></m:MoveItemResponse></s:Body></s:Envelope>`;
  let missingItemError: unknown;
  try {
    assertExchangeSuccess(missingItemXml);
  } catch (error) {
    missingItemError = error;
  }
  assert(missingItemError instanceof ExchangeEwsError, "missing EWS items produce a typed error");
  assert(missingItemError.code === "REMOTE_CONFLICT", "missing EWS items retain the public conflict classification");
  assert(missingItemError.responseCode === "ErrorItemNotFound", "the original EWS response code is retained");
  assert(isExchangeItemNotFoundError(missingItemError), "missing EWS items can be recognized for idempotent deletion");
  assert(
    !isExchangeItemNotFoundError(new ExchangeEwsError("REMOTE_CONFLICT", "stale", 409, "ErrorInvalidChangeKey")),
    "other EWS conflicts are not treated as an already deleted message",
  );
  console.log("Exchange mail parser tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
