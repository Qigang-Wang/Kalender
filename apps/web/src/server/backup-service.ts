import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline as pipelineCallback, Readable } from "node:stream";
import { promisify } from "node:util";

import { closeDatabaseForRestore, dataRoot, getDatabase, type DatabaseExecutor } from "./database";
import type { AppUser } from "./auth";
import { appendJobLog, consumeJobSecret, enqueueJob, setJobSecret, updateJobProgress, type AppJob } from "./job-service";
import { stopMailSyncScheduler } from "./mail-sync-scheduler";
import { stopCalendarSyncScheduler } from "./calendar-sync-scheduler";
import { decryptCredential, encryptCredential } from "./credential-crypto";

const pipeline = promisify(pipelineCallback);
const scrypt = promisify(scryptCallback);
const BACKUP_ESTIMATE_CACHE_TTL_MS = 5 * 60 * 1000;
const BACKUP_PACKAGE_OVERHEAD_BYTES = 64 * 1024;
const PORTABLE_CREDENTIALS_FILENAME = "portable-credentials.json";

const PORTABLE_CREDENTIAL_STORES = [
  { id: "mail", table: "encrypted_credentials", keyColumn: "account_id" },
  { id: "calendar", table: "calendar_encrypted_credentials", keyColumn: "account_id" },
  { id: "exchange", table: "exchange_connection_credentials", keyColumn: "connection_id" },
  { id: "ai", table: "ai_provider_credentials", keyColumn: "provider_id" },
] as const;

type PortableCredentialStoreId = typeof PORTABLE_CREDENTIAL_STORES[number]["id"];

export interface PortableCredentialEntry {
  readonly store: PortableCredentialStoreId;
  readonly key: string;
  readonly value: unknown;
}

export interface PortableCredentialBundle {
  readonly version: 1;
  readonly entries: readonly PortableCredentialEntry[];
}

let lightweightEstimateCache: {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly bytes: number;
} | undefined;

export const MAX_BACKUP_BYTES = Math.max(1, Number(process.env.KALENDER_BACKUP_MAX_BYTES ?? 512 * 1024 * 1024));

const COUNTED_TABLES = [
  "accounts",
  "calendar_accounts",
  "calendars",
  "calendar_events",
  "projects",
  "notes",
  "tasks",
  "mail_drafts",
  "mail_signatures",
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

type BackupKeySource = "environment" | "none";
export type BackupMailPolicy = "lightweight" | "full-archive" | "configuration-only";

export interface BackupMailCacheStats {
  readonly totalMessages: number;
  readonly cachedBodies: number;
  readonly cachedBodyBytes: number;
}

export interface BackupToolStatus {
  readonly pgDump: boolean;
  readonly pgRestore: boolean;
  readonly tar: boolean;
  readonly openssl: boolean;
}

export interface BackupCommand {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly command: string;
}

export interface BackupCoverageItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly included: boolean;
}

export interface BackupPolicyOption {
  readonly policy: BackupMailPolicy;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly available: boolean;
  readonly disabledReason?: string;
  readonly coverage: readonly BackupCoverageItem[];
}

export interface BackupStrategy {
  readonly recommendedMailPolicy: BackupMailPolicy;
  readonly backupDirectory: string;
  readonly attachmentDirectory: string;
  readonly tools: BackupToolStatus;
  readonly coverage: readonly BackupCoverageItem[];
  readonly options: readonly BackupPolicyOption[];
  readonly backupCommands: readonly BackupCommand[];
  readonly restoreCommands: readonly BackupCommand[];
  readonly warnings: readonly string[];
}

export interface BackupManifest {
  readonly schemaVersion: number;
  readonly counts: Readonly<Record<string, number>>;
}

export interface WorkspaceBackupStatus {
  readonly databaseBytes: number;
  readonly estimatedLightweightBytes: number;
  readonly attachmentBytes: number;
  readonly attachmentFiles: number;
  readonly keySource: BackupKeySource;
  readonly counts: Readonly<Record<string, number>>;
  readonly mailCache: BackupMailCacheStats;
  readonly latestAutomaticBackupAt?: string;
  readonly automatic: AutomaticBackupSettings;
  readonly strategy: BackupStrategy;
  readonly artifacts: readonly BackupArtifact[];
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
  readonly counts: Readonly<Record<string, number>>;
  readonly databaseBytes: number;
  readonly attachmentFiles: number;
  readonly artifact?: BackupArtifact;
}

export interface BackupArtifact {
  readonly id: string;
  readonly jobId?: string;
  readonly createdByUserId?: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly encrypted: boolean;
  readonly mailPolicy: BackupMailPolicy;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly source: "server" | "upload" | "safety";
  readonly restoredAt?: string;
  readonly createdAt: string;
}

export interface AutomaticBackupSettings {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly retentionCount: number;
  readonly encryptAutomatic: boolean;
  readonly encryptionPasswordConfigured: boolean;
  readonly nextRunAt?: string;
  readonly lastEnqueuedAt?: string;
  readonly lastCompletedAt?: string;
  readonly updatedAt?: string;
}

export class BackupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "BackupError";
  }
}

export async function getWorkspaceBackupStatus(): Promise<WorkspaceBackupStatus> {
  const root = dataRoot();
  const database = await getDatabase();
  const [attachmentSize, databaseBytes, lightweightDatabaseBytes, counts, mailCache, latestAutomaticBackupAt, tools, artifacts, automatic] = await Promise.all([
    directorySize(path.join(root, "mail-draft-attachments")),
    readDatabaseBytes(database),
    readLightweightDatabaseBytes(database),
    readTableCounts(database),
    readMailCacheStats(database),
    latestAutomaticBackupTime(database),
    readBackupToolStatus(),
    listBackupArtifacts({ limit: 8 }),
    getAutomaticBackupSettings(),
  ]);
  return {
    databaseBytes,
    estimatedLightweightBytes: await readEstimatedLightweightBackupBytes(
      lightweightDatabaseBytes,
      attachmentSize.bytes,
      tools.pgDump,
    ),
    attachmentBytes: attachmentSize.bytes,
    attachmentFiles: attachmentSize.files,
    keySource: process.env.KALENDER_MASTER_KEY ? "environment" : "none",
    counts,
    mailCache,
    latestAutomaticBackupAt,
    automatic,
    strategy: buildBackupStrategy(root, tools, mailCache),
    artifacts,
  };
}

export async function getAutomaticBackupSettings(databaseInput?: DatabaseExecutor): Promise<AutomaticBackupSettings> {
  const database = databaseInput ?? await getDatabase();
  const result = await database.query<AutomaticBackupSettingsRow>(
    `SELECT enabled, interval_hours, retention_count, encrypt_automatic,
            next_run_at, last_enqueued_at, last_completed_at, updated_at
       FROM backup_settings
      WHERE id = 'workspace'
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return {
      enabled: false,
      intervalHours: 24,
      retentionCount: 3,
      encryptAutomatic: false,
      encryptionPasswordConfigured: Boolean(process.env.KALENDER_BACKUP_PASSWORD),
    };
  }
  return mapAutomaticBackupSettings(row);
}

export async function saveAutomaticBackupSettings(actor: AppUser, input: {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly retentionCount: number;
  readonly encryptAutomatic: boolean;
}): Promise<AutomaticBackupSettings> {
  if (actor.role !== "admin") throw new BackupError("需要管理员权限", 403);
  if (input.enabled && input.encryptAutomatic && !process.env.KALENDER_BACKUP_PASSWORD) {
    throw new BackupError("自动加密备份需要先配置 KALENDER_BACKUP_PASSWORD", 400);
  }
  const intervalHours = clampInteger(input.intervalHours, 1, 720);
  const retentionCount = clampInteger(input.retentionCount, 1, 365);
  const database = await getDatabase();
  const result = await database.query<AutomaticBackupSettingsRow>(
    `INSERT INTO backup_settings (
       id, enabled, interval_hours, retention_count, encrypt_automatic, next_run_at, updated_by_user_id, updated_at
     ) VALUES ('workspace', $1, $2, $3, $4, now() + ($2 || ' hours')::interval, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       interval_hours = EXCLUDED.interval_hours,
       retention_count = EXCLUDED.retention_count,
       encrypt_automatic = EXCLUDED.encrypt_automatic,
       next_run_at = CASE
         WHEN backup_settings.enabled IS DISTINCT FROM EXCLUDED.enabled OR backup_settings.next_run_at IS NULL
         THEN EXCLUDED.next_run_at
         ELSE backup_settings.next_run_at
       END,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()
     RETURNING enabled, interval_hours, retention_count, encrypt_automatic,
               next_run_at, last_enqueued_at, last_completed_at, updated_at`,
    [input.enabled, intervalHours, retentionCount, input.encryptAutomatic, actor.id],
  );
  return mapAutomaticBackupSettings(result.rows[0]!);
}

export async function exportWorkspaceBackup(): Promise<WorkspaceBackupResult> {
  const artifacts = await listBackupArtifacts({ limit: 1 });
  const latest = artifacts[0];
  if (!latest) throw new BackupError("还没有可下载的备份，请先创建备份", 404);
  return {
    bytes: await readFile(artifactPath(latest.filename)),
    filename: latest.filename,
    manifest: { schemaVersion: Number(latest.manifest.schemaVersion ?? 1), counts: objectCounts(latest.manifest.counts) },
  };
}

export async function restoreWorkspaceBackup(input: Uint8Array): Promise<WorkspaceRestoreResult> {
  const artifact = await saveUploadedBackup(input, { actor: undefined, filename: `uploaded-${Date.now()}.backup` });
  return {
    restoredAt: new Date().toISOString(),
    counts: objectCounts(artifact.manifest.counts),
    safetyBackupFilename: "queued-via-upload",
  };
}

export async function inspectWorkspaceBackup(input: Uint8Array): Promise<WorkspaceBackupInspection> {
  const artifact = await saveUploadedBackup(input, { actor: undefined, filename: `inspection-${Date.now()}.backup`, transient: true });
  return {
    counts: objectCounts(artifact.manifest.counts),
    databaseBytes: Number(artifact.manifest.databaseBytes ?? 0),
    attachmentFiles: Number(artifact.manifest.attachmentFiles ?? 0),
    artifact,
  };
}

export async function createBackupJob(actor: AppUser, input: {
  readonly encrypted: boolean;
  readonly mailPolicy?: BackupMailPolicy;
  readonly password?: string;
}): Promise<AppJob> {
  if (actor.role !== "admin") throw new BackupError("需要管理员权限", 403);
  if (input.encrypted && !input.password) throw new BackupError("加密备份需要备份密码");
  const mailPolicy = normalizeBackupMailPolicy(input.mailPolicy);
  if (mailPolicy !== "lightweight") {
    throw new BackupError(
      mailPolicy === "configuration-only"
        ? "仅配置备份需要独立恢复流程，当前版本暂未开放创建"
        : "完整邮箱归档需要先支持全量邮件正文和附件预抓取，当前版本暂未开放创建",
      400,
    );
  }
  const job = await enqueueJob({
    kind: "backup.create",
    actor,
    title: input.encrypted ? "创建加密轻量工作区备份" : "创建轻量工作区备份",
    payload: { encrypted: input.encrypted, mailPolicy },
    maxAttempts: 1,
    deferStart: Boolean(input.password),
  });
  if (input.password) setJobSecret(job.id, input.password);
  if (input.password) void import("./job-service").then((service) => { service.ensureJobRunner(); void service.drainJobQueue(); });
  return job;
}

export async function createRestoreJob(actor: AppUser, input: {
  readonly artifactId: string;
  readonly password?: string;
}): Promise<AppJob> {
  if (actor.role !== "admin") throw new BackupError("需要管理员权限", 403);
  const artifact = await getBackupArtifact(input.artifactId);
  if (!artifact) throw new BackupError("备份不存在", 404);
  if (artifact.encrypted && !input.password) throw new BackupError("恢复加密备份需要备份密码");
  const job = await enqueueJob({
    kind: "backup.restore",
    actor,
    title: `恢复备份 ${artifact.filename}`,
    payload: { artifactId: artifact.id },
    maxAttempts: 1,
    deferStart: Boolean(input.password),
  });
  if (input.password) setJobSecret(job.id, input.password);
  if (input.password) void import("./job-service").then((service) => { service.ensureJobRunner(); void service.drainJobQueue(); });
  return job;
}

export async function listBackupArtifacts(options: { readonly limit?: number } = {}): Promise<readonly BackupArtifact[]> {
  const database = await getDatabase();
  await migrateLegacyBackupFilenames(database);
  const result = await database.query<BackupArtifactRow>(
    `SELECT * FROM backup_artifacts ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(options.limit ?? 20, 100))],
  );
  return result.rows.map(mapArtifact);
}

export async function getBackupArtifact(id: string): Promise<BackupArtifact | undefined> {
  const database = await getDatabase();
  const result = await database.query<BackupArtifactRow>("SELECT * FROM backup_artifacts WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
}

export async function deleteBackupArtifact(actor: AppUser, id: string): Promise<void> {
  if (actor.role !== "admin") throw new BackupError("需要管理员权限", 403);
  const database = await getDatabase();
  const result = await database.query<BackupArtifactRow>("SELECT * FROM backup_artifacts WHERE id = $1 LIMIT 1", [id]);
  const row = result.rows[0];
  if (!row) throw new BackupError("备份不存在", 404);
  const restoreJobs = await database.query<{ readonly id: string }>(
    `SELECT id
       FROM app_jobs
      WHERE kind = 'backup.restore'
        AND status IN ('queued', 'running')
        AND payload->>'artifactId' = $1
      LIMIT 1`,
    [id],
  );
  if (restoreJobs.rows[0]) throw new BackupError("该备份正在恢复，暂时不能删除", 409);
  await rm(artifactPath(row.filename), { force: true });
  await database.query("DELETE FROM backup_artifacts WHERE id = $1", [id]);
}

export async function readBackupArtifactFile(id: string): Promise<{ readonly artifact: BackupArtifact; readonly bytes: Buffer }> {
  const artifact = await getBackupArtifact(id);
  if (!artifact) throw new BackupError("备份不存在", 404);
  return { artifact, bytes: await readFile(artifactPath(artifact.filename)) };
}

export async function saveUploadedBackup(
  input: Uint8Array,
  options: { readonly actor?: AppUser; readonly filename: string; readonly transient?: boolean },
): Promise<BackupArtifact> {
  if (input.byteLength > MAX_BACKUP_BYTES) throw new BackupError("备份文件不能超过 512 MB", 413);
  await mkdir(backupDirectory(), { recursive: true, mode: 0o700 });
  const safeName = normalizeBackupFilename(options.filename);
  const filename = `upload-${Date.now()}-${safeName}`;
  const filePath = artifactPath(filename);
  await writeFile(filePath, Buffer.from(input), { mode: 0o600 });
  const checksumSha256 = await sha256File(filePath);
  const metadata = await inspectBackupFile(filePath, undefined).catch(async () => ({
    encrypted: fileLooksEncrypted(await readFile(filePath, { encoding: "utf8" }).catch(() => "")),
    manifest: { inspected: false },
  }));
  const manifest = metadata.manifest as Readonly<Record<string, unknown>>;
  const mailPolicy = normalizeBackupMailPolicy(typeof manifest.mailPolicy === "string" ? manifest.mailPolicy : undefined);
  if (options.transient) {
    await rm(filePath, { force: true });
    return {
      id: "transient",
      filename,
      sizeBytes: input.byteLength,
      checksumSha256,
      encrypted: metadata.encrypted,
      mailPolicy,
      manifest: metadata.manifest,
      source: "upload",
      createdAt: new Date().toISOString(),
    };
  }
  const database = await getDatabase();
  const id = randomUUID();
  await database.query(
    `INSERT INTO backup_artifacts (
       id, created_by_user_id, filename, file_path, size_bytes, checksum_sha256,
       encrypted, mail_policy, manifest, source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'upload')`,
    [id, options.actor?.id ?? null, filename, filePath, input.byteLength, checksumSha256, metadata.encrypted, mailPolicy, JSON.stringify(metadata.manifest)],
  );
  return (await getBackupArtifact(id))!;
}

export async function runBackupCreateJob(job: AppJob): Promise<Readonly<Record<string, unknown>>> {
  const encrypted = job.payload.encrypted === true;
  const automatic = job.payload.automatic === true;
  const mailPolicy = normalizeBackupMailPolicy(typeof job.payload.mailPolicy === "string" ? job.payload.mailPolicy : undefined);
  const password = consumeJobSecret(job.id) ?? (automatic ? process.env.KALENDER_BACKUP_PASSWORD : undefined);
  if (encrypted && !password) throw new BackupError("加密备份缺少密码");
  const tools = await readBackupToolStatus();
  if (!tools.pgDump) throw new BackupError("服务器缺少 pg_dump，请安装 PostgreSQL client", 501);
  if (!tools.tar) throw new BackupError("服务器缺少 tar", 501);

  await mkdir(backupDirectory(), { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(path.join(tmpdir(), "qgw-backup-"));
  const startedAt = new Date().toISOString();
  const database = await getDatabase();
  const counts = await readTableCounts(database);
  const mailCache = await readMailCacheStats(database);
  const root = dataRoot();
  const databaseDump = path.join(workDir, "database.dump");
  const attachments = path.join(workDir, "mail-draft-attachments.tgz");
  const manifestPath = path.join(workDir, "manifest.json");
  const portableCredentialsPath = path.join(workDir, PORTABLE_CREDENTIALS_FILENAME);
  const sumsPath = path.join(workDir, "SHA256SUMS");
  try {
    await appendJobLog(job.id, "正在导出 PostgreSQL 数据库");
    await runCommand("pg_dump", buildDatabaseDumpArgs(mailPolicy, databaseDump, databaseUrl()));
    await updateJobProgress(job.id, 35);

    await appendJobLog(job.id, "正在打包草稿附件");
    const attachmentRoot = path.join(root, "mail-draft-attachments");
    if (await pathExists(attachmentRoot)) {
      await runCommand("tar", ["-C", root, "-czf", attachments, "mail-draft-attachments"]);
    } else {
      await runCommand("tar", ["-czf", attachments, "--files-from", "/dev/null"]);
    }
    await updateJobProgress(job.id, 55);

    let portableCredentialCount = 0;
    if (encrypted) {
      await appendJobLog(job.id, "正在生成可迁移连接凭据");
      const portableCredentials = await exportPortableCredentialBundle(database);
      portableCredentialCount = portableCredentials.entries.length;
      await writeFile(portableCredentialsPath, JSON.stringify(portableCredentials), { mode: 0o600 });
    }

    const [databaseBytes, attachmentSize] = await Promise.all([stat(databaseDump), stat(attachments)]);
    const manifest = {
      format: "qgwbackup",
      schemaVersion: 2,
      createdAt: startedAt,
      app: "Dayline",
      automatic,
      databaseBytes: databaseBytes.size,
      attachmentBytes: attachmentSize.size,
      attachmentFiles: (await directorySize(attachmentRoot)).files,
      mailPolicy,
      mailBodyCache: {
        ...mailCache,
        included: mailPolicy === "full-archive",
      },
      encrypted,
      portableCredentials: encrypted,
      portableCredentialCount,
      requiresOriginalMasterKey: !encrypted,
      counts,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const hashes = [
      `${await sha256File(databaseDump)}  database.dump`,
      `${await sha256File(attachments)}  mail-draft-attachments.tgz`,
      `${await sha256File(manifestPath)}  manifest.json`,
      ...(encrypted ? [`${await sha256File(portableCredentialsPath)}  ${PORTABLE_CREDENTIALS_FILENAME}`] : []),
    ].join("\n");
    await writeFile(sumsPath, `${hashes}\n`, { mode: 0o600 });
    await updateJobProgress(job.id, 72);

    const baseName = `dayline-${new Date().toISOString().replace(/[:.]/g, "-")}.backup`;
    const plainPackage = encrypted ? path.join(workDir, baseName) : path.join(backupDirectory(), baseName);
    const packageFiles = ["database.dump", "mail-draft-attachments.tgz", "manifest.json", "SHA256SUMS"];
    if (encrypted) packageFiles.push(PORTABLE_CREDENTIALS_FILENAME);
    await runCommand("tar", ["-C", workDir, "-czf", plainPackage, ...packageFiles]);
    const finalPath = encrypted ? path.join(backupDirectory(), `${baseName}.enc`) : plainPackage;
    const finalName = encrypted ? `${baseName}.enc` : baseName;
    if (encrypted) {
      await encryptFile(plainPackage, finalPath, password!);
    }
    const finalStat = await stat(finalPath);
    const checksumSha256 = await sha256File(finalPath);
    const artifactId = randomUUID();
    const safety = job.id.endsWith("-safety");
    await database.query(
      `INSERT INTO backup_artifacts (
         id, job_id, created_by_user_id, filename, file_path, size_bytes,
         checksum_sha256, encrypted, mail_policy, manifest, source
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'server')`,
      [artifactId, safety ? null : job.id, job.userId ?? null, finalName, finalPath, finalStat.size, checksumSha256, encrypted, mailPolicy, JSON.stringify(manifest)],
    );
    if (safety) await database.query("UPDATE backup_artifacts SET source = 'safety' WHERE id = $1", [artifactId]);
    if (automatic) {
      await database.query(
        `UPDATE backup_settings
            SET last_completed_at = now(),
                next_run_at = now() + (interval_hours || ' hours')::interval,
                updated_at = now()
          WHERE id = 'workspace'`,
      );
      await pruneAutomaticBackups(database);
    }
    await appendJobLog(job.id, `备份已创建：${finalName}`);
    return { artifactId, filename: finalName, sizeBytes: finalStat.size, checksumSha256, encrypted };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function scheduleDueAutomaticBackup(): Promise<AppJob | undefined> {
  const database = await getDatabase();
  const dueResult = await database.query<AutomaticBackupSettingsRow>(
    `SELECT enabled, interval_hours, retention_count, encrypt_automatic,
            next_run_at, last_enqueued_at, last_completed_at, updated_at
       FROM backup_settings
      WHERE id = 'workspace'
        AND enabled = true
        AND (next_run_at IS NULL OR next_run_at <= now())
      LIMIT 1`,
  );
  const due = dueResult.rows[0];
  if (!due) return undefined;
  if (due.encrypt_automatic && !process.env.KALENDER_BACKUP_PASSWORD) {
    const deferred = await database.query(
      `UPDATE backup_settings
          SET next_run_at = now() + (interval_hours || ' hours')::interval,
              updated_at = now()
        WHERE id = 'workspace'
          AND enabled = true
          AND (next_run_at IS NULL OR next_run_at <= now())`,
    );
    if (deferred.affectedRows) await appendSyntheticMaintenanceJob("自动加密备份需要配置 KALENDER_BACKUP_PASSWORD；未加密自动备份不需要密码");
    return undefined;
  }
  const result = await database.query<AutomaticBackupSettingsRow>(
    `UPDATE backup_settings
        SET last_enqueued_at = now(),
            next_run_at = now() + (interval_hours || ' hours')::interval,
            updated_at = now()
      WHERE id = 'workspace'
        AND enabled = true
        AND (next_run_at IS NULL OR next_run_at <= now())
      RETURNING enabled, interval_hours, retention_count, encrypt_automatic,
                next_run_at, last_enqueued_at, last_completed_at, updated_at`,
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const encrypted = Boolean(row.encrypt_automatic);
  if (encrypted && !process.env.KALENDER_BACKUP_PASSWORD) {
    await appendSyntheticMaintenanceJob("自动加密备份需要配置 KALENDER_BACKUP_PASSWORD；未加密自动备份不需要密码");
    return undefined;
  }
  const job = await enqueueJob({
    kind: "backup.create",
    title: encrypted ? "自动创建加密工作区备份" : "自动创建工作区备份",
    payload: { encrypted, automatic: true },
    idempotencyKey: `backup.auto:${new Date().toISOString().slice(0, 13)}`,
    maxAttempts: 2,
    deferStart: encrypted,
  });
  if (encrypted && process.env.KALENDER_BACKUP_PASSWORD) setJobSecret(job.id, process.env.KALENDER_BACKUP_PASSWORD);
  return job;
}

export async function runBackupRestoreJob(job: AppJob): Promise<Readonly<Record<string, unknown>>> {
  const artifactId = typeof job.payload.artifactId === "string" ? job.payload.artifactId : "";
  const password = consumeJobSecret(job.id);
  const artifact = await getBackupArtifact(artifactId);
  if (!artifact) throw new BackupError("备份不存在", 404);
  if (artifact.encrypted && !password) throw new BackupError("恢复加密备份需要备份密码");
  const tools = await readBackupToolStatus();
  if (!tools.pgRestore) throw new BackupError("服务器缺少 pg_restore，请安装 PostgreSQL client", 501);
  if (!tools.tar) throw new BackupError("服务器缺少 tar", 501);

  await appendJobLog(job.id, "正在创建恢复前安全备份");
  const safety = await runBackupCreateJob({
    ...job,
    id: `${job.id}-safety`,
    title: "恢复前安全备份",
    payload: { encrypted: false, mailPolicy: "full-archive" },
    kind: "backup.create",
  });
  await updateJobProgress(job.id, 20);
  const workDir = await mkdtemp(path.join(tmpdir(), "qgw-restore-"));
  try {
    await appendJobLog(job.id, "正在停止邮件和日历同步");
    await Promise.all([stopMailSyncScheduler(), stopCalendarSyncScheduler()]);
    const packagePath = artifactPath(artifact.filename);
    const plainPackage = artifact.encrypted ? path.join(workDir, "decrypted.backup") : packagePath;
    if (artifact.encrypted) await decryptFile(packagePath, plainPackage, password!);
    await runCommand("tar", ["-C", workDir, "-xzf", plainPackage]);
    await verifyExtractedBackup(workDir);
    await updateJobProgress(job.id, 45);

    await appendJobLog(job.id, "正在关闭数据库连接并恢复 PostgreSQL");
    await closeDatabaseForRestore();
    await runCommand("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", `--dbname=${databaseUrl()}`, path.join(workDir, "database.dump")]);
    await updateJobProgress(job.id, 80);

    await appendJobLog(job.id, "正在恢复草稿附件");
    await runCommand("tar", ["-C", dataRoot(), "-xzf", path.join(workDir, "mail-draft-attachments.tgz")]);
    const database = await getDatabase();
    const portableCredentialsFile = path.join(workDir, PORTABLE_CREDENTIALS_FILENAME);
    if (await pathExists(portableCredentialsFile)) {
      if (!artifact.encrypted) throw new BackupError("可迁移凭据只允许存在于加密备份中", 400);
      await appendJobLog(job.id, "正在使用当前服务器主密钥重新加密连接凭据");
      const portableCredentials = parsePortableCredentialBundle(
        JSON.parse(await readFile(portableCredentialsFile, "utf8")) as unknown,
      );
      const restoredCredentialCount = await restorePortableCredentialBundle(database, portableCredentials);
      await appendJobLog(job.id, `已迁移 ${restoredCredentialCount} 项连接凭据`);
    } else {
      await appendJobLog(job.id, "该备份不含可迁移凭据；账户连接可能仍需要原主密钥或重新输入密码");
    }
    await database.query("UPDATE backup_artifacts SET restored_at = now() WHERE id = $1", [artifact.id]).catch(() => undefined);
    await appendJobLog(job.id, "恢复完成");
    return { artifactId: artifact.id, safetyBackup: safety.filename, restoredAt: new Date().toISOString() };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function exportPortableCredentialBundle(database: DatabaseExecutor): Promise<PortableCredentialBundle> {
  const entries: PortableCredentialEntry[] = [];
  for (const store of PORTABLE_CREDENTIAL_STORES) {
    const result = await database.query<{ readonly key: string; readonly encrypted_payload: string }>(
      `SELECT ${store.keyColumn} AS key, encrypted_payload FROM ${store.table} ORDER BY ${store.keyColumn}`,
    );
    for (const row of result.rows) {
      entries.push({
        store: store.id,
        key: row.key,
        value: await decryptCredential<unknown>(row.key, row.encrypted_payload),
      });
    }
  }
  return { version: 1, entries };
}

export async function restorePortableCredentialBundle(
  database: DatabaseExecutor,
  bundle: PortableCredentialBundle,
): Promise<number> {
  let restored = 0;
  for (const entry of bundle.entries) {
    const store = PORTABLE_CREDENTIAL_STORES.find((candidate) => candidate.id === entry.store);
    if (!store) throw new BackupError("可迁移凭据包含未知存储类型", 400);
    const encryptedPayload = await encryptCredential(entry.key, entry.value);
    const result = await database.query(
      `UPDATE ${store.table}
          SET encrypted_payload = $2, key_version = 1, updated_at = now()
        WHERE ${store.keyColumn} = $1`,
      [entry.key, encryptedPayload],
    );
    if (result.affectedRows !== 1) throw new BackupError(`无法恢复连接凭据：${entry.store}/${entry.key}`, 400);
    restored += 1;
  }
  return restored;
}

export function parsePortableCredentialBundle(value: unknown): PortableCredentialBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BackupError("可迁移凭据格式无效", 400);
  const input = value as { readonly version?: unknown; readonly entries?: unknown };
  if (input.version !== 1 || !Array.isArray(input.entries)) throw new BackupError("可迁移凭据版本无效", 400);
  const validStores = new Set<string>(PORTABLE_CREDENTIAL_STORES.map((store) => store.id));
  const entries = input.entries.map((entry): PortableCredentialEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new BackupError("可迁移凭据条目无效", 400);
    const candidate = entry as { readonly store?: unknown; readonly key?: unknown; readonly value?: unknown };
    if (typeof candidate.store !== "string" || !validStores.has(candidate.store)) throw new BackupError("可迁移凭据存储类型无效", 400);
    if (typeof candidate.key !== "string" || !candidate.key.trim()) throw new BackupError("可迁移凭据标识无效", 400);
    return { store: candidate.store as PortableCredentialStoreId, key: candidate.key, value: candidate.value };
  });
  return { version: 1, entries };
}

async function readTableCounts(database: DatabaseExecutor): Promise<Readonly<Record<string, number>>> {
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

async function readMailCacheStats(database: DatabaseExecutor): Promise<BackupMailCacheStats> {
  const available = await database.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('mail_messages', 'mail_message_bodies')`,
  );
  const tables = new Set(available.rows.map((row) => row.table_name));
  if (!tables.has("mail_messages")) return { totalMessages: 0, cachedBodies: 0, cachedBodyBytes: 0 };
  if (!tables.has("mail_message_bodies")) {
    return { totalMessages: Number((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM mail_messages")).rows[0]?.count ?? 0), cachedBodies: 0, cachedBodyBytes: 0 };
  }
  const result = await database.query<{
    total_messages: string | number;
    cached_bodies: string | number;
    cached_body_bytes: string | number;
  }>(
    `SELECT (SELECT count(*)::int FROM mail_messages) AS total_messages,
            count(*)::int AS cached_bodies,
            COALESCE(sum(COALESCE(octet_length(text_body), 0) + COALESCE(octet_length(html_body), 0)), 0)::bigint AS cached_body_bytes
       FROM mail_message_bodies`,
  );
  const row = result.rows[0];
  return {
    totalMessages: Number(row?.total_messages ?? 0),
    cachedBodies: Number(row?.cached_bodies ?? 0),
    cachedBodyBytes: Number(row?.cached_body_bytes ?? 0),
  };
}

async function readDatabaseBytes(database: DatabaseExecutor): Promise<number> {
  const result = await database.query<{ bytes: string | number }>("SELECT pg_database_size(current_database()) AS bytes");
  const value = result.rows[0]?.bytes;
  return typeof value === "number" ? value : Number(value ?? 0);
}

async function readLightweightDatabaseBytes(database: DatabaseExecutor): Promise<number> {
  const result = await database.query<{ bytes: string | number }>(
    `SELECT COALESCE(sum(pg_total_relation_size(relid)), 0)::bigint AS bytes
       FROM pg_catalog.pg_statio_user_tables
      WHERE schemaname = 'public'
        AND relname <> 'mail_message_bodies'`,
  );
  return Number(result.rows[0]?.bytes ?? 0);
}

export function estimateLightweightBackupBytes(databaseBytes: number, attachmentBytes: number): number {
  return Math.max(0, databaseBytes) + Math.max(0, attachmentBytes);
}

async function readEstimatedLightweightBackupBytes(
  lightweightDatabaseBytes: number,
  attachmentBytes: number,
  pgDumpAvailable: boolean,
): Promise<number> {
  const fallback = estimateLightweightBackupBytes(lightweightDatabaseBytes, attachmentBytes);
  if (!pgDumpAvailable) return fallback;

  const fingerprint = `${lightweightDatabaseBytes}:${attachmentBytes}`;
  if (
    lightweightEstimateCache?.fingerprint === fingerprint
    && lightweightEstimateCache.expiresAt > Date.now()
  ) {
    return lightweightEstimateCache.bytes;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "qgw-backup-estimate-"));
  const dumpPath = path.join(workDir, "database.dump");
  try {
    await runCommand("pg_dump", buildDatabaseDumpArgs("lightweight", dumpPath, databaseUrl()));
    const dumpSize = await stat(dumpPath);
    const bytes = dumpSize.size + Math.max(0, attachmentBytes) + BACKUP_PACKAGE_OVERHEAD_BYTES;
    lightweightEstimateCache = {
      fingerprint,
      expiresAt: Date.now() + BACKUP_ESTIMATE_CACHE_TTL_MS,
      bytes,
    };
    return bytes;
  } catch (error) {
    console.warn("Unable to measure lightweight backup size; using storage estimate", error);
    return fallback;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function readBackupToolStatus(): Promise<BackupToolStatus> {
  const [pgDump, pgRestore, tar, openssl] = await Promise.all([
    commandExists("pg_dump"),
    commandExists("pg_restore"),
    commandExists("tar"),
    commandExists("openssl"),
  ]);
  return { pgDump, pgRestore, tar, openssl };
}

function buildBackupStrategy(root: string, tools: BackupToolStatus, mailCache: BackupMailCacheStats): BackupStrategy {
  const backupBase = process.env.KALENDER_BACKUP_DIR
    ? path.resolve(process.env.KALENDER_BACKUP_DIR)
    : path.join(root, "postgres-backups");
  const attachmentDirectory = path.join(root, "mail-draft-attachments");
  const quotedBackupBase = shellQuote(backupBase);
  const quotedAttachmentDirectory = shellQuote(attachmentDirectory);
  const quotedRoot = shellQuote(root);

  const lightweightCoverage: readonly BackupCoverageItem[] = [
    {
      id: "database",
      label: "PostgreSQL 数据库",
      description: "包含用户、邮箱/日历连接、邮件索引、项目、笔记、任务、AI 配置、审计记录和同步状态。",
      included: true,
    },
    {
      id: "draft-attachments",
      label: "邮件草稿附件",
      description: "包含本地保存的草稿附件文件；这些字节不在 PostgreSQL 里。",
      included: true,
    },
    {
      id: "mail-bodies",
      label: "邮件正文缓存",
      description: `${mailCache.cachedBodies}/${mailCache.totalMessages} 封、${formatBytes(mailCache.cachedBodyBytes)} 的正文缓存不进入轻量备份；恢复后查看邮件时按需重新下载。`,
      included: false,
    },
    {
      id: "mail-archive",
      label: "完整邮箱归档",
      description: "不主动下载远端邮箱的全部正文和附件；恢复后通过 IMAP/Exchange 继续同步。",
      included: false,
    },
    {
      id: "master-key",
      label: "可迁移连接凭据",
      description: "加密备份会使用备份密码保护邮箱、日历和 AI 凭据；恢复时不需要原服务器主密钥。",
      included: true,
    },
  ];
  const configurationCoverage: readonly BackupCoverageItem[] = [
    {
      id: "configuration",
      label: "账户与系统配置",
      description: "计划用于账户连接、AI Provider、用户偏好和自动化策略等配置迁移。",
      included: true,
    },
    {
      id: "workspace-data",
      label: "业务数据",
      description: "不包含邮件、日程、任务、项目和笔记正文，避免覆盖日常工作数据。",
      included: false,
    },
    {
      id: "local-files",
      label: "本地附件文件",
      description: "不包含草稿附件或邮件附件文件。",
      included: false,
    },
    {
      id: "master-key",
      label: "可迁移连接凭据",
      description: "仅加密备份可以安全迁移连接凭据。",
      included: false,
    },
  ];
  const fullArchiveCoverage: readonly BackupCoverageItem[] = [
    {
      id: "database",
      label: "PostgreSQL 数据库",
      description: "包含工作区数据、同步索引和已经缓存到数据库的邮件正文。",
      included: true,
    },
    {
      id: "draft-attachments",
      label: "邮件草稿附件",
      description: "包含本地保存的草稿附件文件。",
      included: true,
    },
    {
      id: "mail-bodies",
      label: "全部邮件正文缓存",
      description: `${mailCache.cachedBodies}/${mailCache.totalMessages} 封邮件已有本地正文缓存；完整归档需要先补齐缺失正文。`,
      included: mailCache.totalMessages > 0 && mailCache.cachedBodies === mailCache.totalMessages,
    },
    {
      id: "remote-attachments",
      label: "远端邮件附件",
      description: "当前附件仍按需从邮件服务器读取，还没有全量预抓取和本地归档流程。",
      included: false,
    },
  ];

  return {
    recommendedMailPolicy: "lightweight",
    backupDirectory: backupBase,
    attachmentDirectory,
    tools,
    coverage: lightweightCoverage,
    options: [
      {
        policy: "lightweight",
        label: "轻量工作区快照",
        description: "当前推荐。备份工作区数据、邮件索引和草稿附件，不备份可从邮件服务器重新获取的正文缓存。",
        recommended: true,
        available: true,
        coverage: lightweightCoverage,
      },
      {
        policy: "configuration-only",
        label: "仅配置迁移",
        description: "用于迁移账户连接、AI 设置和用户偏好，不携带日常工作数据。",
        recommended: false,
        available: false,
        disabledReason: "需要专门的部分恢复流程，避免覆盖现有任务、笔记和日程。",
        coverage: configurationCoverage,
      },
      {
        policy: "full-archive",
        label: "完整本地邮件归档",
        description: "目标是把所有已同步邮件正文和附件都纳入备份，适合离线长期保存。",
        recommended: false,
        available: false,
        disabledReason: mailCache.totalMessages === 0
          ? "当前没有已同步邮件；开启邮箱同步后才能评估完整归档。"
          : "还缺少全量邮件正文和远端附件预抓取流程，当前不能保证完整归档。",
        coverage: fullArchiveCoverage,
      },
    ],
    backupCommands: [
      {
        id: "prepare",
        title: "准备备份目录",
        description: "每次备份使用独立时间戳目录，方便保留和回滚。",
        command: `BACKUP_ROOT=${quotedBackupBase}\nBACKUP_DIR="$BACKUP_ROOT/kalender-$(date +%Y%m%d-%H%M%S)"\nmkdir -p "$BACKUP_DIR"`,
      },
      {
        id: "database",
        title: "导出 PostgreSQL",
        description: "使用 PostgreSQL custom format，并跳过可重新下载的邮件正文缓存。",
        command: `pg_dump --format=custom --no-owner --no-acl --exclude-table-data=mail_message_bodies --file="$BACKUP_DIR/database.dump" "$DATABASE_URL"`,
      },
      {
        id: "attachments",
        title: "打包草稿附件",
        description: "附件目录不存在时也会生成一个空占位，恢复脚本可以保持统一。",
        command: `[ -d ${quotedAttachmentDirectory} ] && tar -C ${quotedRoot} -czf "$BACKUP_DIR/mail-draft-attachments.tgz" mail-draft-attachments || tar -czf "$BACKUP_DIR/mail-draft-attachments.tgz" --files-from /dev/null`,
      },
      {
        id: "manifest",
        title: "写入备份说明",
        description: "记录创建时间和密钥要求；真正的密钥请放在密码管理器里。",
        command: `printf 'created_at=%s\\nrequires_KALENDER_MASTER_KEY=true\\nmail_policy=lightweight\\n' "$(date -Iseconds)" > "$BACKUP_DIR/manifest.txt"\nsha256sum "$BACKUP_DIR/database.dump" "$BACKUP_DIR/mail-draft-attachments.tgz" > "$BACKUP_DIR/SHA256SUMS"`,
      },
    ],
    restoreCommands: [
      {
        id: "verify",
        title: "校验备份文件",
        description: "恢复前先确认文件没有损坏。",
        command: `cd "$BACKUP_DIR"\nsha256sum -c SHA256SUMS`,
      },
      {
        id: "database",
        title: "恢复 PostgreSQL",
        description: "会清理目标库中已存在对象；先确认目标 DATABASE_URL 指向正确数据库。",
        command: `pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DATABASE_URL" "$BACKUP_DIR/database.dump"`,
      },
      {
        id: "attachments",
        title: "恢复草稿附件",
        description: "把附件解回 KALENDER_DATA_DIR；恢复前建议先备份现有目录。",
        command: `mkdir -p ${quotedRoot}\ntar -C ${quotedRoot} -xzf "$BACKUP_DIR/mail-draft-attachments.tgz"`,
      },
    ],
    warnings: [
      "不要把完整 DATABASE_URL 或数据库密码写进备份包。",
      "加密备份可使用备份密码迁移邮箱、日历和 AI 凭据，不需要原服务器的 KALENDER_MASTER_KEY。",
      "未加密备份不包含可迁移凭据；跨服务器恢复后需要原主密钥或重新配置连接。",
      "默认邮件策略不会主动抓取远端邮箱的所有历史附件，恢复后需要重新同步邮箱。",
      "恢复前应停止应用写入和邮件同步，避免恢复过程中产生新数据。",
    ],
  };
}

async function commandExists(command: string): Promise<boolean> {
  const searchPath = process.env.PATH ?? "";
  const directories = searchPath.split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    try {
      await access(path.join(directory, command));
      return true;
    } catch {
      // Keep looking in the remaining PATH entries.
    }
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface BackupArtifactRow {
  readonly id: string;
  readonly job_id: string | null;
  readonly created_by_user_id: string | null;
  readonly filename: string;
  readonly file_path: string;
  readonly size_bytes: string | number;
  readonly checksum_sha256: string;
  readonly encrypted: boolean;
  readonly mail_policy: BackupMailPolicy;
  readonly manifest: Record<string, unknown>;
  readonly source: BackupArtifact["source"];
  readonly restored_at: string | null;
  readonly created_at: string;
}

interface AutomaticBackupSettingsRow {
  readonly enabled: boolean;
  readonly interval_hours: string | number;
  readonly retention_count: string | number;
  readonly encrypt_automatic: boolean;
  readonly next_run_at: string | null;
  readonly last_enqueued_at: string | null;
  readonly last_completed_at: string | null;
  readonly updated_at: string | null;
}

function mapArtifact(row: BackupArtifactRow): BackupArtifact {
  return {
    id: row.id,
    jobId: row.job_id ?? undefined,
    createdByUserId: row.created_by_user_id ?? undefined,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    encrypted: Boolean(row.encrypted),
    mailPolicy: row.mail_policy,
    manifest: row.manifest ?? {},
    source: row.source,
    restoredAt: row.restored_at ?? undefined,
    createdAt: row.created_at,
  };
}

function mapAutomaticBackupSettings(row: AutomaticBackupSettingsRow): AutomaticBackupSettings {
  return {
    enabled: Boolean(row.enabled),
    intervalHours: Number(row.interval_hours),
    retentionCount: Number(row.retention_count),
    encryptAutomatic: Boolean(row.encrypt_automatic),
    encryptionPasswordConfigured: Boolean(process.env.KALENDER_BACKUP_PASSWORD),
    nextRunAt: row.next_run_at ?? undefined,
    lastEnqueuedAt: row.last_enqueued_at ?? undefined,
    lastCompletedAt: row.last_completed_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.round(value), max));
}

async function pruneAutomaticBackups(database: DatabaseExecutor): Promise<void> {
  const settings = await getAutomaticBackupSettings(database);
  const result = await database.query<BackupArtifactRow>(
    `SELECT *
       FROM backup_artifacts
      WHERE source = 'server'
        AND manifest->>'automatic' = 'true'
      ORDER BY created_at DESC
      OFFSET $1`,
    [settings.retentionCount],
  );
  for (const row of result.rows) {
    await rm(artifactPath(row.filename), { force: true }).catch(() => undefined);
    await database.query("DELETE FROM backup_artifacts WHERE id = $1", [row.id]).catch(() => undefined);
  }
}

async function appendSyntheticMaintenanceJob(message: string): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `INSERT INTO app_jobs (
       id, kind, status, title, progress, payload, error_message, log_lines,
       attempts, max_attempts, finished_at
     ) VALUES ($1, 'backup.create', 'failed', $2, 100, $3::jsonb, $4, $5::jsonb, 1, 1, now())`,
    [
      randomUUID(),
      "自动备份未执行",
      JSON.stringify({ automatic: true, encrypted: true }),
      message,
      JSON.stringify([message]),
    ],
  );
}

function backupDirectory(): string {
  return process.env.KALENDER_BACKUP_DIR
    ? path.resolve(process.env.KALENDER_BACKUP_DIR)
    : path.join(dataRoot(), "postgres-backups");
}

function artifactPath(filename: string): string {
  return path.join(backupDirectory(), normalizeBackupFilename(filename));
}

function normalizeBackupMailPolicy(value: BackupMailPolicy | string | undefined): BackupMailPolicy {
  return value === "full-archive" || value === "configuration-only" || value === "lightweight"
    ? value
    : "lightweight";
}

export function buildDatabaseDumpArgs(
  mailPolicy: BackupMailPolicy,
  outputPath: string,
  connectionString: string,
): readonly string[] {
  const args = ["--format=custom", "--no-owner", "--no-acl"];
  if (mailPolicy === "lightweight") args.push("--exclude-table-data=mail_message_bodies");
  args.push(`--file=${outputPath}`, connectionString);
  return args;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function normalizeBackupFilename(filename: string): string {
  const name = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "-");
  const modernName = modernizeBackupFilename(name);
  const lowerName = modernName.toLowerCase();
  const supportedExtension = [".backup", ".backup.enc"].some((extension) => lowerName.endsWith(extension));
  if (!name || !supportedExtension) {
    return `${modernName || "backup"}.backup`;
  }
  return modernName;
}

function modernizeBackupFilename(filename: string): string {
  if (filename.toLowerCase().endsWith(".qgwbackup.enc")) {
    return `${filename.slice(0, -".qgwbackup.enc".length)}.backup.enc`;
  }
  if (filename.toLowerCase().endsWith(".qgwbackup")) {
    return `${filename.slice(0, -".qgwbackup".length)}.backup`;
  }
  return filename;
}

async function migrateLegacyBackupFilenames(database: DatabaseExecutor): Promise<void> {
  const result = await database.query<{ readonly id: string; readonly filename: string }>(
    `SELECT id, filename
       FROM backup_artifacts
      WHERE lower(filename) LIKE '%.qgwbackup'
         OR lower(filename) LIKE '%.qgwbackup.enc'`,
  );
  for (const row of result.rows) {
    const filename = modernizeBackupFilename(row.filename);
    const legacyPath = artifactPath(row.filename);
    const modernPath = artifactPath(filename);
    try {
      const [legacyExists, modernExists] = await Promise.all([pathExists(legacyPath), pathExists(modernPath)]);
      if (legacyExists && modernExists) {
        console.warn(`Unable to rename legacy backup because the target already exists: ${filename}`);
        continue;
      }
      if (legacyExists) await rename(legacyPath, modernPath);
      if (legacyExists || modernExists) {
        await database.query(
          "UPDATE backup_artifacts SET filename = $2, file_path = $3 WHERE id = $1",
          [row.id, filename, modernPath],
        );
      }
    } catch (error) {
      console.warn(`Unable to rename legacy backup ${row.filename}`, error);
    }
  }
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new BackupError("缺少 DATABASE_URL", 500);
  return url;
}

async function runCommand(command: string, args: readonly string[]): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new BackupError(`${command} 执行失败：${Buffer.concat(errors).toString("utf8").slice(0, 600)}`, 500));
    });
  });
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function inspectBackupFile(filePath: string, password: string | undefined): Promise<{
  readonly encrypted: boolean;
  readonly manifest: Record<string, unknown>;
}> {
  const workDir = await mkdtemp(path.join(tmpdir(), "qgw-inspect-"));
  try {
    const encrypted = await isEncryptedBackup(filePath);
    const plainPath = encrypted ? path.join(workDir, "decrypted.backup") : filePath;
    if (encrypted) {
      if (!password) return { encrypted: true, manifest: { encrypted: true, inspected: false } };
      await decryptFile(filePath, plainPath, password);
    }
    await runCommand("tar", ["-C", workDir, "-xzf", plainPath, "manifest.json"]);
    const manifest = JSON.parse(await readFile(path.join(workDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    return { encrypted, manifest };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function verifyExtractedBackup(directory: string): Promise<void> {
  for (const file of ["database.dump", "mail-draft-attachments.tgz", "manifest.json", "SHA256SUMS"]) {
    if (!await pathExists(path.join(directory, file))) throw new BackupError(`备份缺少 ${file}`, 400);
  }
  const sums = (await readFile(path.join(directory, "SHA256SUMS"), "utf8")).trim().split(/\n+/);
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) throw new BackupError("备份校验文件格式无效", 400);
    const [, expected, file] = match;
    const actual = await sha256File(path.join(directory, file));
    if (actual !== expected) throw new BackupError(`备份校验失败：${file}`, 400);
  }
}

async function encryptFile(input: string, output: string, password: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(password, salt, 32) as Buffer;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const tempOutput = `${output}.tmp`;
  await pipeline(createReadStream(input), cipher, createWriteStream(tempOutput, { mode: 0o600 }));
  const tag = cipher.getAuthTag();
  const header = Buffer.from(`QGWBACKUP-ENC-v1\n${JSON.stringify({
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
  })}\n`, "utf8");
  const body = await readFile(tempOutput);
  await writeFile(output, Buffer.concat([header, body]), { mode: 0o600 });
  await rm(tempOutput, { force: true });
}

async function decryptFile(input: string, output: string, password: string): Promise<void> {
  const bytes = await readFile(input);
  const firstBreak = bytes.indexOf(10);
  if (firstBreak < 0 || bytes.subarray(0, firstBreak).toString("utf8") !== "QGWBACKUP-ENC-v1") {
    throw new BackupError("加密备份格式无效", 400);
  }
  const secondBreak = bytes.indexOf(10, firstBreak + 1);
  if (secondBreak < 0) throw new BackupError("加密备份头无效", 400);
  const header = JSON.parse(bytes.subarray(firstBreak + 1, secondBreak).toString("utf8")) as {
    readonly salt?: string;
    readonly iv?: string;
    readonly tag?: string;
  };
  if (!header.salt || !header.iv || !header.tag) throw new BackupError("加密备份头缺少字段", 400);
  const key = await scrypt(password, Buffer.from(header.salt, "base64url"), 32) as Buffer;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(header.tag, "base64url"));
  await pipeline(
    ReadableFromBuffer(bytes.subarray(secondBreak + 1)),
    decipher,
    createWriteStream(output, { mode: 0o600 }),
  );
}

async function isEncryptedBackup(filePath: string): Promise<boolean> {
  const header = await readFile(filePath, { encoding: "utf8" }).catch(() => "");
  return fileLooksEncrypted(header);
}

function fileLooksEncrypted(header: string): boolean {
  return header.startsWith("QGWBACKUP-ENC-v1\n");
}

function ReadableFromBuffer(buffer: Buffer): NodeJS.ReadableStream {
  return Readable.from(buffer);
}

function objectCounts(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) output[key] = Number(count);
  return output;
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

async function latestAutomaticBackupTime(database: DatabaseExecutor): Promise<string | undefined> {
  const result = await database.query<{ created_at: string }>(
    `SELECT created_at
       FROM backup_artifacts
      WHERE source = 'server'
        AND manifest->>'automatic' = 'true'
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  return result.rows[0]?.created_at;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
