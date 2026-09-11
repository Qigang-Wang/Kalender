// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-desktop-reminder-window.mjs
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const reminderUrl = new URL("../src-tauri/desktop-dist/reminder.html", import.meta.url).href;
try {
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 420, height: 440 }, colorScheme });
    await page.clock.install({ time: new Date("2026-09-11T12:20:00Z") });
    await page.addInitScript(() => {
      window.calls = [];
      window.failSnooze = false;
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        window.calls.push([command, args]);
        if (command === "snooze_reminder" && window.failSnooze) throw new Error("稍后提醒失败");
      } } };
      window.__KALENDER_REMINDERS__ = [{ id: "event-1", title: "项目进度讨论", startAt: Date.parse("2026-09-11T12:30:00Z"), location: "会议室 A", route: "/calendar", canSnooze: true }];
    });
    await page.goto(reminderUrl);
    assert.equal(await page.locator("#title").innerText(), "项目进度讨论");
    assert.equal(await page.locator("#countdown").innerText(), "10 分钟后开始");
    assert.equal(await page.locator("#location").isVisible(), true);
    await page.clock.fastForward(120000);
    assert.equal(await page.locator("#countdown").innerText(), "8 分钟后开始");
    assert.equal(await page.evaluate(() => window.calls.some(([cmd]) => cmd === "close_reminder")), false);
    // Duplicate deliveries are ignored. Opening one item must leave the rest queued.
    await page.evaluate(() => {
      const second = { id: "event-2", title: "这是一条很长的日程标题，用于验证两行截断及地点缺失时不会溢出窗口", startAt: Date.parse("2026-09-12T12:30:00Z"), route: "/calendar?event=2", canSnooze: true };
      window.dispatchEvent(new CustomEvent("kalender:reminders", { detail: [window.__KALENDER_REMINDERS__[0], second, second] }));
    });
    assert.equal(await page.locator("#queue-count").innerText(), "另有 1 项提醒");
    await page.locator("#open").click();
    assert.match(await page.locator("#title").innerText(), /很长的日程标题/);
    assert.equal(await page.locator("#location").isVisible(), false);
    assert.equal(await page.evaluate(() => window.calls.some(([cmd]) => cmd === "close_reminder")), false);
    await page.evaluate(() => { window.failSnooze = true; });
    await page.locator("#snooze").click();
    assert.match(await page.locator("#error").innerText(), /稍后提醒失败/);
    assert.match(await page.locator("#title").innerText(), /很长的日程标题/);
    await page.evaluate(() => { window.failSnooze = false; });
    await page.locator("#snooze").click();
    assert.equal(await page.evaluate(() => window.calls.filter(([cmd]) => cmd === "close_reminder").length), 1);
    // Reuse the hidden page for a compact test notification, with no calendar navigation.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("kalender:reminders", { detail: [{ id: "kalender-test-notification", startAt: Date.now(), title: "test", message: "桌面提醒已正常连接。", canSnooze: false }] })));
    assert.equal(await page.locator("#title").innerText(), "测试通知已送达");
    assert.equal(await page.locator("#open").innerText(), "知道了");
    assert.equal(await page.locator("#snooze").isVisible(), false);
    assert.equal(await page.locator("#clock").isVisible(), false);
    assert.equal(await page.locator("#countdown").isVisible(), false);
    await page.clock.fastForward(3600000);
    assert.equal(await page.evaluate(() => window.calls.filter(([cmd]) => cmd === "close_reminder").length), 1);
    await page.locator("#open").click();
    assert.equal(await page.evaluate(() => window.calls.filter(([cmd]) => cmd === "open_reminder").length), 1);
    assert.equal(await page.evaluate(() => window.calls.filter(([cmd]) => cmd === "close_reminder").length), 2);
    const heights = await page.evaluate(() => window.calls.filter(([cmd]) => cmd === "resize_reminder").map(([, args]) => args.height));
    assert.ok(heights.length > 0);
    assert.ok(heights.every(height => height >= 160 && height <= 440));
    assert.ok(heights.at(-1) < heights[0], "test notification should be shorter than an event reminder");
    await page.close();
    console.log(`PASS ${colorScheme}: persistent reminders, live countdown, queue, actions, failures, test notification, sizing`);
  }
} finally { await browser.close(); }
