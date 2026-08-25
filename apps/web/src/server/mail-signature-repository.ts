import { randomUUID } from "node:crypto";

import type { MailSignatureVariant } from "../lib/mail-signature-content";

import { getDatabase } from "./database";
import { getAccount } from "./mail-repository";
import { getUserScope } from "./user-scope";

export interface MailSignature {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly fullText: string;
  readonly shortText: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MailSignatureInput {
  readonly accountId: string;
  readonly name: string;
  readonly fullText: string;
  readonly shortText: string;
  readonly makeDefault?: boolean;
}

interface MailSignatureRow {
  id: string;
  account_id: string;
  name: string;
  full_text: string;
  short_text: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export class MailSignatureError extends Error {
  constructor(
    readonly code: "SIGNATURE_NOT_FOUND" | "ACCOUNT_NOT_FOUND" | "INVALID_SIGNATURE" | "SIGNATURE_NAME_CONFLICT",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailSignatureError";
  }
}

export async function listMailSignatures(accountId?: string): Promise<readonly MailSignature[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const values: unknown[] = [];
  const conditions = ["a.enabled = true"];
  if (accountId) {
    values.push(accountId);
    conditions.push(`s.account_id = $${values.length}`);
  }
  if (scope.active) {
    values.push(scope.userId);
    conditions.push(`a.user_id = $${values.length}`);
  }
  const result = await database.query<MailSignatureRow>(
    `SELECT s.id, s.account_id, s.name, s.full_text, s.short_text,
            s.is_default, s.created_at, s.updated_at
       FROM mail_signatures s
       JOIN accounts a ON a.id = s.account_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.account_id, s.is_default DESC, s.created_at, s.id`,
    values,
  );
  return result.rows.map(mapSignature);
}

export async function getMailSignature(id: string): Promise<MailSignature | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<MailSignatureRow>(
    `SELECT s.id, s.account_id, s.name, s.full_text, s.short_text,
            s.is_default, s.created_at, s.updated_at
       FROM mail_signatures s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.id = $1 AND a.enabled = true${scope.active ? " AND a.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [id, scope.userId] : [id],
  );
  return result.rows[0] ? mapSignature(result.rows[0]) : undefined;
}

export async function getDefaultMailSignature(accountId: string): Promise<MailSignature | undefined> {
  const signatures = await listMailSignatures(accountId);
  return signatures.find((signature) => signature.isDefault);
}

export async function createMailSignature(input: MailSignatureInput): Promise<MailSignature> {
  const normalized = await validateInput(input);
  const database = await getDatabase();
  const scope = await getUserScope();
  const existing = await listMailSignatures(normalized.accountId);
  const makeDefault = normalized.makeDefault || existing.length === 0;
  const id = randomUUID();
  try {
    await database.transaction(async (transaction) => {
      if (makeDefault) {
        await transaction.query("UPDATE mail_signatures SET is_default = false, updated_at = now() WHERE account_id = $1", [normalized.accountId]);
      }
      await transaction.query(
        `INSERT INTO mail_signatures (
           id, account_id, user_id, name, full_text, short_text, is_default
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, normalized.accountId, scope.valueOrNull(), normalized.name, normalized.fullText, normalized.shortText, makeDefault],
      );
    });
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
  return (await getMailSignature(id))!;
}

export async function updateMailSignature(id: string, input: MailSignatureInput): Promise<MailSignature> {
  const existing = await getMailSignature(id);
  if (!existing) throw new MailSignatureError("SIGNATURE_NOT_FOUND", "Die Signatur-Version existiert nicht", 404);
  if (existing.accountId !== input.accountId) {
    throw new MailSignatureError("INVALID_SIGNATURE", "eine Signatur-Version kann nicht auf ein anderes Postfach-Konto verschoben werden", 400);
  }
  const normalized = await validateInput(input);
  const database = await getDatabase();
  try {
    await database.transaction(async (transaction) => {
      if (normalized.makeDefault) {
        await transaction.query("UPDATE mail_signatures SET is_default = false, updated_at = now() WHERE account_id = $1", [existing.accountId]);
      }
      await transaction.query(
        `UPDATE mail_signatures
            SET name = $2, full_text = $3, short_text = $4,
                is_default = CASE WHEN $5::boolean THEN true ELSE is_default END,
                updated_at = now()
          WHERE id = $1`,
        [id, normalized.name, normalized.fullText, normalized.shortText, Boolean(normalized.makeDefault)],
      );
    });
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
  return (await getMailSignature(id))!;
}

export async function setDefaultMailSignature(id: string): Promise<MailSignature> {
  const signature = await getMailSignature(id);
  if (!signature) throw new MailSignatureError("SIGNATURE_NOT_FOUND", "Die Signatur-Version existiert nicht", 404);
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    await transaction.query("UPDATE mail_signatures SET is_default = false, updated_at = now() WHERE account_id = $1", [signature.accountId]);
    await transaction.query("UPDATE mail_signatures SET is_default = true, updated_at = now() WHERE id = $1", [id]);
  });
  return (await getMailSignature(id))!;
}

export async function deleteMailSignature(id: string): Promise<boolean> {
  const signature = await getMailSignature(id);
  if (!signature) return false;
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM mail_signatures WHERE id = $1", [id]);
    if (signature.isDefault) {
      await transaction.query(
        `UPDATE mail_signatures SET is_default = true, updated_at = now()
          WHERE id = (
            SELECT id FROM mail_signatures
             WHERE account_id = $1
             ORDER BY created_at, id
             LIMIT 1
          )`,
        [signature.accountId],
      );
    }
  });
  return true;
}

export async function recommendMailSignatureVariant(
  accountId: string,
  replyToMessageId?: string,
): Promise<MailSignatureVariant> {
  if (!replyToMessageId) return "full";
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ has_sent: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM mail_messages anchor
         JOIN mail_messages sent ON sent.thread_id = anchor.thread_id
         JOIN mail_folders folder
           ON folder.account_id = sent.account_id
          AND folder.provider_folder_id = sent.provider_folder_id
         JOIN accounts account ON account.id = sent.account_id AND account.enabled = true
        WHERE anchor.id = $1
          AND sent.account_id = $2
          AND folder.role = 'sent'
          ${scope.active ? "AND account.user_id = $3" : ""}
     ) AS has_sent`,
    scope.active ? [replyToMessageId, accountId, scope.userId] : [replyToMessageId, accountId],
  );
  return result.rows[0]?.has_sent ? "short" : "full";
}

async function validateInput(input: MailSignatureInput): Promise<MailSignatureInput> {
  if (!await getAccount(input.accountId)) {
    throw new MailSignatureError("ACCOUNT_NOT_FOUND", "Mailbox-Konten existieren nicht", 404);
  }
  const name = input.name.trim();
  const fullText = input.fullText.replace(/\r\n?/g, "\n").trim();
  const shortText = input.shortText.replace(/\r\n?/g, "\n").trim();
  if (!name || name.length > 100) {
    throw new MailSignatureError("INVALID_SIGNATURE", "Unterschrift Name sollte 1 bis 100 Zeichen sein", 400);
  }
  if (!fullText || fullText.length > 20_000) {
    throw new MailSignatureError("INVALID_SIGNATURE", "Die vollständige Unterschrift sollte 1 bis 20000 Zeichen betragen.", 400);
  }
  if (!shortText || shortText.length > 10_000) {
    throw new MailSignatureError("INVALID_SIGNATURE", "kurze Signatur sollte 1 bis 10000 Zeichen sein", 400);
  }
  return { ...input, name, fullText, shortText };
}

function normalizeDatabaseError(error: unknown): MailSignatureError {
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return new MailSignatureError("SIGNATURE_NAME_CONFLICT", "Dieses Postfach-Konto hat bereits eine signierte Version mit dem gleichen Namen", 409);
  }
  throw error;
}

function mapSignature(row: MailSignatureRow): MailSignature {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    fullText: row.full_text,
    shortText: row.short_text,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
