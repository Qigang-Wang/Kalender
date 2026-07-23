import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import JSZip from "jszip";

import { resetCredentialKeyCache } from "./credential-crypto";
import { closeDatabaseForRestore, dataRoot, getDatabase } from "./database";
import { ensureMailSyncScheduler, stopMailSyncScheduler } from "./mail-sync-scheduler";

const BACKUP_FORMAT = "kalender-workspace-backup";
const BACKUP_VERSION = 1;
const SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

const COUNTED_TABLES = [
  "accounts",
  "calendar_accounts",
  "calendars",
  "calendar_events",
  "projects",
  "notes",
  "tasks",
  "mail_drafts",
  "mail_messages",
  "entity_links",
  "ai_providers",
  "ai_provider_credentials",
  "ai_models",
  "ai_feature_bindings",
  "ai_conversations",
  "ai_messages",
  "ai_runs",
] as const;

const REQUIRED_TABLES = [
  "accounts",
  "calendar_accounts",
  "calendars",
  "calendar_events",
  "projects",
  "notes",
  "tasks",
  "mail_drafts",
  "entity_links",
] as const;

type BackupKeySource = "file" | "environment" | "none";

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly backupVersion: typeof BACKUP_VERSION;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly appVersion: string;
  readonly createdAt: string;
  readonly databaseEngine: "pglite";
  readonly databaseArchive: "database.tgz";
  readonly keySource: BackupKeySource;
  readonly includesDraftAttachments: true;
  readonly counts: Readonly<Record<string, number>>;
}

export interface WorkspaceBackupStatus {
  readonly databaseBytes: number;
  readonly attachmentBytes: number;
  readonly attachmentFiles: number;
  readonly keySource: BackupKeySource;
  readonly counts: Readonly<Record<string, number>>;
  readonly latestAutomaticBackupAt?: string;
}

export interface WorkspaceBackupResult {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly manifest: BackupManifest;
}

export interface WorkspaceRestoreResult {
  readonly restoredAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly safetyBackupFilename: string;
}

export interface WorkspaceBackupInspection {
  readonly manifest: BackupManifest;
  readonly counts: Readonly<Record<string, number>>;
  readonly databaseBytes: number;
  readonly attachmentFiles: number;
}

export class BackupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "BackupError";
  }
}

declare global {
  var kalenderBackupOperationRunning: boolean | undefined;
}

export async function getWorkspaceBackupStatus(): Promise<WorkspaceBackupStatus> {
  const root = dataRoot();
  const database = await getDatabase();
  const [databaseSize, attachmentSize, counts, latestAutomaticBackupAt] = await Promise.all([
    directorySize(path.join(root, "postgres")),
    directorySize(path.join(root, "mail-draft-attachments")),
    readTableCounts(database),
    latestBackupTime(path.join(root, "automatic-backups")),
  ]);
  return {
    databaseBytes: databaseSize.bytes,
    attachmentBytes: attachmentSize.bytes,
    attachmentFiles: attachmentSize.files,
    keySource: await detectKeySource(root),
    counts,
    latestAutomaticBackupAt,
  };
}

export async function exportWorkspaceBackup(): Promise<WorkspaceBackupResult> {
  return withBackupOperation(async () => createWorkspaceBackup(await getDatabase(), dataRoot()));
}

export async function restoreWorkspaceBackup(input: Uint8Array): Promise<WorkspaceRestoreResult> {
  if (input.byteLength <= 0) throw new BackupError("备份文件为空");
  if (input.byteLength > MAX_BACKUP_BYTES) throw new BackupError("备份文件不能超过 512 MB", 413);
  return withBackupOperation(async () => restoreWorkspaceBackupInternal(input));
}

export async function inspectWorkspaceBackup(input: Uint8Array): Promise<WorkspaceBackupInspection> {
  if (input.byteLength <= 0) throw new BackupError("备份文件为空");
  if (input.byteLength > MAX_BACKUP_BYTES) throw new BackupError("备份文件不能超过 512 MB", 413);
  return withBackupOperation(async () => {
    const archive = await readAndValidateArchive(input);
    validateKeyCompatibility(archive.manifest, archive.masterKey);
    const validationRoot = childPath(dataRoot(), `.backup-validation-${Date.now()}-${randomUUID()}`);
    let database: PGlite | undefined;
    try {
      await mkdir(validationRoot, { recursive: false });
      database = await PGlite.create(path.join(validationRoot, "postgres"), {
        loadDataDir: new Blob([Uint8Array.from(archive.databaseBytes)]),
      });
      const counts = await validateStagedDatabase(database, archive.manifest);
      return {
        manifest: archive.manifest,
        counts,
        databaseBytes: archive.databaseBytes.length,
        attachmentFiles: archive.attachments.length,
      };
    } finally {
      if (database && !database.closed) await database.close().catch(() => undefined);
      await rm(validationRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

async function createWorkspaceBackup(database: PGlite, root: string): Promise<WorkspaceBackupResult> {
  const createdAt = new Date().toISOString();
  const counts = await readTableCounts(database);
  const keySource = await detectKeySource(root);
  const credentialCount = (counts.accounts ?? 0) + (counts.calendar_accounts ?? 0) + (counts.ai_provider_credentials ?? 0);
  if (credentialCount > 0 && keySource === "none") {
    throw new BackupError("检测到账户连接，但主密钥不存在，无法创建可恢复的完整备份", 500);
  }

  const databaseDump = await database.dumpDataDir("gzip");
  const databaseBytes = Buffer.from(await databaseDump.arrayBuffer());
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion: "0.1.0",
    createdAt,
    databaseEngine: "pglite",
    databaseArchive: "database.tgz",
    keySource,
    includesDraftAttachments: true,
    counts,
  };

  const files = new Map<string, Buffer>();
  files.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  files.set("database.tgz", databaseBytes);
  if (keySource === "file") files.set("master.key", await readFile(path.join(root, "master.key")));
  for (const item of await readDirectoryFiles(path.join(root, "mail-draft-attachments"), "mail-draft-attachments")) {
    files.set(item.name, item.bytes);
  }

  const checksums = Object.fromEntries([...files.entries()].map(([name, bytes]) => [name, sha256(bytes)]));
  const zip = new JSZip();
  for (const [name, bytes] of files) zip.file(name, bytes);
  zip.file("checksums.json", `${JSON.stringify({ algorithm: "sha256", files: checksums }, null, 2)}\n`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE", platform: "UNIX" });
  return { bytes, filename: backupFilename(createdAt), manifest };
}

async function restoreWorkspaceBackupInternal(input: Uint8Array): Promise<WorkspaceRestoreResult> {
  const root = dataRoot();
  const archive = await readAndValidateArchive(input);
  validateKeyCompatibility(archive.manifest, archive.masterKey);

  const operationId = `${Date.now()}-${randomUUID()}`;
  const stagingRoot = childPath(root, `.restore-staging-${operationId}`);
  const stagingDatabase = path.join(stagingRoot, "postgres");
  const stagingAttachments = path.join(stagingRoot, "mail-draft-attachments");
  const rollbackRoot = childPath(root, `.restore-rollback-${operationId}`);
  await mkdir(stagingRoot, { recursive: false });
  await mkdir(stagingAttachments, { recursive: true });

  let stagedDatabase: PGlite | undefined;
  let schedulerStopped = false;
  let swapStarted = false;
  try {
    for (const attachment of archive.attachments) {
      const destination = safeArchiveDestination(stagingRoot, attachment.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, attachment.bytes, { flag: "wx", mode: 0o600 });
    }
    if (archive.masterKey) await writeFile(path.join(stagingRoot, "master.key"), archive.masterKey, { flag: "wx", mode: 0o600 });

    stagedDatabase = await PGlite.create(stagingDatabase, {
      loadDataDir: new Blob([Uint8Array.from(archive.databaseBytes)]),
    });
    const stagedCounts = await validateStagedDatabase(stagedDatabase, archive.manifest);
    await stagedDatabase.close();
    stagedDatabase = undefined;

    const currentDatabase = await getDatabase();
    const safetyBackup = await createWorkspaceBackup(currentDatabase, root);
    const automaticBackupDirectory = path.join(root, "automatic-backups");
    await mkdir(automaticBackupDirectory, { recursive: true });
    const safetyBackupFilename = safetyBackup.filename.replace("Kalender-backup-", "pre-restore-");
    await writeFile(path.join(automaticBackupDirectory, safetyBackupFilename), safetyBackup.bytes, { flag: "wx", mode: 0o600 });

    await stopMailSyncScheduler();
    schedulerStopped = true;
    await closeDatabaseForRestore();
    resetCredentialKeyCache();
    await mkdir(rollbackRoot, { recursive: false });
    swapStarted = true;

    await moveIfExists(path.join(root, "postgres"), path.join(rollbackRoot, "postgres"));
    await moveIfExists(path.join(root, "mail-draft-attachments"), path.join(rollbackRoot, "mail-draft-attachments"));
    if (archive.manifest.keySource === "file") {
      await moveIfExists(path.join(root, "master.key"), path.join(rollbackRoot, "master.key"));
    }

    await rename(stagingDatabase, path.join(root, "postgres"));
    await rename(stagingAttachments, path.join(root, "mail-draft-attachments"));
    if (archive.manifest.keySource === "file") await rename(path.join(stagingRoot, "master.key"), path.join(root, "master.key"));

    const restoredDatabase = await getDatabase();
    await validateStagedDatabase(restoredDatabase, archive.manifest);
    resetCredentialKeyCache();
    ensureMailSyncScheduler();
    await rm(rollbackRoot, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
    return {
      restoredAt: new Date().toISOString(),
      counts: stagedCounts,
      safetyBackupFilename,
    };
  } catch (error) {
    if (stagedDatabase && !stagedDatabase.closed) await stagedDatabase.close().catch(() => undefined);
    if (swapStarted) {
      await closeDatabaseForRestore().catch(() => undefined);
      await rm(path.join(root, "postgres"), { recursive: true, force: true }).catch(() => undefined);
      await rm(path.join(root, "mail-draft-attachments"), { recursive: true, force: true }).catch(() => undefined);
      if (archive.manifest.keySource === "file") await rm(path.join(root, "master.key"), { force: true }).catch(() => undefined);
      await moveIfExists(path.join(rollbackRoot, "postgres"), path.join(root, "postgres")).catch(() => undefined);
      await moveIfExists(path.join(rollbackRoot, "mail-draft-attachments"), path.join(root, "mail-draft-attachments")).catch(() => undefined);
      if (archive.manifest.keySource === "file") {
        await moveIfExists(path.join(rollbackRoot, "master.key"), path.join(root, "master.key")).catch(() => undefined);
      }
      resetCredentialKeyCache();
      await getDatabase().catch(() => undefined);
    }
    if (schedulerStopped) ensureMailSyncScheduler();
    throw error instanceof BackupError ? error : new BackupError(error instanceof Error ? `恢复失败：${error.message}` : "恢复失败", 500);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (!swapStarted) await rm(rollbackRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readAndValidateArchive(input: Uint8Array): Promise<{
  readonly manifest: BackupManifest;
  readonly databaseBytes: Buffer;
  readonly masterKey?: Buffer;
  readonly attachments: readonly { readonly name: string; readonly bytes: Buffer }[];
}> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input, { checkCRC32: true });
  } catch {
    throw new BackupError("无法读取备份 ZIP，文件可能已损坏");
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > 5_000) throw new BackupError("备份文件包含过多项目");
  for (const entry of entries) validateArchivePath(entry.name);

  const manifest = parseManifest(await readZipText(zip, "manifest.json"));
  const checksumPayload = JSON.parse(await readZipText(zip, "checksums.json")) as { readonly algorithm?: unknown; readonly files?: unknown };
  if (checksumPayload.algorithm !== "sha256" || !checksumPayload.files || typeof checksumPayload.files !== "object") {
    throw new BackupError("备份校验信息无效");
  }
  const checksums = checksumPayload.files as Record<string, unknown>;
  for (const [name, expected] of Object.entries(checksums)) {
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new BackupError("备份校验信息无效");
    const entry = zip.file(name);
    if (!entry) throw new BackupError(`备份缺少文件：${name}`);
    const bytes = await entry.async("nodebuffer");
    if (sha256(bytes) !== expected) throw new BackupError(`备份文件校验失败：${name}`);
  }

  const databaseEntry = zip.file(manifest.databaseArchive);
  if (!databaseEntry) throw new BackupError("备份缺少数据库快照");
  const databaseBytes = await databaseEntry.async("nodebuffer");
  const masterKeyEntry = zip.file("master.key");
  const masterKey = masterKeyEntry ? await masterKeyEntry.async("nodebuffer") : undefined;
  if (masterKey && Buffer.from(masterKey.toString("utf8").trim(), "base64").length !== 32) {
    throw new BackupError("备份中的主密钥无效");
  }
  const attachments = await Promise.all(entries
    .filter((entry) => entry.name.startsWith("mail-draft-attachments/"))
    .map(async (entry) => ({ name: entry.name, bytes: await entry.async("nodebuffer") })));
  const expandedBytes = databaseBytes.length + (masterKey?.length ?? 0) + attachments.reduce((total, item) => total + item.bytes.length, 0);
  if (expandedBytes > MAX_BACKUP_BYTES * 2) throw new BackupError("备份解压后的内容过大", 413);
  return { manifest, databaseBytes, masterKey, attachments };
}

async function validateStagedDatabase(database: PGlite, manifest: BackupManifest): Promise<Readonly<Record<string, number>>> {
  const result = await database.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const tables = new Set(result.rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
  if (missing.length) throw new BackupError(`备份数据库缺少必要数据表：${missing.join("、")}`);
  const counts = await readTableCounts(database);
  for (const table of REQUIRED_TABLES) {
    if (typeof manifest.counts[table] === "number" && counts[table] !== manifest.counts[table]) {
      throw new BackupError(`备份数据库的数据数量校验失败：${table}`);
    }
  }
  return counts;
}

async function readTableCounts(database: PGlite): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  const available = await database.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const tables = new Set(available.rows.map((row) => row.table_name));
  for (const table of COUNTED_TABLES) {
    if (!tables.has(table)) {
      counts[table] = 0;
      continue;
    }
    const result = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

async function readDirectoryFiles(directory: string, prefix: string): Promise<readonly { readonly name: string; readonly bytes: Buffer }[]> {
  if (!await pathExists(directory)) return [];
  const items: { name: string; bytes: Buffer }[] = [];
  const visit = async (current: string, relative: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new BackupError("附件目录包含不支持的符号链接", 500);
      const nextPath = path.join(current, entry.name);
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(nextPath, nextRelative);
      else if (entry.isFile()) items.push({ name: `${prefix}/${nextRelative.replaceAll("\\", "/")}`, bytes: await readFile(nextPath) });
    }
  };
  await visit(directory, "");
  return items;
}

async function directorySize(directory: string): Promise<{ readonly bytes: number; readonly files: number }> {
  if (!await pathExists(directory)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) {
        const metadata = await stat(next);
        bytes += metadata.size;
        files += 1;
      }
    }
  };
  await visit(directory);
  return { bytes, files };
}

async function latestBackupTime(directory: string): Promise<string | undefined> {
  if (!await pathExists(directory)) return undefined;
  let latest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".zip")) continue;
    latest = Math.max(latest, (await stat(path.join(directory, entry.name))).mtimeMs);
  }
  return latest ? new Date(latest).toISOString() : undefined;
}

async function detectKeySource(root: string): Promise<BackupKeySource> {
  if (process.env.KALENDER_MASTER_KEY) return "environment";
  return await pathExists(path.join(root, "master.key")) ? "file" : "none";
}

function validateKeyCompatibility(manifest: BackupManifest, masterKey?: Buffer): void {
  if (manifest.keySource === "file" && !masterKey) throw new BackupError("备份缺少主密钥，无法恢复账户凭据");
  if (manifest.keySource === "file" && process.env.KALENDER_MASTER_KEY) {
    throw new BackupError("该备份使用本地主密钥，但当前应用配置了环境主密钥，无法安全恢复");
  }
  if (manifest.keySource === "environment" && !process.env.KALENDER_MASTER_KEY) {
    throw new BackupError("该备份依赖环境变量 KALENDER_MASTER_KEY，请先配置原来的主密钥");
  }
}

function parseManifest(value: string): BackupManifest {
  let manifest: Partial<BackupManifest>;
  try {
    manifest = JSON.parse(value) as Partial<BackupManifest>;
  } catch {
    throw new BackupError("备份清单无法解析");
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.backupVersion !== BACKUP_VERSION) {
    throw new BackupError("不支持这个备份文件版本");
  }
  if (manifest.databaseArchive !== "database.tgz" || manifest.databaseEngine !== "pglite") {
    throw new BackupError("备份数据库格式无效");
  }
  if (!manifest.counts || typeof manifest.counts !== "object" || typeof manifest.createdAt !== "string") {
    throw new BackupError("备份清单不完整");
  }
  if (manifest.keySource !== "file" && manifest.keySource !== "environment" && manifest.keySource !== "none") {
    throw new BackupError("备份密钥信息无效");
  }
  return manifest as BackupManifest;
}

async function readZipText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new BackupError(`备份缺少文件：${name}`);
  return entry.async("string");
}

function validateArchivePath(name: string): void {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
    throw new BackupError("备份包含不安全的文件路径");
  }
}

function safeArchiveDestination(root: string, relative: string): string {
  validateArchivePath(relative);
  const destination = path.resolve(root, ...relative.split("/"));
  const resolvedRoot = path.resolve(root);
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new BackupError("备份包含不安全的附件路径");
  return destination;
}

function childPath(root: string, name: string): string {
  const destination = path.resolve(root, name);
  const resolvedRoot = path.resolve(root);
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new BackupError("恢复目录无效", 500);
  return destination;
}

async function moveIfExists(source: string, destination: string): Promise<void> {
  if (await pathExists(source)) await rename(source, destination);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function backupFilename(createdAt: string): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `Kalender-backup-${stamp}.zip`;
}

async function withBackupOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (globalThis.kalenderBackupOperationRunning) throw new BackupError("另一个备份或恢复操作正在进行", 409);
  globalThis.kalenderBackupOperationRunning = true;
  try {
    return await operation();
  } finally {
    globalThis.kalenderBackupOperationRunning = false;
  }
}
