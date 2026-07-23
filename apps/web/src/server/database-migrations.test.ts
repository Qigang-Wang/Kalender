import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

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
} from "./database";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  await verifyAtomicMigrations();
  await verifyLegacyUpgradeRecoveryPoint();
  console.log("Database migration tests passed");
}

async function verifyAtomicMigrations() {
  const root = path.join(tmpdir(), `kalender-migration-runner-test-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const database = await PGlite.create(path.join(root, "postgres"));
  try {
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
        WHERE table_name = 'important_records' AND column_name = 'migrated'`,
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
          throw new Error("disk full");
        },
      });
    } catch (error) {
      recoveryFailure = error;
    }
    assert(
      recoveryFailure instanceof DatabaseMigrationError && recoveryFailure.version === 1,
      "a recovery-point failure stops before the first pending migration",
    );
    const columnAfterRecoveryFailure = await database.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM information_schema.columns
        WHERE table_name = 'important_records' AND column_name = 'migrated'`,
    );
    assert(columnAfterRecoveryFailure.rows[0]?.count === 0, "recovery-point failure leaves the schema unchanged");

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
  } finally {
    if (!database.closed) await database.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyLegacyUpgradeRecoveryPoint() {
  const root = path.join(tmpdir(), `kalender-legacy-upgrade-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = root;
  await mkdir(root, { recursive: true });
  const seed = await PGlite.create(path.join(root, "postgres"));
  try {
    await seed.exec(DATABASE_MIGRATIONS[0].sql);
  } finally {
    await seed.close();
  }

  try {
    const database = await getDatabase();
    const status = await getSchemaMigrationStatus();
    assert(
      status.currentVersion === LATEST_DATABASE_SCHEMA_VERSION && status.pendingVersions.length === 0,
      "an unversioned legacy database upgrades to the latest schema",
    );
    const migrationRows = await database.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM schema_migrations",
    );
    assert(migrationRows.rows[0]?.count === DATABASE_MIGRATIONS.length, "every applied migration is recorded");
    const deepAuditColumns = await database.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM information_schema.columns
        WHERE table_name = 'sync_cursors'
          AND column_name IN ('reconcile_before_uid', 'last_deep_reconcile_at')`,
    );
    assert(deepAuditColumns.rows[0]?.count === 2, "later migrations add the newest sync schema");

    const recoveryFiles = await readdir(path.join(root, "automatic-backups"));
    const archive = recoveryFiles.find((name) => name.endsWith(".tgz"));
    const manifestName = recoveryFiles.find((name) => name.endsWith(".json"));
    assert(Boolean(archive && manifestName), "legacy upgrades create a database recovery archive and manifest");
    const manifest = JSON.parse(
      await readFile(path.join(root, "automatic-backups", manifestName!), "utf8"),
    ) as {
      readonly fromVersion?: number;
      readonly toVersion?: number;
      readonly databaseArchive?: string;
    };
    assert(manifest.fromVersion === 0, "unversioned databases record version zero as the recovery source");
    assert(manifest.toVersion === LATEST_DATABASE_SCHEMA_VERSION, "recovery manifest records the target schema");
    assert(manifest.databaseArchive === archive, "recovery manifest points to the matching database archive");

    await closeDatabaseForRestore();
    await getDatabase();
    const recoveryFilesAfterRestart = await readdir(path.join(root, "automatic-backups"));
    assert(
      recoveryFilesAfterRestart.length === recoveryFiles.length,
      "an up-to-date restart does not create redundant recovery points",
    );
  } finally {
    await closeDatabaseForRestore().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
