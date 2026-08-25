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
  if (actor.role !== "admin") throw new BackupError("Administrator-Rechte erfordern", 403);
  if (input.enabled && input.encryptAutomatic && !process.env.KALENDER_BACKUP_PASSWORD) {
    throw new BackupError("Automatische Verschlüsselungssicherung erfordert die Konfiguration von KALENDER_BANKUP_PASSWORD", 400);
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
  if (!latest) throw new BackupError("Es steht kein Backup zum Download zur Verfügung. Bitte erstellen Sie zuerst ein Backup", 404);
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
  if (actor.role !== "admin") throw new BackupError("Administrator-Rechte erfordern", 403);
  if (input.encrypted && !input.password) throw new BackupError("Verschlüsselungssicherung erfordert Backup-Passwörter");
  const mailPolicy = normalizeBackupMailPolicy(input.mailPolicy);
  if (mailPolicy !== "lightweight") {
    throw new BackupError(
      mailPolicy === "configuration-only"
        ? "nur Konfigurationssicherung erfordert eine unabhängige Prozesswiederherstellung und die aktuelle Version ist nicht für die Erstellung geöffnet"
        : "Das vollständige Postfach-Archiv muss durch den vollständigen Mail-Körper und Anhang Vorab-Capturing unterstützt werden. Die aktuelle Version ist nicht offen für die Erstellung",
      400,
    );
  }
  const job = await enqueueJob({
    kind: "backup.create",
    actor,
    title: input.encrypted ? "Erstellen Sie eine verschlüsselte Light Workspace-Backup" : "Erstellen eines leichten Workspace-Backups",
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
  if (actor.role !== "admin") throw new BackupError("Administrator-Rechte erfordern", 403);
  const artifact = await getBackupArtifact(input.artifactId);
  if (!artifact) throw new BackupError("Sicherung existiert nicht", 404);
  if (artifact.encrypted && !input.password) throw new BackupError("Backup-Passwort erforderlich, um Verschlüsselungssicherung wiederherzustellen");
  const job = await enqueueJob({
    kind: "backup.restore",
    actor,
    title: `Sicherung wiederherstellen ${artifact.filename}`,
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
  if (actor.role !== "admin") throw new BackupError("Administrator-Rechte erfordern", 403);
  const database = await getDatabase();
  const result = await database.query<BackupArtifactRow>("SELECT * FROM backup_artifacts WHERE id = $1 LIMIT 1", [id]);
  const row = result.rows[0];
  if (!row) throw new BackupError("Sicherung existiert nicht", 404);
  const restoreJobs = await database.query<{ readonly id: string }>(
    `SELECT id
       FROM app_jobs
      WHERE kind = 'backup.restore'
        AND status IN ('queued', 'running')
        AND payload->>'artifactId' = $1
      LIMIT 1`,
    [id],
  );
  if (restoreJobs.rows[0]) throw new BackupError("das Backup wird wiederhergestellt und kann vorerst nicht gelöscht werden", 409);
  await rm(artifactPath(row.filename), { force: true });
  await database.query("DELETE FROM backup_artifacts WHERE id = $1", [id]);
}

export async function readBackupArtifactFile(id: string): Promise<{ readonly artifact: BackupArtifact; readonly bytes: Buffer }> {
  const artifact = await getBackupArtifact(id);
  if (!artifact) throw new BackupError("Sicherung existiert nicht", 404);
  return { artifact, bytes: await readFile(artifactPath(artifact.filename)) };
}

export async function saveUploadedBackup(
  input: Uint8Array,
  options: { readonly actor?: AppUser; readonly filename: string; readonly transient?: boolean },
): Promise<BackupArtifact> {
  if (input.byteLength > MAX_BACKUP_BYTES) throw new BackupError("Sicherungsdatei darf 512 MB nicht überschreiten", 413);
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
  if (encrypted && !password) throw new BackupError("Verschlüsselungssicherung fehlt Passwort");
  const tools = await readBackupToolStatus();
  if (!tools.pgDump) throw new BackupError("der Server fehlt pg_dump, bitte installieren PostgreSQL Client", 501);
  if (!tools.tar) throw new BackupError("Server fehlt Teer", 501);

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
    await appendJobLog(job.id, "Exportieren von PostgreSQL-Datenbanken");
    await runCommand("pg_dump", buildDatabaseDumpArgs(mailPolicy, databaseDump, databaseUrl()));
    await updateJobProgress(job.id, 35);

    await appendJobLog(job.id, "Anbringung von Verpackungs-Entwürfen");
    const attachmentRoot = path.join(root, "mail-draft-attachments");
    if (await pathExists(attachmentRoot)) {
      await runCommand("tar", ["-C", root, "-czf", attachments, "mail-draft-attachments"]);
    } else {
      await runCommand("tar", ["-czf", attachments, "--files-from", "/dev/null"]);
    }
    await updateJobProgress(job.id, 55);

    let portableCredentialCount = 0;
    if (encrypted) {
      await appendJobLog(job.id, "Erzeugung von migrationsfähigen Verbindungen");
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
    await appendJobLog(job.id, `Backup erstellt:${finalName}`);
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
    if (deferred.affectedRows) await appendSyntheticMaintenanceJob("Auto-verschlüsselte Sicherung erfordert die Konfiguration von KALENDER_BANKUP_PASSWorld; unverschlüsselte automatische Sicherung erfordert kein Passwort");
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
    await appendSyntheticMaintenanceJob("Auto-verschlüsselte Sicherung erfordert die Konfiguration von KALENDER_BANKUP_PASSWorld; unverschlüsselte automatische Sicherung erfordert kein Passwort");
    return undefined;
  }
  const job = await enqueueJob({
    kind: "backup.create",
    title: encrypted ? "automatische Erstellung eines verschlüsselten Workspace-Backups" : "automatisches Workspace-Backup erstellen",
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
  if (!artifact) throw new BackupError("Sicherung existiert nicht", 404);
  if (artifact.encrypted && !password) throw new BackupError("Backup-Passwort erforderlich, um Verschlüsselungssicherung wiederherzustellen");
  const tools = await readBackupToolStatus();
  if (!tools.pgRestore) throw new BackupError("der Server fehlt pg_restore, bitte installieren PostgreSQL Client", 501);
  if (!tools.tar) throw new BackupError("Server fehlt Teer", 501);

  await appendJobLog(job.id, "Erstellen einer sicheren Sicherung vor der Wiederherstellung");
  const safety = await runBackupCreateJob({
    ...job,
    id: `${job.id}-safety`,
    title: "Sichere Sicherung vor der Wiederherstellung",
    payload: { encrypted: false, mailPolicy: "full-archive" },
    kind: "backup.create",
  });
  await updateJobProgress(job.id, 20);
  const workDir = await mkdtemp(path.join(tmpdir(), "qgw-restore-"));
  try {
    await appendJobLog(job.id, "Stoppen Sie die Synchronisierung von Mail und Kalender");
    await Promise.all([stopMailSyncScheduler(), stopCalendarSyncScheduler()]);
    const packagePath = artifactPath(artifact.filename);
    const plainPackage = artifact.encrypted ? path.join(workDir, "decrypted.backup") : packagePath;
    if (artifact.encrypted) await decryptFile(packagePath, plainPackage, password!);
    await runCommand("tar", ["-C", workDir, "-xzf", plainPackage]);
    await verifyExtractedBackup(workDir);
    await updateJobProgress(job.id, 45);

    await appendJobLog(job.id, "Schließen von Datenbankverbindungen und Wiederherstellung von PostgreSQL");
    await closeDatabaseForRestore();
    await runCommand("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", `--dbname=${databaseUrl()}`, path.join(workDir, "database.dump")]);
    await updateJobProgress(job.id, 80);

    await appendJobLog(job.id, "Wiederherstellung des Entwurfs von Anhängen");
    await runCommand("tar", ["-C", dataRoot(), "-xzf", path.join(workDir, "mail-draft-attachments.tgz")]);
    const database = await getDatabase();
    const portableCredentialsFile = path.join(workDir, PORTABLE_CREDENTIALS_FILENAME);
    if (await pathExists(portableCredentialsFile)) {
      if (!artifact.encrypted) throw new BackupError("Migrationsdokumente sind nur im Verschlüsselungs-Backup erlaubt", 400);
      await appendJobLog(job.id, "Verschlüsselung von Verbindungsdateien mit dem aktuellen Server-Hauptschlüssel");
      const portableCredentials = parsePortableCredentialBundle(
        JSON.parse(await readFile(portableCredentialsFile, "utf8")) as unknown,
      );
      const restoredCredentialCount = await restorePortableCredentialBundle(database, portableCredentials);
      await appendJobLog(job.id, `migriert ${restoredCredentialCount} Unterstützung für die Verbindung`);
    } else {
      await appendJobLog(job.id, "das Backup enthält keine abnehmbaren Dokumente; die Kontoverbindung kann noch den ursprünglichen Primärschlüssel oder das Passwort für den Wiedereintritt erfordern");
    }
    await database.query("UPDATE backup_artifacts SET restored_at = now() WHERE id = $1", [artifact.id]).catch(() => undefined);
    await appendJobLog(job.id, "Abschluss wieder aufnehmen");
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
    if (!store) throw new BackupError("Abnehmbare Dokumente enthalten unbekannte Speichertypen", 400);
    const encryptedPayload = await encryptCredential(entry.key, entry.value);
    const result = await database.query(
      `UPDATE ${store.table}
          SET encrypted_payload = $2, key_version = 1, updated_at = now()
        WHERE ${store.keyColumn} = $1`,
      [entry.key, encryptedPayload],
    );
    if (result.affectedRows !== 1) throw new BackupError(`Temporärer Ordner kann nicht geschlossen werden: %s${entry.store}/${entry.key}`, 400);
    restored += 1;
  }
  return restored;
}

export function parsePortableCredentialBundle(value: unknown): PortableCredentialBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BackupError("kann in ungültiges Zertifikatsformat migriert werden", 400);
  const input = value as { readonly version?: unknown; readonly entries?: unknown };
  if (input.version !== 1 || !Array.isArray(input.entries)) throw new BackupError("Migration Dokument Version ungültig", 400);
  const validStores = new Set<string>(PORTABLE_CREDENTIAL_STORES.map((store) => store.id));
  const entries = input.entries.map((entry): PortableCredentialEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new BackupError("Deaktivieren von gültigen Zertifikatseinträgen", 400);
    const candidate = entry as { readonly store?: unknown; readonly key?: unknown; readonly value?: unknown };
    if (typeof candidate.store !== "string" || !validStores.has(candidate.store)) throw new BackupError("Ungültiger Repository-Typ Abnehmbar", 400);
    if (typeof candidate.key !== "string" || !candidate.key.trim()) throw new BackupError("Ermöglichte Migration von ungültigen Zertifikat-Identifikatoren", 400);
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
      label: "PostgreSQL-Datenbank",
      description: "enthält Benutzer, Mailbox/Kalenderverbindungen, E-Mail-Indizes, Projekte, Notizen, Aufgaben, KI-Konfiguration, Audit-Datensätze und Synchronisierung.",
      included: true,
    },
    {
      id: "draft-attachments",
      label: "Entwurfs-Mail-Anhänger",
      description: "enthält lokal gespeicherte Draft-Anhängedateien; diese Bytes befinden sich nicht in PostgreSQL.",
      included: true,
    },
    {
      id: "mail-bodies",
      label: "E-Mail-Körper-Cache",
      description: `${mailCache.cachedBodies}/${mailCache.totalMessages} Versiegelung,${formatBytes(mailCache.cachedBodyBytes)} Der Body-Cache gibt kein Licht-Backup ein; Re-Downloads nach Bedarf beim Überprüfen von E-Mails, wenn wiederhergestellt.`,
      included: false,
    },
    {
      id: "mail-archive",
      label: "vollständiges Postfach-Archiv",
      description: "laden Sie nicht aktiv alle Texte und Anhänge in das Remote-Postfach herunter; synchronisieren Sie weiter über IMAP/Exchange nach der Wiederherstellung.",
      included: false,
    },
    {
      id: "master-key",
      label: "Unterstützung der Migration",
      description: "Verschlüsselungs-Backup verwendet Backup-Passwörter zum Schutz von Postfächern, Kalendern und AI-Dokumenten; der ursprüngliche Server-Hauptschlüssel ist für die Wiederherstellung nicht erforderlich.",
      included: true,
    },
  ];
  const configurationCoverage: readonly BackupCoverageItem[] = [
    {
      id: "configuration",
      label: "Konto- und Systemkonfiguration",
      description: "Die Konfigurationsmigration ist für Kontoverbindungen, KI-Anbieter, Benutzerpräferenzen und Automatisierungsstrategien geplant.",
      included: true,
    },
    {
      id: "workspace-data",
      label: "Unternehmensdaten",
      description: "enthält keine E-Mail, Kalenderereignisse, Aufgaben, Projekte und Notizen und vermeidet die Erfassung routinemäßiger Aufgabendaten.",
      included: false,
    },
    {
      id: "local-files",
      label: "lokale Anhängedatei",
      description: "enthält keine Entwürfe von Anhängen oder Mail-Anhangdateien.",
      included: false,
    },
    {
      id: "master-key",
      label: "Unterstützung der Migration",
      description: "Verschlüsselungssicherung ermöglicht nur die sichere Migration von Verbindungsdokumenten.",
      included: false,
    },
  ];
  const fullArchiveCoverage: readonly BackupCoverageItem[] = [
    {
      id: "database",
      label: "PostgreSQL-Datenbank",
      description: "enthält Workspace-Daten, synchronisierte Indizes und Mail-Text, der in die Datenbank gecached wurde.",
      included: true,
    },
    {
      id: "draft-attachments",
      label: "Entwurfs-Mail-Anhänger",
      description: "enthält lokal gespeicherte Draft-Anhängedateien.",
      included: true,
    },
    {
      id: "mail-bodies",
      label: "Alle E-Mail Body Caches",
      description: `${mailCache.cachedBodies}/${mailCache.totalMessages}Eine E-Mail hat einen lokalen Text-Cache; ein komplettes Archiv muss mit dem fehlenden Text abgeschlossen werden.`,
      included: mailCache.totalMessages > 0 && mailCache.cachedBodies === mailCache.totalMessages,
    },
    {
      id: "remote-attachments",
      label: "Remote-Mail-Anhänger",
      description: "Der aktuelle Anhang wird vom Mailserver nach Bedarf immer noch gelesen, und es gibt keinen vollständigen Vor-Retrieval- und lokalen Archivierungsprozess.",
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
        label: "leichter Arbeitsraum-Snapshot",
        description: "UI-Text: Derzeit empfohlen. Backup Workspace-Daten, Mail-Indizes und Entwurf von Anhängen, ohne Backup von Text-Caches, die vom Mail-Server abgerufen werden können.",
        recommended: true,
        available: true,
        coverage: lightweightCoverage,
      },
      {
        policy: "configuration-only",
        label: "Nur Migration konfigurieren",
        description: "verwendet, um Kontoverbindungen, AI-Einstellungen und Benutzereinstellungen zu migrieren und keine Routinearbeitsdaten mitzuführen.",
        recommended: false,
        available: false,
        disabledReason: "Spezialisierte Teile sind erforderlich, um den Prozess wiederherzustellen und zu vermeiden, bestehende Aufgaben, Notizen und Kalenderereignisse abzudecken.",
        coverage: configurationCoverage,
      },
      {
        policy: "full-archive",
        label: "lokales Mail-Archiv komplettieren",
        description: "Ziel ist es, alle synchronisierten Mail-Texte und Anhänge in das Backup zu integrieren und ist für die langfristige Offline-Konservierung geeignet.",
        recommended: false,
        available: false,
        disabledReason: mailCache.totalMessages === 0
          ? "Derzeit ist keine synchronisierte E-Mail verfügbar; das vollständige Archiv kann erst nach dem Öffnen der Mailbox ausgewertet werden."
          : "Es fehlt auch an Vollmailtext und Remote-Anhänger-Vorab-Capturing-Prozess, und das komplette Archiv kann zu diesem Zeitpunkt nicht garantiert werden.",
        coverage: fullArchiveCoverage,
      },
    ],
    backupCommands: [
      {
        id: "prepare",
        title: "Erstellung des Backup-Verzeichnisses",
        description: "Für jedes Backup wird ein eigenständiges Zeitstempelverzeichnis verwendet, um die Aufbewahrung und den Rollback zu erleichtern.",
        command: `BACKUP_ROOT=${quotedBackupBase}\nBACKUP_DIR="$BACKUP_ROOT/kalender-$(date +%Y%m%d-%H%M%S)"\nmkdir -p "$BACKUP_DIR"`,
      },
      {
        id: "database",
        title: "PostgreSQL exportieren",
        description: "verwendet das PostgreSQLcustom-Format und überspringt den Haupt-Mail-Cache, der erneut heruntergeladen werden kann.",
        command: `pg_dump --format=custom --no-owner --no-acl --exclude-table-data=mail_message_bodies --file="$BACKUP_DIR/database.dump" "$DATABASE_URL"`,
      },
      {
        id: "attachments",
        title: "Anhang-Paketentwurf",
        description: "Das Anhängeverzeichnis erzeugt auch einen leeren Ort, wenn es nicht existiert und stellt das Skript wieder her, um die Einheitlichkeit zu erhalten.",
        command: `[ -d ${quotedAttachmentDirectory} ] && tar -C ${quotedRoot} -czf "$BACKUP_DIR/mail-draft-attachments.tgz" mail-draft-attachments || tar -czf "$BACKUP_DIR/mail-draft-attachments.tgz" --files-from /dev/null`,
      },
      {
        id: "manifest",
        title: "Anweisungen zur Erstellung von Backup-Anweisungen",
        description: "die Zeit der Erstellung des Datensatzes und der Schlüsselanforderungen; der wahre Schlüssel wird im Passwort-Manager platziert.",
        command: `printf 'created_at=%s\\nrequires_KALENDER_MASTER_KEY=true\\nmail_policy=lightweight\\n' "$(date -Iseconds)" > "$BACKUP_DIR/manifest.txt"\nsha256sum "$BACKUP_DIR/database.dump" "$BACKUP_DIR/mail-draft-attachments.tgz" > "$BACKUP_DIR/SHA256SUMS"`,
      },
    ],
    restoreCommands: [
      {
        id: "verify",
        title: "Sicherungsdateien validieren",
        description: "Bestätigung, dass das Dokument vor der Restaurierung intakt ist.",
        command: `cd "$BACKUP_DIR"\nsha256sum -c SHA256SUMS`,
      },
      {
        id: "database",
        title: "PostgreSQL wiederherstellen",
        description: "Das Objekt, das bereits in der Zielbibliothek existiert, wird gelöscht; das Ziel DATABASE_URL wird zuerst identifiziert und zeigt auf die richtige Datenbank.",
        command: `pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DATABASE_URL" "$BACKUP_DIR/database.dump"`,
      },
      {
        id: "attachments",
        title: "Entwurf von Anhängen wiederherzustellen",
        description: "Entfernen von Anhängen aus KARENDER_DATA_DIR; es wird empfohlen, vorhandene Verzeichnisse vor der Wiederherstellung zu sichern.",
        command: `mkdir -p ${quotedRoot}\ntar -C ${quotedRoot} -xzf "$BACKUP_DIR/mail-draft-attachments.tgz"`,
      },
    ],
    warnings: [
      "Schreiben Sie das vollständige DATABASE_URL- oder Datenbankpasswort nicht in das Back-up-Paket.",
      "Die Verschlüsselungssicherung ermöglicht die Migration von Postfächern, Kalendern und AI-Dokumenten mit Back-up-Passwörtern, ohne dass dies vom ursprünglichen Server aus für KARENDER_MASTER_KEY erforderlich ist.",
      "Das unverschlüsselte Backup enthält keine abnehmbaren Dokumente; die Sicherung des Servers erfordert den ursprünglichen Primärschlüssel oder stellt die Verbindung neu ein.",
      "Die Standard-Mail-Richtlinie erfasst nicht proaktiv alle historischen Anhänge zum Remote-Postfach und erfordert eine Neusynchronisierung des Postfachs nach der Wiederherstellung.",
      "Application Schreiben und E-Mail-Synchronisation sollte vor der Wiederherstellung eingestellt werden, um zu vermeiden, neue Daten während der Wiederherstellung zu generieren.",
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
      "automatische Sicherung nicht implementiert",
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
  if (!url) throw new BackupError("Fehlende DADABASE_URL", 500);
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
      else reject(new BackupError(`${command} Ausführung fehlgeschlagen:${Buffer.concat(errors).toString("utf8").slice(0, 600)}`, 500));
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
    if (!await pathExists(path.join(directory, file))) throw new BackupError(`Sicherung fehlt ${file}`, 400);
  }
  const sums = (await readFile(path.join(directory, "SHA256SUMS"), "utf8")).trim().split(/\n+/);
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) throw new BackupError("Sicherungs-Check-Dateiformat ist ungültig", 400);
    const [, expected, file] = match;
    const actual = await sha256File(path.join(directory, file));
    if (actual !== expected) throw new BackupError(`Sicherungsüberprüfung fehlgeschlagen:${file}`, 400);
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
    throw new BackupError("Ungültiges Verschlüsselungs-Backup-Format", 400);
  }
  const secondBreak = bytes.indexOf(10, firstBreak + 1);
  if (secondBreak < 0) throw new BackupError("Ungültige Verschlüsselungs-Backup-Header", 400);
  const header = JSON.parse(bytes.subarray(firstBreak + 1, secondBreak).toString("utf8")) as {
    readonly salt?: string;
    readonly iv?: string;
    readonly tag?: string;
  };
  if (!header.salt || !header.iv || !header.tag) throw new BackupError("Verschlüsselungs-Backup-Header fehlt Feld", 400);
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
