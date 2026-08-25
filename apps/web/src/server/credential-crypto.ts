import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataRoot } from "./database";

interface EncryptedEnvelope {
  readonly version: 1;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export class CredentialDecryptionError extends Error {
  constructor() {
    super("保存的连接凭据无法解密。请在设置中重新输入并保存连接密码");
    this.name = "CredentialDecryptionError";
  }
}

let cachedKey: Promise<Buffer> | undefined;

export function resetCredentialKeyCache(): void {
  cachedKey = undefined;
}

export async function encryptCredential(accountId: string, value: unknown): Promise<string> {
  const key = await getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`kalender:${accountId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const envelope: EncryptedEnvelope = {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export async function decryptCredential<T>(accountId: string, payload: string): Promise<T> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(payload) as EncryptedEnvelope;
  } catch {
    throw new CredentialDecryptionError();
  }
  if (envelope.version !== 1) throw new CredentialDecryptionError();
  const key = await getMasterKey();
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`kalender:${accountId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ) as T;
  } catch {
    throw new CredentialDecryptionError();
  }
}

async function getMasterKey(): Promise<Buffer> {
  cachedKey ??= loadMasterKey();
  return cachedKey;
}

async function loadMasterKey(): Promise<Buffer> {
  const environmentKey = process.env.KALENDER_MASTER_KEY;
  if (environmentKey) {
    const decoded = Buffer.from(environmentKey, "base64");
    if (decoded.length !== 32) throw new Error("KALENDER_MASTER_KEY must be 32 bytes encoded as base64");
    return decoded;
  }

  const root = dataRoot();
  const keyPath = path.join(root, "master.key");
  await mkdir(root, { recursive: true });
  try {
    const existing = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
    if (existing.length !== 32) throw new Error("Local credential key is invalid");
    return existing;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32);
  try {
    await writeFile(keyPath, generated.toString("base64"), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      const existing = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
      if (existing.length === 32) return existing;
    }
    throw error;
  }
}
