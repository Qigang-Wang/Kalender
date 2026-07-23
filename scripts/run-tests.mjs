import { spawn } from "node:child_process";
import os from "node:os";

const testScripts = [
  "test:core",
  "test:storage",
  "test:database-migrations",
  "test:imap-sync-state",
  "test:ai-provider",
  "test:ai-chat",
  "test:mail-ai",
  "test:mail-body",
  "test:mail-drafts",
  "test:mail-reply",
  "test:mail-date-groups",
  "test:mail-smime",
  "test:context-commands",
  "test:calendar",
  "test:caldav",
  "test:exchange",
  "test:exchange-mail",
  "test:ics",
  "test:tasks",
  "test:notes",
  "test:links",
  "test:today",
  "test:search",
  "test:http-client",
];

const requestedConcurrency = Number(process.env.KALENDER_TEST_CONCURRENCY);
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? Math.min(requestedConcurrency, 8)
  : Math.min(4, Math.max(2, os.availableParallelism()));
let nextIndex = 0;
let failed = false;

console.log(`Running ${testScripts.length} test groups with concurrency ${concurrency}`);

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (!failed) {
    const index = nextIndex;
    nextIndex += 1;
    const script = testScripts[index];
    if (!script) return;
    const exitCode = await runScript(script);
    if (exitCode !== 0) {
      failed = true;
      process.exitCode = exitCode;
      return;
    }
  }
}));

if (!failed) console.log(`All ${testScripts.length} test groups passed`);

function runScript(script) {
  console.log(`[start] ${script}`);
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(windows ? process.env.ComSpec ?? "cmd.exe" : "npm", windows
      ? ["/d", "/s", "/c", `npm run ${script}`]
      : ["run", script], {
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`[failed] ${script} terminated by ${signal}`);
        resolve(1);
        return;
      }
      const exitCode = code ?? 1;
      console.log(`[${exitCode === 0 ? "passed" : "failed"}] ${script}`);
      resolve(exitCode);
    });
  });
}
