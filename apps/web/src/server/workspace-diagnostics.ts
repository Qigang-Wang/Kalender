import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AuthError, assignLegacyWorkspaceData, recordAuditEvent, type AppUser, type AppUserRole } from "./auth";
import { dataRoot, getDatabase, getSchemaMigrationStatus, type DatabaseExecutor } from "./database";
import { getWorkspaceBackupStatus } from "./backup-service";
import { getJobSummary } from "./job-service";

export interface UserWorkspaceDiagnostic {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: AppUserRole;
  readonly disabledAt?: string;
  readonly counts: Readonly<Record<string, number>>;
}

export interface WorkspaceIsolationDiagnostic {
  readonly users: readonly UserWorkspaceDiagnostic[];
  readonly unownedCounts: Readonly<Record<string, number>>;
  readonly totalUnowned: number;
}

export interface WorkspaceOperationsDiagnostic {
  readonly database: {
    readonly connected: boolean;
    readonly currentVersion: number;
    readonly latestVersion: number;
    readonly pendingVersions: readonly number[];
  };
  readonly dataDirectory: {
    readonly path: string;
    readonly writable: boolean;
  };
  readonly masterKey: {
    readonly configured: boolean;
  };
  readonly environment: {
    readonly backupPasswordConfigured: boolean;
    readonly healthcheckTokenConfigured: boolean;
    readonly aiAutoExecutionEnabled: boolean;
  };
  readonly storage: {
    readonly layout: readonly StoragePathDiagnostic[];
    readonly dockerRecommendation: readonly string[];
  };
  readonly jobs: Awaited<ReturnType<typeof getJobSummary>>;
  readonly recentErrors: readonly OperationsErrorDiagnostic[];
  readonly backup: Awaited<ReturnType<typeof getWorkspaceBackupStatus>>;
}

export interface StoragePathDiagnostic {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly exists: boolean;
  readonly writable: boolean;
  readonly bytes: number;
  readonly files: number;
}

export interface OperationsErrorDiagnostic {
  readonly id: string;
  readonly source: "job" | "audit";
  readonly title: string;
  readonly message: string;
  readonly createdAt: string;
}

const rootTables = [
  "accounts",
  "calendar_accounts",
  "exchange_connections",
  "calendars",
  "projects",
  "notes",
  "tasks",
  "entity_links",
  "mail_drafts",
  "mail_signatures",
  "ai_providers",
  "ai_conversations",
  "ai_feature_bindings",
] as const;

const joinedCounts = [
  {
    key: "mail_messages",
    sql: `SELECT a.user_id, count(*)::int AS count
            FROM mail_messages m
            JOIN accounts a ON a.id = m.account_id
           GROUP BY a.user_id`,
  },
  {
    key: "calendar_events",
    sql: `SELECT c.user_id, count(*)::int AS count
            FROM calendar_events e
            JOIN calendars c ON c.id = e.calendar_id
           GROUP BY c.user_id`,
  },
  {
    key: "ai_messages",
    sql: `SELECT c.user_id, count(*)::int AS count
            FROM ai_messages m
            JOIN ai_conversations c ON c.id = m.conversation_id
           GROUP BY c.user_id`,
  },
  {
    key: "mail_draft_attachments",
    sql: `SELECT d.user_id, count(*)::int AS count
            FROM mail_draft_attachments a
            JOIN mail_drafts d ON d.id = a.draft_id
           GROUP BY d.user_id`,
  },
] as const;

interface UserRow {
  readonly id: string;
  readonly display_name: string;
  readonly email: string;
  readonly role: AppUserRole;
  readonly disabled_at: string | null;
}

interface CountRow {
  readonly user_id: string | null;
  readonly count: number | string;
}

export async function getWorkspaceIsolationDiagnostic(actor: AppUser): Promise<WorkspaceIsolationDiagnostic> {
  requireAdmin(actor);
  const database = await getDatabase();
  const users = await database.query<UserRow>(
    `SELECT id, display_name, email, role, disabled_at
       FROM app_users
      ORDER BY disabled_at NULLS FIRST, created_at, email`,
  );
  const userCounts = new Map<string, Record<string, number>>();
  const unownedCounts: Record<string, number> = {};
  for (const user of users.rows) userCounts.set(user.id, {});

  for (const table of rootTables) {
    const result = await database.query<CountRow>(
      `SELECT user_id, count(*)::int AS count FROM ${table} GROUP BY user_id`,
    );
    applyCounts(table, result.rows, userCounts, unownedCounts);
  }

  for (const definition of joinedCounts) {
    const result = await database.query<CountRow>(definition.sql);
    applyCounts(definition.key, result.rows, userCounts, unownedCounts);
  }

  const totalUnowned = Object.values(unownedCounts).reduce((total, count) => total + count, 0);
  return {
    users: users.rows.map((user) => ({
      userId: user.id,
      displayName: user.display_name,
      email: user.email,
      role: user.role,
      disabledAt: user.disabled_at ?? undefined,
      counts: userCounts.get(user.id) ?? {},
    })),
    unownedCounts,
    totalUnowned,
  };
}

export async function getWorkspaceOperationsDiagnostic(actor: AppUser): Promise<WorkspaceOperationsDiagnostic> {
  requireAdmin(actor);
  const root = dataRoot();
  const [migrationStatus, jobs, backup, writable, recentErrors] = await Promise.all([
    getSchemaMigrationStatus(),
    getJobSummary(),
    getWorkspaceBackupStatus(),
    isWritableDirectory(root),
    readRecentOperationsErrors(),
  ]);
  const storageLayout = await readStorageLayout(root, backup.strategy.backupDirectory, backup.strategy.attachmentDirectory);
  return {
    database: {
      connected: true,
      currentVersion: migrationStatus.currentVersion,
      latestVersion: migrationStatus.latestVersion,
      pendingVersions: migrationStatus.pendingVersions,
    },
    dataDirectory: {
      path: root,
      writable,
    },
    masterKey: {
      configured: Boolean(process.env.KALENDER_MASTER_KEY),
    },
    environment: {
      backupPasswordConfigured: Boolean(process.env.KALENDER_BACKUP_PASSWORD),
      healthcheckTokenConfigured: Boolean(process.env.KALENDER_HEALTHCHECK_TOKEN),
      aiAutoExecutionEnabled: process.env.KALENDER_AI_AUTO_EXECUTION === "true",
    },
    storage: {
      layout: storageLayout,
      dockerRecommendation: [
        "postgres-data：只给 PostgreSQL 使用，保存 /var/lib/postgresql。",
        "kalender-files：保存 /app/.data 中的草稿附件和应用本地文件。",
        "kalender-backups：生产环境建议从 /app/.data 拆出来，单独挂载到 KALENDER_BACKUP_DIR。",
        "logs 可先不单独建卷；当前应用日志走容器 stdout，交给 Docker 或宿主管理。",
      ],
    },
    jobs,
    recentErrors,
    backup,
  };
}

export async function assignUnownedWorkspaceData(actor: AppUser, targetUserId: string): Promise<WorkspaceIsolationDiagnostic> {
  requireAdmin(actor);
  if (!targetUserId.trim()) throw new AuthError("请选择目标用户", 400);
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    await ensureTargetUser(transaction, targetUserId);
    await assignLegacyWorkspaceData(transaction, targetUserId);
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    targetUserId,
    action: "workspace.assign-unowned",
    metadata: {},
  }, database);
  return getWorkspaceIsolationDiagnostic(actor);
}

function applyCounts(
  key: string,
  rows: readonly CountRow[],
  userCounts: Map<string, Record<string, number>>,
  unownedCounts: Record<string, number>,
): void {
  for (const row of rows) {
    const count = Number(row.count);
    if (!row.user_id) {
      if (count > 0) unownedCounts[key] = count;
      continue;
    }
    const counts = userCounts.get(row.user_id);
    if (counts) counts[key] = count;
  }
}

async function ensureTargetUser(database: DatabaseExecutor, userId: string): Promise<void> {
  const result = await database.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM app_users WHERE id = $1 AND disabled_at IS NULL) AS exists`,
    [userId],
  );
  if (!result.rows[0]?.exists) throw new AuthError("目标用户不存在或已禁用", 404);
}

function requireAdmin(actor: AppUser): void {
  if (actor.role !== "admin") throw new AuthError("需要管理员权限", 403);
}

async function isWritableDirectory(directory: string): Promise<boolean> {
  const probe = path.join(directory, `.write-test-${Date.now()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "ok", { flag: "wx" });
    await access(probe);
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function readRecentOperationsErrors(): Promise<readonly OperationsErrorDiagnostic[]> {
  const database = await getDatabase();
  const result = await database.query<{
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly error_message: string | null;
    readonly updated_at: string;
  }>(
    `SELECT id, kind, title, error_message, updated_at
       FROM app_jobs
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 6`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    source: "job" as const,
    title: `${row.title} · ${row.kind}`,
    message: row.error_message ?? "任务失败，但没有记录详细错误",
    createdAt: row.updated_at,
  }));
}

async function readStorageLayout(
  root: string,
  backupDirectory: string,
  attachmentDirectory: string,
): Promise<readonly StoragePathDiagnostic[]> {
  const items = [
    { id: "data", label: "应用数据", path: root },
    { id: "attachments", label: "草稿附件", path: attachmentDirectory },
    { id: "backups", label: "备份文件", path: backupDirectory },
  ];
  return Promise.all(items.map(async (item) => {
    const exists = await pathExists(item.path);
    const writable = await isWritableDirectory(item.path);
    const size = exists ? await directorySize(item.path) : { bytes: 0, files: 0 };
    return { ...item, exists, writable, ...size };
  }));
}

async function directorySize(directory: string): Promise<{ readonly bytes: number; readonly files: number }> {
  let bytes = 0;
  let files = 0;
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) {
        const metadata = await stat(next).catch(() => undefined);
        if (!metadata) continue;
        bytes += metadata.size;
        files += 1;
      }
    }
  };
  await visit(directory);
  return { bytes, files };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
