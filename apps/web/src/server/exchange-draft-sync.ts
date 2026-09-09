import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { getDatabase } from "./database";
import { getAccount, loadExchangeMailCredential } from "./mail-repository";
import { getMailDraft, getMailReplyContext, listMailDraftIdsForAccount, listMailDraftAttachmentRecords, deleteMailDraft, type StoredMailDraft } from "./mail-draft-repository";
import { clearMailDraftAttachmentFiles, mailDraftAttachmentPath, MAX_MAIL_ATTACHMENTS, MAX_MAIL_ATTACHMENT_BYTES, MAX_MAIL_ATTACHMENTS_TOTAL_BYTES } from "./mail-draft-attachment-service";
import { findExchangeDraftByLocalId, saveExchangeMailDraft, deleteExchangeDraft, fetchExchangeMailMessageDetails, getExchangeAttachment, type ExchangeMailMessage } from "./exchange-mail";
import { exchangeHtmlToContent } from "./exchange-rich-text";
import { encodeNoteContent, decodeNoteContent, noteContentToPlainText } from "../lib/note-content";
import { renderMailHtml, mailDraftAttachmentUrl } from "./mail-rich-text";
import { ExchangeEwsError } from "./exchange-ews-client";

interface DraftLink { draft_id: string; account_id: string; item_id: string; change_key: string; local_revision: string }
declare global { var kalenderExchangeDraftSyncs: Set<string> | undefined; }

export function exchangeDraftRevision(draft: StoredMailDraft): string {
  return createHash("sha256").update(JSON.stringify([draft.to, draft.cc, draft.bcc, draft.subject, draft.bodyContent, [...draft.attachments].sort((left, right) => left.id.localeCompare(right.id)).map((item) => [item.id, item.filename, item.contentId])])).digest("hex");
}

async function linkForDraft(id: string) {
  return (await (await getDatabase()).query<DraftLink>("SELECT * FROM exchange_draft_links WHERE draft_id = $1", [id])).rows[0];
}

async function saveLink(draft: StoredMailDraft, itemId: string, changeKey: string, revision = exchangeDraftRevision(draft)) {
  await (await getDatabase()).query(`INSERT INTO exchange_draft_links (draft_id, account_id, item_id, change_key, local_revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (draft_id) DO UPDATE SET item_id = EXCLUDED.item_id, change_key = EXCLUDED.change_key, local_revision = EXCLUDED.local_revision`, [draft.id, draft.accountId, itemId, changeKey, revision]);
}

export async function pushExchangeDraft(id: string, overwrite = false): Promise<{ itemId: string; changeKey: string } | undefined> {
  const draft = await getMailDraft(id);
  if (!draft || (await getAccount(draft.accountId))?.providerId !== "exchange-ews" || draft.status === "sent") return;
  const active = globalThis.kalenderExchangeDraftSyncs ??= new Set();
  if (active.has(id)) throw new Error("草稿正在同步，请稍后重试");
  active.add(id);
  let claimedCreate = false;
  try {
    let link = await linkForDraft(id);
    if (!link && (await (await getDatabase()).query("SELECT 1 FROM exchange_draft_creates WHERE draft_id = $1", [id])).rows.length) {
      link = await recoverUncertainDraft(draft);
      if (!overwrite) throw new ExchangeEwsError("REMOTE_CONFLICT", "已找回 Exchange 草稿，请选择保留本地或 Exchange 版本", 409);
    }
    if (link?.local_revision === "" && !overwrite) throw new ExchangeEwsError("REMOTE_CONFLICT", "已找回 Exchange 草稿，请选择保留本地或 Exchange 版本", 409);
    const revision = exchangeDraftRevision(draft);
    if (link && link.local_revision === revision && !overwrite) return { itemId: link.item_id, changeKey: link.change_key };
    const credential = await loadExchangeMailCredential(draft.accountId);
    const remote = link ? (await fetchExchangeMailMessageDetails(credential, [{ itemId: link.item_id }], AbortSignal.timeout(30000)))[0] : undefined;
    if (link && (!remote?.isDraft || !remote.changeKey || (!overwrite && remote.changeKey !== link.change_key))) throw new ExchangeEwsError("REMOTE_CONFLICT", "草稿在 Exchange 中也有修改，请选择保留哪一版", 409);
    const attachments = await listMailDraftAttachmentRecords(id);
    const reply = draft.replyToMessageId ? await getMailReplyContext(draft.replyToMessageId) : undefined;
    const outgoing = {
      localDraftId: id,
      to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, textBody: draft.textBody,
      htmlBody: await renderMailHtml(draft.bodyContent, attachments.filter((item) => item.inline && item.contentId).map((item) => ({ attachmentId: item.id, contentId: item.contentId!, sourceUrl: mailDraftAttachmentUrl(id, item.id) }))),
      attachments: await Promise.all(attachments.map(async (item) => ({ filename: item.filename, contentType: item.contentType, content: new Uint8Array(await readFile(mailDraftAttachmentPath(item))), inline: item.inline, contentId: item.contentId }))),
      replyToItemId: reply?.providerMessageId,
    };
    if (!link) {
      const claim = await (await getDatabase()).query("INSERT INTO exchange_draft_creates (draft_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING draft_id", [id]);
      if (!claim.rows.length) throw new ExchangeEwsError("CREATE_UNCERTAIN", "Exchange 草稿创建结果待核对，请稍后同步；不会重复创建", 409);
      claimedCreate = true;
    }
    const saved = await saveExchangeMailDraft(credential, outgoing, remote?.changeKey ? { itemId: remote.itemId, changeKey: remote.changeKey } : undefined, AbortSignal.timeout(60000), (identity) => saveLink(draft, identity.itemId, identity.changeKey, ""));
    await saveLink(draft, saved.itemId, saved.changeKey, revision);
    await (await getDatabase()).query("UPDATE mail_drafts SET error_message = NULL WHERE id = $1", [id]);
    return saved;
  } catch (error) {
    // Authentication rejection before any confirmed creation is safe to retry.
    if (claimedCreate && error instanceof ExchangeEwsError && error.code === "AUTH_REQUIRED" && !await linkForDraft(id)) await (await getDatabase()).query("DELETE FROM exchange_draft_creates WHERE draft_id = $1", [id]);
    await (await getDatabase()).query("UPDATE mail_drafts SET error_message = $2 WHERE id = $1", [id, error instanceof ExchangeEwsError ? error.message : "草稿已保存在本地，等待 Exchange 同步"]);
    throw error;
  } finally { active.delete(id); }
}

async function recoverUncertainDraft(draft: StoredMailDraft): Promise<DraftLink> {
  const found = await findExchangeDraftByLocalId(await loadExchangeMailCredential(draft.accountId), draft.id);
  if (!found) throw new ExchangeEwsError("CREATE_UNCERTAIN", "Exchange 草稿创建结果尚未确认，请稍后同步或在邮箱中核对；不会重复创建", 409);
  await saveLink(draft, found.itemId, found.changeKey, "");
  return (await linkForDraft(draft.id))!;
}

export async function deleteLinkedExchangeDraft(id: string) {
  const draft = await getMailDraft(id);
  if (!draft) return;
  if (["sending", "sent"].includes(draft.status) || globalThis.kalenderExchangeDraftSyncs?.has(id)) throw new ExchangeEwsError("DRAFT_BUSY", "草稿正在发送或同步，请稍后重试", 409);
  let link = await linkForDraft(id);
  if (!link && (await (await getDatabase()).query("SELECT 1 FROM exchange_draft_creates WHERE draft_id = $1", [id])).rows.length) link = await recoverUncertainDraft(draft);
  if (link) await deleteExchangeDraft(await loadExchangeMailCredential(draft.accountId), { itemId: link.item_id, changeKey: link.change_key });
}

export async function pullExchangeDraft(accountId: string, message: ExchangeMailMessage, overwrite = false) {
  if (!message.isDraft || !message.changeKey || !await getAccount(accountId)) return;
  const database = await getDatabase();
  let link = (await database.query<DraftLink>("SELECT * FROM exchange_draft_links WHERE account_id = $1 AND item_id = $2", [accountId, message.itemId])).rows[0];
  if (!link && message.localDraftId) {
    const local = await getMailDraft(message.localDraftId);
    if (local?.accountId === accountId) {
      if (globalThis.kalenderExchangeDraftSyncs?.has(local.id)) return;
      if (await linkForDraft(local.id)) {
        await database.query("UPDATE mail_drafts SET error_message = $2 WHERE id = $1", [local.id, "Exchange 中存在多个关联草稿，请在邮箱中核对"]);
        return;
      }
      await saveLink(local, message.itemId, message.changeKey, "");
      await database.query("UPDATE mail_drafts SET error_message = $2 WHERE id = $1", [local.id, "已找回 Exchange 草稿，请选择保留本地或 Exchange 版本"]);
      return;
    }
  }
  const previous = link ? await getMailDraft(link.draft_id) : undefined;
  if (previous?.status === "sending" || previous?.status === "sent" || globalThis.kalenderExchangeDraftSyncs?.has(previous?.id ?? "")) return;
  const active = globalThis.kalenderExchangeDraftSyncs ??= new Set();
  const lockKey = previous?.id ?? `remote:${accountId}:${message.itemId}`;
  if (active.has(lockKey)) return;
  active.add(lockKey);
  try {
  if (link && previous && !overwrite) {
    if (link.change_key === message.changeKey) return;
    if (exchangeDraftRevision(previous) !== link.local_revision) {
      await database.query("UPDATE mail_drafts SET error_message = $2 WHERE id = $1", [previous.id, "草稿在 Exchange 中也有修改，请选择保留哪一版"]);
      return;
    }
  }
  // Stage every file before changing the draft. Commit body, attachment records and
  // sync revision together, after checking for edits made during the download.
  if (message.attachments.length > MAX_MAIL_ATTACHMENTS) throw new Error("Exchange 草稿附件超过 10 个，已保留原草稿");
  const credential = await loadExchangeMailCredential(accountId);
  const id = previous?.id ?? randomUUID();
  const staged: Array<{ id: string; draftId: string; filename: string; contentType: string; sizeBytes: number; storageName: string; inline: boolean; contentId?: string; createdAt: string }> = [];
  const oldFiles = previous ? await listMailDraftAttachmentRecords(id) : [];
  let committed = false;
  try {
    let total = 0;
    for (const attachment of message.attachments) {
      const file = await getExchangeAttachment(credential, attachment.id, AbortSignal.timeout(30000));
      total += file.content.length;
      if (file.content.length > MAX_MAIL_ATTACHMENT_BYTES || total > MAX_MAIL_ATTACHMENTS_TOTAL_BYTES) throw new Error("Exchange 草稿附件超过大小限制，已保留原草稿");
      const attachmentId = randomUUID();
      const record = { id: attachmentId, draftId: id, filename: file.filename, contentType: file.contentType, sizeBytes: file.content.length, storageName: `${attachmentId}.bin`, inline: Boolean(attachment.inline), contentId: attachment.contentId, createdAt: new Date().toISOString() };
      const filePath = mailDraftAttachmentPath(record);
      await mkdir(path.dirname(filePath), { recursive: true });
      staged.push(record);
      await writeFile(filePath, file.content, { flag: "wx", mode: 0o600 });
    }
    const bodyContent = message.htmlBody ? exchangeHtmlToContent(message.htmlBody, (src) => {
      const attachment = staged.find((file) => file.contentId && src === `cid:${file.contentId}`);
      return attachment ? mailDraftAttachmentUrl(id, attachment.id) : undefined;
    }) : encodeNoteContent(decodeNoteContent(message.textBody ?? ""));
    const fields = { accountId, to: message.to.map((item) => item.address), cc: message.cc.map((item) => item.address), bcc: message.bcc?.map((item) => item.address) ?? [], subject: message.subject, bodyContent, textBody: noteContentToPlainText(bodyContent) };
    const revision = exchangeDraftRevision({ ...previous, ...fields, id, attachments: staged } as StoredMailDraft);
    await database.transaction(async (tx) => {
      if (previous) {
        const locked = (await tx.query<{ updated_at: string | Date; status: string }>("SELECT updated_at, status FROM mail_drafts WHERE id = $1 FOR UPDATE", [id])).rows[0];
        const currentFiles = (await tx.query<{ id: string }>("SELECT id FROM mail_draft_attachments WHERE draft_id = $1 ORDER BY id", [id])).rows.map((row) => row.id);
        if (!locked || String(locked.updated_at) !== String(previous.updatedAt) || ["sending", "sent"].includes(locked.status) || JSON.stringify(currentFiles) !== JSON.stringify(oldFiles.map((file) => file.id).sort())) throw new ExchangeEwsError("LOCAL_CONFLICT", "草稿在同步期间被编辑，已保留本地修改", 409);
        await tx.query(`UPDATE mail_drafts SET to_addresses=$2::jsonb, cc_addresses=$3::jsonb, bcc_addresses=$4::jsonb, subject=$5, body_content=$6, text_body=$7, error_message=NULL, updated_at=clock_timestamp() WHERE id=$1`, [id, JSON.stringify(fields.to), JSON.stringify(fields.cc), JSON.stringify(fields.bcc), fields.subject, bodyContent, fields.textBody]);
      } else {
        await tx.query(`INSERT INTO mail_drafts (id,account_id,user_id,to_addresses,cc_addresses,bcc_addresses,subject,body_content,text_body,status) VALUES ($1,$2,(SELECT user_id FROM accounts WHERE id=$2),$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,'draft')`, [id, accountId, JSON.stringify(fields.to), JSON.stringify(fields.cc), JSON.stringify(fields.bcc), fields.subject, bodyContent, fields.textBody]);
      }
      await tx.query("DELETE FROM mail_draft_attachments WHERE draft_id=$1", [id]);
      for (const file of staged) await tx.query(`INSERT INTO mail_draft_attachments (id,draft_id,filename,content_type,size_bytes,storage_name,inline,content_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [file.id,id,file.filename,file.contentType,file.sizeBytes,file.storageName,file.inline,file.contentId ?? null]);
      await tx.query(`INSERT INTO exchange_draft_links (draft_id,account_id,item_id,change_key,local_revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (draft_id) DO UPDATE SET item_id=EXCLUDED.item_id, change_key=EXCLUDED.change_key, local_revision=EXCLUDED.local_revision`, [id,accountId,message.itemId,message.changeKey,revision]);
    });
    committed = true;
  } finally {
    await Promise.all((committed ? oldFiles : staged).map((file) => unlink(mailDraftAttachmentPath(file)).catch(() => undefined)));
  }
  } finally { active.delete(lockKey); }
}

export async function synchronizeExchangeDrafts(accountId: string, messages: readonly ExchangeMailMessage[], deletedIds: readonly string[] = []) {
  for (const message of messages) await pullExchangeDraft(accountId, message);
  const database = await getDatabase();
  for (const itemId of deletedIds) {
    const link = (await database.query<DraftLink>("SELECT * FROM exchange_draft_links WHERE account_id = $1 AND item_id = $2", [accountId, itemId])).rows[0];
    const draft = link ? await getMailDraft(link.draft_id) : undefined;
    if (!draft || draft.status === "sending" || draft.status === "sent" || globalThis.kalenderExchangeDraftSyncs?.has(draft.id)) continue;
    if (exchangeDraftRevision(draft) !== link.local_revision) { await database.query("UPDATE mail_drafts SET error_message = $2 WHERE id = $1", [draft.id, "Exchange 草稿已删除或发送，本地修改已保留"]); continue; }
    await clearMailDraftAttachmentFiles(draft.id);
    await deleteMailDraft(draft.id);
  }
}

export async function pushPendingExchangeDrafts(accountId: string) {
  for (const id of await listMailDraftIdsForAccount(accountId)) {
    const draft = await getMailDraft(id);
    if (draft?.status !== "draft" || globalThis.kalenderActiveMailSends?.has(id)) continue;
    await pushExchangeDraft(id).catch(() => undefined);
  }
}

export async function reloadExchangeDraft(id: string) {
  const draft = await getMailDraft(id);
  if (!draft) throw new Error("草稿不存在");
  const link = await linkForDraft(id) ?? await recoverUncertainDraft(draft);
  const message = (await fetchExchangeMailMessageDetails(await loadExchangeMailCredential(draft.accountId), [{ itemId: link.item_id }], AbortSignal.timeout(30000)))[0];
  if (!message?.isDraft) throw new Error("Exchange 草稿已删除或发送");
  await pullExchangeDraft(draft.accountId, message, true);
}
