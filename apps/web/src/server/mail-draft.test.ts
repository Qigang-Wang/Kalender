import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-mail-draft-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
    const repository = await import("./mail-draft-repository");
    const mailRepository = await import("./mail-repository");
    const signatureRepository = await import("./mail-signature-repository");
  const validation = await import("./mail-draft-validation");
  const attachmentService = await import("./mail-draft-attachment-service");
  const richText = await import("./mail-rich-text");
  const { getDatabase } = await import("./database");
  try {
    const account = await mailRepository.saveImapSmtpAccount({
      displayName: "Draft Test",
      emailAddress: "draft@example.test",
      syncMode: "quick",
      credential: {
        kind: "imap_smtp",
        imap: { host: "imap.example.test", port: 993, secure: true, username: "draft@example.test", password: "secret" },
        smtp: { host: "smtp.example.test", port: 465, secure: true, username: "draft@example.test", password: "secret" },
      },
    });
    const parsed = validation.parseMailDraftInput({
      accountId: account.id,
      to: ["person@example.test", "PERSON@example.test"],
      cc: [],
      bcc: [],
      subject: "Initial subject",
      textBody: "Initial body",
    });
    assert(parsed.to.length === 1, "recipient addresses are deduplicated");
    assert(parsed.bodyContent.startsWith("plate-json-v1:"), "plain text drafts are normalized to Plate content");
    validation.assertDraftCanSend(parsed);
    const created = await repository.saveMailDraft(parsed);
    assert(created.status === "draft", "draft is created locally");
    const updated = await repository.saveMailDraft({ ...parsed, subject: "Updated subject" }, created.id);
    assert(updated.id === created.id && updated.subject === "Updated subject", "draft updates preserve identity");
    assert((await repository.listMailDrafts()).length === 1, "active drafts are listed");

    const idempotencyKey = `test:${randomUUID()}`;
    const claim = await repository.beginMailDraftSend(created.id, account.id, idempotencyKey);
    assert(!claim.alreadySent && claim.draft.status === "sending", "first send claims the draft");
    const sent = await repository.finishMailDraftSend(created.id, "<message@example.test>");
    assert(sent.status === "sent" && Boolean(sent.sentAt), "successful send is persisted");
    const repeated = await repository.beginMailDraftSend(created.id, account.id, idempotencyKey);
    assert(repeated.alreadySent, "same idempotency key does not send twice");
    assert((await repository.listMailDrafts()).length === 0, "sent drafts leave the active draft list");

    const signature = await signatureRepository.createMailSignature({
      accountId: account.id,
      name: "Work",
      fullText: "Kind regards\nDraft Test\nExample Institute",
      shortText: "Thanks\nDraft Test",
      makeDefault: true,
    });
    const signedNewDraft = await repository.createMailDraft({ ...parsed, subject: "Signed new message" });
    assert(signedNewDraft.signatureId === signature.id && signedNewDraft.signatureVariant === "full", "new messages use the full default signature");
    assert(signedNewDraft.textBody.endsWith("Kind regards\nDraft Test\nExample Institute"), "full signature is appended to a new message");
    assert(await repository.deleteMailDraft(signedNewDraft.id), "signed new-message draft is deleted");

    const database = await getDatabase();
    const threadId = randomUUID();
    const inboxMessageId = randomUUID();
    await database.query(
      `INSERT INTO mail_folders (id, account_id, provider_folder_id, name, role)
       VALUES ($1,$2,'INBOX','Inbox','inbox'), ($3,$2,'SENT','Sent','sent')`,
      [randomUUID(), account.id, randomUUID()],
    );
    await database.query(
      `INSERT INTO mail_threads (id, account_id, provider_thread_id, subject, snippet, participants, last_message_at)
       VALUES ($1,$2,$3,'Signature thread','Hello','[]'::jsonb,now())`,
      [threadId, account.id, `thread-${threadId}`],
    );
    await database.query(
      `INSERT INTO mail_messages (
         id, account_id, thread_id, provider_message_id, provider_uid, provider_folder_id,
         subject, from_address, to_addresses, sent_at, received_at
       ) VALUES ($1,$2,$3,$4,1,'INBOX','Signature thread',$5::jsonb,$6::jsonb,now(),now())`,
      [
        inboxMessageId,
        account.id,
        threadId,
        `<inbox-${inboxMessageId}@example.test>`,
        JSON.stringify({ address: "person@example.test", name: "Person" }),
        JSON.stringify([{ address: account.emailAddress }]),
      ],
    );
    const firstReply = await repository.createMailDraft({
      ...parsed,
      replyToMessageId: inboxMessageId,
      subject: "Re: Signature thread",
    });
    assert(firstReply.signatureVariant === "full", "the first reply in a thread uses the full signature");
    assert(await repository.deleteMailDraft(firstReply.id), "first reply draft is deleted");

    const sentMessageId = randomUUID();
    await database.query(
      `INSERT INTO mail_messages (
         id, account_id, thread_id, provider_message_id, provider_uid, provider_folder_id,
         subject, from_address, to_addresses, sent_at, received_at
       ) VALUES ($1,$2,$3,$4,1,'SENT','Re: Signature thread',$5::jsonb,$6::jsonb,now(),now())`,
      [
        sentMessageId,
        account.id,
        threadId,
        `<sent-${sentMessageId}@example.test>`,
        JSON.stringify({ address: account.emailAddress, name: "Draft Test" }),
        JSON.stringify([{ address: "person@example.test" }]),
      ],
    );
    const laterReply = await repository.createMailDraft({
      ...parsed,
      replyToMessageId: inboxMessageId,
      subject: "Re: Signature thread",
    });
    assert(laterReply.signatureVariant === "short", "later replies use the short signature");
    assert(laterReply.textBody.endsWith("Thanks\nDraft Test"), "short signature is appended to later replies");
    assert(await repository.deleteMailDraft(laterReply.id), "later reply draft is deleted");

    const rich = validation.parseMailDraftInput({
      accountId: account.id,
      to: ["person@example.test"],
      subject: "Rich text",
      bodyContent: 'plate-json-v1:[{"type":"p","children":[{"text":"Formatted","bold":true,"color":"#1769aa"}]}]',
    });
    assert(rich.textBody === "Formatted", "plain text is derived from rich content");

    const attachmentDraft = await repository.saveMailDraft({ ...parsed, subject: "Attachment draft" });
    const added = await attachmentService.addMailDraftAttachments(attachmentDraft.id, [
      new File(["attachment content"], "design-notes.txt", { type: "text/plain" }),
    ]);
    assert(added.length === 1 && added[0]!.filename === "design-notes.txt", "attachment metadata is stored");
    const records = await repository.listMailDraftAttachmentRecords(attachmentDraft.id);
    assert((await stat(attachmentService.mailDraftAttachmentPath(records[0]!))).isFile(), "attachment bytes are stored locally");
    assert(await attachmentService.removeMailDraftAttachment(attachmentDraft.id, added[0]!.id), "attachment can be removed");
    assert((await repository.listMailDraftAttachments(attachmentDraft.id)).length === 0, "removed attachment metadata is deleted");
    const inlineAdded = await attachmentService.addMailDraftAttachments(attachmentDraft.id, [
      new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" }),
    ], { inline: true });
    assert(inlineAdded[0]?.inline && Boolean(inlineAdded[0]?.contentId), "pasted image receives inline CID metadata");
    const inlineUrl = richText.mailDraftAttachmentUrl(attachmentDraft.id, inlineAdded[0]!.id);
    const inlineBody = `plate-json-v1:[{"type":"img","url":"${inlineUrl}","attachmentId":"${inlineAdded[0]!.id}","children":[{"text":""}]}]`;
    assert(richText.mailInlineImageAttachmentIds(inlineBody).has(inlineAdded[0]!.id), "inline image reference is discovered in rich text");
    const inlineHtml = richText.sanitizeRenderedMailHtml(`<p>Before</p><img src="${inlineUrl}"/><p>After</p>`, [{
      attachmentId: inlineAdded[0]!.id,
      contentId: inlineAdded[0]!.contentId!,
      sourceUrl: inlineUrl,
    }]);
    assert(inlineHtml.includes(`src="cid:${inlineAdded[0]!.contentId}"`), "inline image URL is converted to CID when rendering mail");
    assert(!inlineHtml.includes("/api/mail-drafts/"), "local draft URLs never leave the application in sent HTML");
    validation.assertDraftCanSend({ ...parsed, textBody: "", bodyContent: inlineBody }, true);
    assert(await attachmentService.removeMailDraftAttachment(attachmentDraft.id, inlineAdded[0]!.id), "inline attachment can be removed");
    assert(await repository.deleteMailDraft(attachmentDraft.id), "attachment test draft is deleted");

    const disposable = await repository.saveMailDraft({ ...parsed, subject: "Delete me" });
    assert(await repository.deleteMailDraft(disposable.id), "draft can be deleted");
    assert(!await repository.getMailDraft(disposable.id), "deleted draft is removed");
    let staleSaveRejected = false;
    try {
      await repository.saveMailDraft({ ...parsed, subject: "Stale autosave" }, disposable.id);
    } catch (error) {
      staleSaveRejected = error instanceof repository.MailDraftRepositoryError && error.code === "DRAFT_NOT_FOUND";
    }
    assert(staleSaveRejected, "an autosave racing with deletion cannot recreate the draft");
    assert(!await repository.getMailDraft(disposable.id), "stale autosave leaves the draft deleted");
    console.log("Mail draft repository tests passed");
    await (await getDatabase()).close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
