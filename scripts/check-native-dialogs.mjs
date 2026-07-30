import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve("apps/web/src");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const nativeDialogPattern = /(?<![\w.])(alert|confirm|prompt)\s*\(|\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(/g;
const violations = [];

async function scanDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(filePath);
      return;
    }
    if (!sourceExtensions.has(path.extname(entry.name)) || /\.(?:test|spec)\.[^.]+$/.test(entry.name)) return;
    const source = await readFile(filePath, "utf8");
    for (const match of source.matchAll(nativeDialogPattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${path.relative(process.cwd(), filePath)}:${line} ${match[0].trim()}`);
    }
  }));
}

await scanDirectory(sourceRoot);

if (violations.length) {
  console.error("检测到浏览器原生弹窗，请改用 appConfirm、appPrompt 或 appAlert：");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log("UI 弹窗检查通过：未发现浏览器原生弹窗。");
}
