import { closeDatabaseForRestore, getSchemaMigrationStatus } from "./database";

try {
  const status = await getSchemaMigrationStatus();
  console.log(`Database schema: v${status.currentVersion} / v${status.latestVersion}`);
  if (status.pendingVersions.length > 0) {
    console.log(`Pending migrations: ${status.pendingVersions.join(", ")}`);
  } else {
    console.log("Pending migrations: none");
  }
  for (const migration of status.applied) {
    console.log(
      `v${migration.version} ${migration.name} · ${migration.appliedAt} · ${migration.executionMs} ms`,
    );
  }
} finally {
  await closeDatabaseForRestore();
}
