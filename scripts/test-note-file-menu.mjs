// Run against an isolated server with KALENDER_DATA_DIR=/tmp/kalender-file-menu-test-<id>:
// NOTES_TEST_URL=http://127.0.0.1:3112 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-note-file-menu.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseURL = process.env.NOTES_TEST_URL;
assert(baseURL && new URL(baseURL).hostname === '127.0.0.1' && new URL(baseURL).port !== '3000', 'use an isolated local test server');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ baseURL, viewport: { width: 1180, height: 1080 } });
  const credentials = { username: 'file-menu-test', password: 'file-menu-test-password' };
  const setup = await context.request.post('/api/auth/setup', { data: { ...credentials, displayName: 'File menu test', confirmPassword: credentials.password } });
  if (!setup.ok()) assert((await context.request.post('/api/auth/login', { data: credentials })).ok(), 'test account login');
  const bytes = Buffer.from('%PDF-1.4\nfile menu download test\n%%EOF');
  const upload = await context.request.post('/api/editor-assets', {
    multipart: { file: { name: '测试附件.pdf', mimeType: 'application/pdf', buffer: bytes } },
  });
  assert(upload.ok(), 'test file uploads');
  const { file } = await upload.json();
  const content = 'plate-json-v1:' + JSON.stringify([
    { type: 'p', children: [{ text: 'Keep this paragraph' }] },
    { type: 'file', name: file.name, url: file.url, children: [{ text: '' }] },
    { type: 'file', name: 'Other file.pdf', url: file.url, children: [{ text: '' }] },
    { type: 'p', children: [{ text: '' }] },
  ]);
  const created = await context.request.post('/api/notes', { data: { title: 'File menu test', content } });
  assert(created.ok(), 'test note is created');
  const { note } = await created.json();
  const page = await context.newPage();
  await page.goto(`/notes?note=${note.id}`);
  const attachment = page.getByRole('button', { name: file.name, exact: true });
  await attachment.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '文件操作' });
  await menu.waitFor();
  assert.equal(await page.getByRole('menu').count(), 1, 'file menu replaces the generic block menu');
  const downloadReady = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: '下载', exact: true }).click();
  const download = await downloadReady;
  assert.equal(download.suggestedFilename(), file.name);
  assert((await readFile(await download.path())).equals(bytes), 'download preserves file bytes');
  await attachment.click({ button: 'right' });
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await attachment.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '从笔记移除', exact: true }).click();
  await attachment.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Other file.pdf', exact: true }).count(), 1, 'only the targeted file is removed');
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.press('Control+z');
  await attachment.waitFor();
  await editor.getByText('Keep this paragraph', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).waitFor();
  assert.equal(await menu.count(), 0, 'text keeps the generic block menu');
  console.log('File menu: download bytes/name, Escape, targeted removal, undo, and ordinary text menu passed.');
} finally {
  await browser.close();
}
