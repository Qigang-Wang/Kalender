import { createHash } from "node:crypto";

import type { DatabaseExecutor } from "./database";

interface MigrationDatabase extends DatabaseExecutor {
  transaction<T>(callback: (transaction: DatabaseExecutor) => Promise<T>): Promise<T>;
}

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedDatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
  readonly executionMs: number;
}

export interface DatabaseMigrationStatus {
  readonly currentVersion: number;
  readonly latestVersion: number;
  readonly pendingVersions: readonly number[];
  readonly applied: readonly AppliedDatabaseMigration[];
}

export interface DatabaseMigrationContext {
  readonly currentVersion: number;
  readonly latestVersion: number;
  readonly pending: readonly DatabaseMigration[];
  readonly hadExistingSchema: boolean;
}

export interface RunDatabaseMigrationsOptions {
  readonly beforeMigrate?: (context: DatabaseMigrationContext) => Promise<void>;
  readonly now?: () => number;
}

interface SchemaMigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  execution_ms: number;
}

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL,
    checksum text NOT NULL CHECK (length(checksum) = 64),
    applied_at timestamptz NOT NULL DEFAULT now(),
    execution_ms integer NOT NULL DEFAULT 0 CHECK (execution_ms >= 0)
  )
`;

export class DatabaseMigrationError extends Error {
  constructor(
    message: string,
    readonly version?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DatabaseMigrationError";
  }
}

export async function runDatabaseMigrations(
  database: MigrationDatabase,
  migrations: readonly DatabaseMigration[],
  options: RunDatabaseMigrationsOptions = {},
): Promise<DatabaseMigrationStatus> {
  validateDefinitions(migrations);
  const hadExistingSchema = await hasExistingWorkspaceSchema(database);
  await database.exec(MIGRATION_TABLE_SQL);
  const appliedBefore = await readAppliedMigrations(database);
  validateAppliedMigrations(appliedBefore, migrations);
  const appliedVersions = new Set(appliedBefore.map((migration) => migration.version));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const currentVersion = appliedBefore.at(-1)?.version ?? 0;
  if (pending.length === 0) {
    return toStatus(appliedBefore, latestVersion, []);
  }

  try {
    await options.beforeMigrate?.({
      currentVersion,
      latestVersion,
      pending,
      hadExistingSchema,
    });
  } catch (error) {
    throw new DatabaseMigrationError(
      "无法创建迁移前恢复点，数据库未更改",
      pending[0]?.version,
      { cause: error },
    );
  }

  const now = options.now ?? Date.now;
  let activeMigration: DatabaseMigration | undefined;
  try {
    await database.transaction(async (transaction) => {
      for (const migration of pending) {
        activeMigration = migration;
        const startedAt = now();
        await transaction.exec(migration.sql);
        const executionMs = Math.max(0, Math.round(now() - startedAt));
        await transaction.query(
          `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migrationChecksum(migration), executionMs],
        );
      }
    });
  } catch (error) {
    const detail = activeMigration
      ? `数据库迁移 ${activeMigration.version}（${activeMigration.name}）失败`
      : "数据库迁移失败";
    throw new DatabaseMigrationError(detail, activeMigration?.version, { cause: error });
  }

  return getDatabaseMigrationStatus(database, migrations);
}

export async function getDatabaseMigrationStatus(
  database: DatabaseExecutor,
  migrations: readonly DatabaseMigration[],
): Promise<DatabaseMigrationStatus> {
  validateDefinitions(migrations);
  const tableExists = await hasMigrationTable(database);
  const applied = tableExists ? await readAppliedMigrations(database) : [];
  validateAppliedMigrations(applied, migrations);
  const appliedVersions = new Set(applied.map((migration) => migration.version));
  return toStatus(
    applied,
    migrations.at(-1)?.version ?? 0,
    migrations.filter((migration) => !appliedVersions.has(migration.version)).map((migration) => migration.version),
  );
}

export function migrationChecksum(migration: DatabaseMigration): string {
  return createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${normalizeSql(migration.sql)}`)
    .digest("hex");
}

async function hasExistingWorkspaceSchema(database: DatabaseExecutor): Promise<boolean> {
  const result = await database.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
      LIMIT 1`,
  );
  return result.rows.length > 0;
}

async function hasMigrationTable(database: DatabaseExecutor): Promise<boolean> {
  const result = await database.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'
     ) AS exists`,
  );
  return Boolean(result.rows[0]?.exists);
}

async function readAppliedMigrations(database: DatabaseExecutor): Promise<AppliedDatabaseMigration[]> {
  const result = await database.query<SchemaMigrationRow>(
    `SELECT version, name, checksum, applied_at, execution_ms
       FROM schema_migrations
      ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    executionMs: row.execution_ms,
  }));
}

function validateDefinitions(migrations: readonly DatabaseMigration[]): void {
  let previousVersion = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new DatabaseMigrationError("数据库迁移版本必须是严格递增的正整数", migration.version);
    }
    if (!migration.name.trim()) {
      throw new DatabaseMigrationError(`数据库迁移 ${migration.version} 缺少名称`, migration.version);
    }
    if (!migration.sql.trim()) {
      throw new DatabaseMigrationError(`数据库迁移 ${migration.version} 缺少 SQL`, migration.version);
    }
    previousVersion = migration.version;
  }
}

function validateAppliedMigrations(
  applied: readonly AppliedDatabaseMigration[],
  migrations: readonly DatabaseMigration[],
): void {
  const definitions = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const [index, recorded] of applied.entries()) {
    const definition = definitions.get(recorded.version);
    if (!definition) {
      throw new DatabaseMigrationError(
        `数据库版本 ${recorded.version} 高于当前应用支持范围，请使用更新版本的应用`,
        recorded.version,
      );
    }
    if (migrations[index]?.version !== recorded.version) {
      throw new DatabaseMigrationError(
        `数据库迁移历史在版本 ${recorded.version} 前存在缺口，已停止启动以保护数据`,
        recorded.version,
      );
    }
    if (recorded.name !== definition.name || recorded.checksum !== migrationChecksum(definition)) {
      throw new DatabaseMigrationError(
        `数据库迁移 ${recorded.version} 的定义已变化，已停止启动以保护数据`,
        recorded.version,
      );
    }
  }
}

function toStatus(
  applied: readonly AppliedDatabaseMigration[],
  latestVersion: number,
  pendingVersions: readonly number[],
): DatabaseMigrationStatus {
  return {
    currentVersion: applied.at(-1)?.version ?? 0,
    latestVersion,
    pendingVersions,
    applied,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n").trim();
}
