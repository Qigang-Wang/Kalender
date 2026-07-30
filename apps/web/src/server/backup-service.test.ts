import { buildDatabaseDumpArgs } from "./backup-service";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const lightweight = buildDatabaseDumpArgs("lightweight", "/tmp/light.dump", "postgresql://example");
assert(
  lightweight.includes("--exclude-table-data=mail_message_bodies"),
  "lightweight backups exclude disposable mail body rows",
);
assert(lightweight.includes("--file=/tmp/light.dump"), "lightweight backups write to the requested output");

const fullArchive = buildDatabaseDumpArgs("full-archive", "/tmp/full.dump", "postgresql://example");
assert(
  !fullArchive.includes("--exclude-table-data=mail_message_bodies"),
  "full and safety backups retain cached mail bodies",
);

console.log("Backup service tests passed");
