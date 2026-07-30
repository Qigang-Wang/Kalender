import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildDatabaseDumpArgs, estimateLightweightBackupBytes, normalizeBackupFilename, sha256File } from "./backup-service";

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

assert(
  estimateLightweightBackupBytes(12 * 1024 * 1024, 512 * 1024) === 12.5 * 1024 * 1024,
  "lightweight backup estimate includes core database tables and draft attachments",
);
assert(
  estimateLightweightBackupBytes(-1, 1024) === 1024,
  "lightweight backup estimate ignores invalid negative sizes",
);
assert(normalizeBackupFilename("workspace.backup") === "workspace.backup", "new backup extension is preserved");
assert(normalizeBackupFilename("workspace.backup.enc") === "workspace.backup.enc", "encrypted backup extension is preserved");
assert(normalizeBackupFilename("workspace.qgwbackup") === "workspace.backup", "legacy backup extension is migrated");
assert(normalizeBackupFilename("workspace.qgwbackup.enc") === "workspace.backup.enc", "legacy encrypted extension is migrated");
assert(normalizeBackupFilename("workspace") === "workspace.backup", "missing backup extension uses .backup");

async function testFileHash(): Promise<void> {
  const hashDirectory = await mkdtemp(path.join(tmpdir(), "qgw-backup-hash-test-"));
  try {
    const hashInput = path.join(hashDirectory, "input.txt");
    await writeFile(hashInput, "hello");
    assert(
      await sha256File(hashInput) === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "backup hashing consumes the file stream and returns its SHA-256 digest",
    );
  } finally {
    await rm(hashDirectory, { recursive: true, force: true });
  }
}

testFileHash()
  .then(() => console.log("Backup service tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
