import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDatabaseDumpArgs,
  estimateLightweightBackupBytes,
  exportPortableCredentialBundle,
  normalizeBackupFilename,
  parsePortableCredentialBundle,
  restorePortableCredentialBundle,
  sha256File,
} from "./backup-service";
import { decryptCredential, encryptCredential, resetCredentialKeyCache } from "./credential-crypto";
import type { DatabaseExecutor, DatabaseQueryResult } from "./database";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const lightweight = buildDatabaseDumpArgs("lightweight", "/tmp/light.dump", "postgresql://example");
assert(
  lightweight.includes("--exclude-table-data=mail_message_bodies"),
  "lightweight backups exclude disposable mail body rows",
);
assert(
  lightweight.includes("--exclude-table-data=app_login_credentials"),
  "backups never include Dayline usernames or password hashes",
);
assert(
  lightweight.includes("--exclude-table-data=app_login_attempts")
    && lightweight.includes("--exclude-table-data=app_invitations"),
  "backups exclude login history and invitation secrets",
);
assert(lightweight.includes("--file=/tmp/light.dump"), "lightweight backups write to the requested output");

const fullArchive = buildDatabaseDumpArgs("full-archive", "/tmp/full.dump", "postgresql://example");
assert(
  !fullArchive.includes("--exclude-table-data=mail_message_bodies"),
  "full and safety backups retain cached mail bodies",
);
assert(
  fullArchive.includes("--exclude-table-data=app_login_credentials"),
  "all backup policies exclude Dayline login credentials",
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

async function testPortableCredentials(): Promise<void> {
  const originalKey = process.env.KALENDER_MASTER_KEY;
  const sourceKey = Buffer.alloc(32, 5).toString("base64");
  const targetKey = Buffer.alloc(32, 6).toString("base64");
  const accountId = "portable-mail-account";
  const sourceCredential = { password: "source-secret" };
  let restoredPayload = "";

  const database: DatabaseExecutor = {
    async query<T>(query: string, params?: readonly unknown[]): Promise<DatabaseQueryResult<T>> {
      if (query.includes("FROM encrypted_credentials")) {
        return { rows: [{ key: accountId, encrypted_payload: await encryptCredential(accountId, sourceCredential) }] as T[] };
      }
      if (query.trimStart().startsWith("SELECT")) return { rows: [] };
      if (query.includes("UPDATE encrypted_credentials")) {
        restoredPayload = String(params?.[1] ?? "");
        return { rows: [], affectedRows: 1 };
      }
      return { rows: [], affectedRows: 0 };
    },
    async exec() {
      return undefined;
    },
  };

  try {
    process.env.KALENDER_MASTER_KEY = sourceKey;
    resetCredentialKeyCache();
    const bundle = await exportPortableCredentialBundle(database);
    assert(bundle.entries.length === 1, "encrypted backups export portable credentials");
    assert(bundle.entries[0]?.value && typeof bundle.entries[0].value === "object", "portable credential values are decrypted");
    assert(parsePortableCredentialBundle(JSON.parse(JSON.stringify(bundle))).entries.length === 1, "portable credential bundle validates");

    process.env.KALENDER_MASTER_KEY = targetKey;
    resetCredentialKeyCache();
    assert(await restorePortableCredentialBundle(database, bundle) === 1, "portable credentials are restored");
    const restored = await decryptCredential<{ readonly password: string }>(accountId, restoredPayload);
    assert(restored.password === sourceCredential.password, "restored credentials use the target master key");
  } finally {
    if (originalKey === undefined) delete process.env.KALENDER_MASTER_KEY;
    else process.env.KALENDER_MASTER_KEY = originalKey;
    resetCredentialKeyCache();
  }
}

Promise.all([testFileHash(), testPortableCredentials()])
  .then(() => console.log("Backup service tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
