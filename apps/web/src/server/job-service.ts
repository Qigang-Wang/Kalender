import { randomUUID } from "node:crypto";

import { getDatabase, type DatabaseExecutor } from "./database";
import type { AppUser } from "./auth";

export type AppJobKind = "backup.create" | "backup.restore" | "mail.sync" | "calendar.sync" | "ai.action" | "maintenance";
export type AppJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AppJob {
  readonly id: string;
  readonly kind: AppJobKind;
  readonly status: AppJobStatus;
  readonly userId?: string;
  readonly title: string;
  readonly progress: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
  readonly errorMessage?: string;
  readonly logLines: readonly string[];
  readonly idempotencyKey?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAfter: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class JobError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "JobError";
  }
}

interface JobRow {
  readonly id: string;
  readonly kind: AppJobKind;
  readonly status: AppJobStatus;
  readonly user_id: string | null;
  readonly title: string;
  readonly progress: number;
  readonly payload: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly error_message: string | null;
  readonly log_lines: string[] | unknown;
  readonly idempotency_key: string | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly run_after: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

declare global {
  var qgwJobRunnerTimer: ReturnType<typeof setInterval> | undefined;
  var qgwJobRunnerActive: boolean | undefined;
  var qgwJobSecrets: Map<string, string> | undefined;
}

const MAX_LOG_LINES = 120;

export async function enqueueJob(input: {
  readonly kind: AppJobKind;
  readonly title: string;
  readonly actor?: AppUser;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
  readonly deferStart?: boolean;
}): Promise<AppJob> {
  const database = await getDatabase();
  const id = randomUUID();
  const payload = JSON.stringify(input.payload ?? {});
  const result = await database.query<JobRow>(
    `INSERT INTO app_jobs (id, kind, user_id, title, payload, idempotency_key, max_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET updated_at = app_jobs.updated_at
     RETURNING *`,
    [
      id,
      input.kind,
      input.actor?.id ?? null,
      normalizeTitle(input.title),
      payload,
      normalizeIdempotencyKey(input.idempotencyKey),
      Math.max(1, Math.min(input.maxAttempts ?? 1, 5)),
    ],
  );
  if (!input.deferStart) {
    ensureJobRunner();
    void drainJobQueue();
  }
  return mapJob(result.rows[0]!);
}

export async function listJobs(actor: AppUser, options: {
  readonly status?: AppJobStatus;
  readonly kind?: AppJobKind;
  readonly limit?: number;
} = {}): Promise<readonly AppJob[]> {
  const database = await getDatabase();
  const params: unknown[] = [];
  const filters: string[] = [];
  if (actor.role !== "admin") {
    params.push(actor.id);
    filters.push(`user_id = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    filters.push(`status = $${params.length}`);
  }
  if (options.kind) {
    params.push(options.kind);
    filters.push(`kind = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(options.limit ?? 50, 100)));
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await database.query<JobRow>(
    `SELECT * FROM app_jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapJob);
}

export async function getJob(actor: AppUser, jobId: string): Promise<AppJob> {
  const database = await getDatabase();
  const result = await database.query<JobRow>(
    `SELECT * FROM app_jobs WHERE id = $1${actor.role === "admin" ? "" : " AND user_id = $2"} LIMIT 1`,
    actor.role === "admin" ? [jobId] : [jobId, actor.id],
  );
  const job = result.rows[0];
  if (!job) throw new JobError("任务不存在", 404);
  return mapJob(job);
}

export async function cancelJob(actor: AppUser, jobId: string): Promise<AppJob> {
  const job = await getJob(actor, jobId);
  if (job.status !== "queued") throw new JobError("只能取消尚未开始的任务", 409);
  const database = await getDatabase();
  const result = await database.query<JobRow>(
    `UPDATE app_jobs
        SET status = 'cancelled', progress = 100, finished_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [job.id],
  );
  return mapJob(result.rows[0]!);
}

export async function retryJob(actor: AppUser, jobId: string): Promise<AppJob> {
  const job = await getJob(actor, jobId);
  if (job.status !== "failed" && job.status !== "cancelled") throw new JobError("只能重试失败或已取消任务", 409);
  const database = await getDatabase();
  const result = await database.query<JobRow>(
    `UPDATE app_jobs
        SET status = 'queued', progress = 0, error_message = NULL, started_at = NULL, finished_at = NULL,
            run_after = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [job.id],
  );
  ensureJobRunner();
  void drainJobQueue();
  return mapJob(result.rows[0]!);
}

export async function getJobSummary(): Promise<{
  readonly queued: number;
  readonly running: number;
  readonly failed: number;
  readonly latest?: AppJob;
}> {
  const database = await getDatabase();
  const counts = await database.query<{ status: AppJobStatus; count: number | string }>(
    `SELECT status, count(*) AS count
       FROM app_jobs
      WHERE status IN ('queued', 'running', 'failed')
      GROUP BY status`,
  );
  const latest = await database.query<JobRow>("SELECT * FROM app_jobs ORDER BY created_at DESC LIMIT 1");
  return {
    queued: countStatus(counts.rows, "queued"),
    running: countStatus(counts.rows, "running"),
    failed: countStatus(counts.rows, "failed"),
    latest: latest.rows[0] ? mapJob(latest.rows[0]) : undefined,
  };
}

export function setJobSecret(jobId: string, secret: string): void {
  const secrets = globalThis.qgwJobSecrets ??= new Map();
  secrets.set(jobId, secret);
}

export function consumeJobSecret(jobId: string): string | undefined {
  const secret = globalThis.qgwJobSecrets?.get(jobId);
  globalThis.qgwJobSecrets?.delete(jobId);
  return secret;
}

export function ensureJobRunner(): void {
  if (globalThis.qgwJobRunnerTimer) return;
  const interval = Math.max(1_000, Number(process.env.KALENDER_JOB_POLL_INTERVAL_MS ?? 5_000));
  const timer = setInterval(() => void drainJobQueue(), interval);
  timer.unref();
  globalThis.qgwJobRunnerTimer = timer;
}

export async function drainJobQueue(limit = 3): Promise<void> {
  if (globalThis.qgwJobRunnerActive) return;
  globalThis.qgwJobRunnerActive = true;
  try {
    await scheduleDueJobs();
    for (let index = 0; index < limit; index += 1) {
      const job = await claimNextJob();
      if (!job) break;
      await runClaimedJob(job);
    }
  } finally {
    globalThis.qgwJobRunnerActive = false;
  }
}

async function scheduleDueJobs(): Promise<void> {
  try {
    const { scheduleDueAutomaticBackup } = await import("./backup-service");
    await scheduleDueAutomaticBackup();
  } catch (error) {
    console.error("Automatic job scheduling failed", error);
  }
}

export async function appendJobLog(jobId: string, line: string, databaseInput?: DatabaseExecutor): Promise<void> {
  const database = databaseInput ?? await getDatabase();
  await database.query(
    `UPDATE app_jobs
        SET log_lines = (
              SELECT jsonb_agg(value)
                FROM (
                  SELECT value
                    FROM jsonb_array_elements_text(log_lines || to_jsonb($2::text)) WITH ORDINALITY AS entries(value, ord)
                   ORDER BY ord DESC
                   LIMIT $3
                ) trimmed
            ),
            updated_at = now()
      WHERE id = $1`,
    [jobId, sanitizeLogLine(line), MAX_LOG_LINES],
  );
}

export async function updateJobProgress(jobId: string, progress: number, databaseInput?: DatabaseExecutor): Promise<void> {
  const database = databaseInput ?? await getDatabase();
  await database.query(
    `UPDATE app_jobs SET progress = $2, updated_at = now() WHERE id = $1`,
    [jobId, Math.max(0, Math.min(Math.round(progress), 100))],
  );
}

async function claimNextJob(): Promise<AppJob | undefined> {
  const database = await getDatabase();
  const result = await database.query<JobRow>(
    `UPDATE app_jobs
        SET status = 'running', attempts = attempts + 1, started_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM app_jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
  );
  return result.rows[0] ? mapJob(result.rows[0]) : undefined;
}

async function runClaimedJob(job: AppJob): Promise<void> {
  try {
    await appendJobLog(job.id, `任务开始：${job.title}`);
    const result = await executeJob(job);
    await finishJob(job.id, "succeeded", result);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "任务执行失败";
    await appendJobLog(job.id, message).catch(() => undefined);
    if (job.attempts < job.maxAttempts) {
      const database = await getDatabase();
      await database.query(
        `UPDATE app_jobs
            SET status = 'queued', error_message = $2, run_after = now() + ($3 || ' seconds')::interval,
                updated_at = now()
          WHERE id = $1`,
        [job.id, message, Math.min(300, 15 * 2 ** Math.max(job.attempts - 1, 0))],
      );
    } else {
      await finishJob(job.id, "failed", {}, message);
    }
  }
}

async function executeJob(job: AppJob): Promise<Readonly<Record<string, unknown>>> {
  if (job.kind === "backup.create") {
    const { runBackupCreateJob } = await import("./backup-service");
    return runBackupCreateJob(job);
  }
  if (job.kind === "backup.restore") {
    const { runBackupRestoreJob } = await import("./backup-service");
    return runBackupRestoreJob(job);
  }
  if (job.kind === "mail.sync") {
    const { runMailSync } = await import("./mail-sync");
    const accountId = stringPayload(job.payload.accountId);
    if (!accountId) throw new JobError("缺少邮箱账户");
    await runMailSync(accountId, 100);
    return { accountId };
  }
  if (job.kind === "ai.action") {
    const { runAiActionJob } = await import("./ai-workspace-actions");
    return runAiActionJob(job);
  }
  if (job.kind === "maintenance") {
    const { cleanupMailBodyCache } = await import("./mail-repository");
    await cleanupMailBodyCache();
    return { maintenance: "mail-body-cache" };
  }
  await appendJobLog(job.id, "该任务类型尚未接入执行器");
  return {};
}

async function finishJob(
  jobId: string,
  status: "succeeded" | "failed",
  result: Readonly<Record<string, unknown>>,
  errorMessage?: string,
): Promise<void> {
  const database = await getDatabase();
  await database.query(
    `UPDATE app_jobs
        SET status = $2, progress = 100, result = $3::jsonb, error_message = $4,
            finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [jobId, status, JSON.stringify(result), errorMessage ?? null],
  );
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 160) throw new JobError("任务标题无效");
  return title;
}

function normalizeIdempotencyKey(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(trimmed)) throw new JobError("幂等键格式无效");
  return trimmed;
}

function mapJob(row: JobRow): AppJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    userId: row.user_id ?? undefined,
    title: row.title,
    progress: Number(row.progress),
    payload: row.payload ?? {},
    result: row.result ?? {},
    errorMessage: row.error_message ?? undefined,
    logLines: Array.isArray(row.log_lines) ? row.log_lines.filter((line): line is string => typeof line === "string") : [],
    idempotencyKey: row.idempotency_key ?? undefined,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAfter: row.run_after,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function countStatus(rows: readonly { readonly status: AppJobStatus; readonly count: number | string }[], status: AppJobStatus): number {
  return Number(rows.find((row) => row.status === status)?.count ?? 0);
}

function sanitizeLogLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 800);
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
