import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";

import {
  DatabaseMigrationError,
  getDatabaseMigrationStatus,
  runDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationContext,
} from "./database-migrations";
import {
  closeDatabaseForRestore,
  DATABASE_MIGRATIONS,
  getDatabase,
  getSchemaMigrationStatus,
  LATEST_DATABASE_SCHEMA_VERSION,
  type DatabaseExecutor,
  type DatabaseQueryResult,
} from "./database";

const { Pool } = pg;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  loadLocalEnvFile();
  await withTemporaryDatabase(verifyAtomicMigrations);
  await withTemporaryDatabase(verifyLegacyUpgrade);
  await withTemporaryDatabase(verifyApplicationDatabaseStartup);
  await withTemporaryDatabase(verifyRealtimeNotifications);
  console.log("Database migration tests passed");
}

function loadLocalEnvFile(): void {
  let content: string;
  try {
    content = readFileSync(".env", "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

async function verifyAtomicMigrations(database: TestPostgresDatabase) {
  await database.exec(`
    CREATE TABLE important_records (id integer PRIMARY KEY, value text NOT NULL);
    INSERT INTO important_records (id, value) VALUES (1, 'preserve-me');
  `);
  let beforeContext: DatabaseMigrationContext | undefined;
  const failingMigrations = [
    {
      version: 1,
      name: "add-migration-marker",
      sql: "ALTER TABLE important_records ADD COLUMN migrated boolean NOT NULL DEFAULT false",
    },
    {
      version: 2,
      name: "simulate-failure",
      sql: "INSERT INTO table_that_does_not_exist (id) VALUES (1)",
    },
  ] as const satisfies readonly DatabaseMigration[];
  let failure: unknown;
  try {
    await runDatabaseMigrations(database, failingMigrations, {
      beforeMigrate: async (context) => {
        beforeContext = context;
      },
    });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof DatabaseMigrationError && failure.version === 2, "a failed migration reports its exact version");
  assert(beforeContext?.hadExistingSchema && beforeContext.currentVersion === 0, "legacy schemas are identified before migration");
  const preserved = await database.query<{ value: string }>("SELECT value FROM important_records WHERE id = 1");
  assert(preserved.rows[0]?.value === "preserve-me", "failed migration preserves existing data");
  const migratedColumn = await database.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'important_records' AND column_name = 'migrated'`,
  );
  assert(migratedColumn.rows[0]?.count === 0, "all schema changes roll back when a later migration fails");
  const recordedAfterFailure = await database.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM schema_migrations",
  );
  assert(recordedAfterFailure.rows[0]?.count === 0, "failed migration records roll back with schema changes");

  const validMigrations = [
    failingMigrations[0],
    {
      version: 2,
      name: "store-upgrade-marker",
      sql: "UPDATE important_records SET migrated = true WHERE id = 1",
    },
  ] as const satisfies readonly DatabaseMigration[];
  let recoveryFailure: unknown;
  try {
    await runDatabaseMigrations(database, validMigrations, {
      beforeMigrate: async () => {
        throw new Error("backup failed");
      },
    });
  } catch (error) {
    recoveryFailure = error;
  }
  assert(
    recoveryFailure instanceof DatabaseMigrationError && recoveryFailure.version === 1,
    "a before-migrate failure stops before the first pending migration",
  );
  const columnAfterRecoveryFailure = await database.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'important_records' AND column_name = 'migrated'`,
  );
  assert(columnAfterRecoveryFailure.rows[0]?.count === 0, "before-migrate failure leaves the schema unchanged");

  const applied = await runDatabaseMigrations(database, validMigrations);
  assert(applied.currentVersion === 2 && applied.pendingVersions.length === 0, "valid migrations advance to the latest version");
  const upgraded = await database.query<{ migrated: boolean }>("SELECT migrated FROM important_records WHERE id = 1");
  assert(upgraded.rows[0]?.migrated, "successful migrations preserve and upgrade existing data");

  const appliedAgain = await runDatabaseMigrations(database, validMigrations);
  assert(appliedAgain.applied.length === 2, "re-running migrations is idempotent");
  const status = await getDatabaseMigrationStatus(database, validMigrations);
  assert(status.currentVersion === 2 && status.pendingVersions.length === 0, "migration status reports an up-to-date database");

  let checksumFailure: unknown;
  try {
    await runDatabaseMigrations(database, [
      { ...validMigrations[0], sql: `${validMigrations[0].sql}; SELECT 1` },
      validMigrations[1],
    ]);
  } catch (error) {
    checksumFailure = error;
  }
  assert(
    checksumFailure instanceof DatabaseMigrationError && checksumFailure.version === 1,
    "editing an already-applied migration is rejected",
  );
  await database.query("DELETE FROM schema_migrations WHERE version = 1");
  let gapFailure: unknown;
  try {
    await getDatabaseMigrationStatus(database, validMigrations);
  } catch (error) {
    gapFailure = error;
  }
  assert(
    gapFailure instanceof DatabaseMigrationError && gapFailure.version === 2,
    "a gap in recorded migration history is rejected",
  );
}

async function verifyLegacyUpgrade(database: TestPostgresDatabase) {
  await database.exec(DATABASE_MIGRATIONS[0].sql);
  await database.exec(`
    INSERT INTO projects (id, name, area_name, color, status)
    VALUES ('legacy-project', 'Legacy Research', 'Research', '#86bdf5', 'active');
    INSERT INTO tasks (id, title, project_name)
    VALUES ('legacy-task', 'Recover project relation', ' legacy research ');
    INSERT INTO accounts (
      id, provider_id, display_name, email_address, last_tested_at
    ) VALUES (
      'legacy-account', 'imap', 'Legacy Mail', 'legacy@example.test', now()
    );
    INSERT INTO mail_threads (
      id, account_id, provider_thread_id, subject, snippet, last_message_at
    ) VALUES (
      'legacy-thread', 'legacy-account', 'provider-thread', 'Cached message', 'Cached preview', now()
    );
    INSERT INTO mail_messages (
      id, account_id, thread_id, provider_message_id, provider_uid,
      provider_folder_id, subject, from_address, sent_at, received_at,
      snippet, text_body, html_body, body_loaded_at, body_cache_version
    ) VALUES (
      'legacy-message', 'legacy-account', 'legacy-thread', 'provider-message', 1,
      'INBOX', 'Cached message', '{"address":"sender@example.test"}'::jsonb, now(), now(),
      'Cached preview', 'Cached text', '<p>Cached HTML</p>', now(), 3
    );
  `);

  const status = await runDatabaseMigrations(database, DATABASE_MIGRATIONS);
  assert(
    status.currentVersion === LATEST_DATABASE_SCHEMA_VERSION && status.pendingVersions.length === 0,
    "an unversioned legacy database upgrades to the latest schema",
  );
  const migrationRows = await database.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM schema_migrations",
  );
  assert(migrationRows.rows[0]?.count === DATABASE_MIGRATIONS.length, "every applied migration is recorded");
  const linkedTask = await database.query<{ project_id: string | null; project_name: string | null; area_name: string | null }>(
    "SELECT project_id, project_name, area_name FROM tasks WHERE id = 'legacy-task'",
  );
  assert(linkedTask.rows[0]?.project_id === "legacy-project", "project migration links matching legacy task labels");
  assert(
    linkedTask.rows[0]?.project_name === "Legacy Research" && linkedTask.rows[0]?.area_name === "Research",
    "project migration canonicalizes task project metadata",
  );
  const projectTaskLink = await database.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM entity_links
      WHERE source_kind = 'project' AND source_id = 'legacy-project'
        AND target_kind = 'task' AND target_id = 'legacy-task'
        AND relation = 'project-item'`,
  );
  assert(projectTaskLink.rows[0]?.count === 1, "project migration backfills shared EntityLink membership");
  const migratedBody = await database.query<{
    text_body: string | null;
    html_body: string | null;
    cache_version: number;
  }>(
    "SELECT text_body, html_body, cache_version FROM mail_message_bodies WHERE message_id = 'legacy-message'",
  );
  assert(
    migratedBody.rows[0]?.text_body === "Cached text"
      && migratedBody.rows[0]?.html_body === "<p>Cached HTML</p>"
      && migratedBody.rows[0]?.cache_version === 3,
    "mail body migration preserves cached content in the dedicated cache table",
  );
  const legacyBodyColumns = await database.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mail_messages'
        AND column_name IN ('text_body', 'html_body', 'body_loaded_at', 'body_cache_version')`,
  );
  assert(legacyBodyColumns.rows[0]?.count === 0, "mail metadata no longer stores disposable body cache columns");
}

async function verifyApplicationDatabaseStartup(database: TestPostgresDatabase, databaseUrl: string) {
  process.env.DATABASE_URL = databaseUrl;
  await closeDatabaseForRestore().catch(() => undefined);
  const appDatabase = await getDatabase();
  assert(!appDatabase.closed, "application database starts with DATABASE_URL");
  const status = await getSchemaMigrationStatus();
  assert(
    status.currentVersion === LATEST_DATABASE_SCHEMA_VERSION && status.pendingVersions.length === 0,
    "application startup applies all migrations",
  );
  const tables = await database.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM information_schema.tables
      WHERE table_schema = 'public'`,
  );
  assert((tables.rows[0]?.count ?? 0) > 0, "application startup creates PostgreSQL tables");
  await closeDatabaseForRestore();
}

async function verifyRealtimeNotifications(database: TestPostgresDatabase, databaseUrl: string) {
  await runDatabaseMigrations(database, DATABASE_MIGRATIONS);
  const listener = new pg.Client({ connectionString: databaseUrl });
  const notifications: string[] = [];
  listener.on("notification", (notification) => {
    if (notification.channel === "kalender_realtime" && notification.payload) {
      notifications.push(notification.payload);
    }
  });
  await listener.connect();
  await listener.query("LISTEN kalender_realtime");
  try {
    await database.query(`
      INSERT INTO sync_settings (id, updated_at)
      VALUES ('workspace', now())
      ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at
    `);
    await waitFor(() => notifications.some((payload) => {
      const event = JSON.parse(payload) as {
        readonly topic?: string;
        readonly action?: string;
        readonly entityType?: string;
        readonly entityId?: string;
      };
      return event.topic === "settings"
        && event.entityType === "sync_settings"
        && event.entityId === "workspace"
        && (event.action === "insert" || event.action === "update");
    }));

    await database.query(
      `INSERT INTO app_jobs (id, kind, status, title, progress)
       VALUES ($1, 'maintenance', 'running', 'Realtime test', 42)`,
      ["realtime-job"],
    );
    await waitFor(() => notifications.some((payload) => {
      const event = JSON.parse(payload) as {
        readonly topic?: string;
        readonly entityType?: string;
        readonly entityId?: string;
        readonly status?: string;
        readonly progress?: number;
      };
      return event.topic === "job"
        && event.entityType === "app_jobs"
        && event.entityId === "realtime-job"
        && event.status === "running"
        && event.progress === 42;
    }));
  } finally {
    await listener.end();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PostgreSQL realtime notification");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withTemporaryDatabase(
  callback: (database: TestPostgresDatabase, databaseUrl: string) => Promise<void>,
): Promise<void> {
  const templateUrl = process.env.DATABASE_URL?.trim();
  if (!templateUrl) throw new Error("DATABASE_URL is required for PostgreSQL migration tests");
  const databaseName = `kalender_test_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = databaseUrlWithName(templateUrl, "postgres");
  const databaseUrl = databaseUrlWithName(templateUrl, databaseName);
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  await admin.end();
  const database = new TestPostgresDatabase(databaseUrl);
  try {
    await callback(database, databaseUrl);
  } finally {
    await database.close().catch(() => undefined);
    await closeDatabaseForRestore().catch(() => undefined);
    const cleanup = new Pool({ connectionString: adminUrl });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
}

function databaseUrlWithName(value: string, databaseName: string): string {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

class TestPostgresDatabase implements DatabaseExecutor {
  readonly #pool: pg.Pool;
  #closed = false;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async query<T>(query: string, params: readonly unknown[] = []): Promise<DatabaseQueryResult<T>> {
    const result = await this.#pool.query(query, [...params]);
    return { rows: result.rows as T[], affectedRows: result.rowCount ?? undefined };
  }

  async exec(query: string): Promise<unknown> {
    return this.#pool.query(query);
  }

  async transaction<T>(callback: (transaction: DatabaseExecutor) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new TestPostgresTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }
}

class TestPostgresTransaction implements DatabaseExecutor {
  constructor(private readonly client: pg.PoolClient) {}

  async query<T>(query: string, params: readonly unknown[] = []): Promise<DatabaseQueryResult<T>> {
    const result = await this.client.query(query, [...params]);
    return { rows: result.rows as T[], affectedRows: result.rowCount ?? undefined };
  }

  async exec(query: string): Promise<unknown> {
    return this.client.query(query);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
