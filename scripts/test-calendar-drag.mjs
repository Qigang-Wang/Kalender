// Run against a separate dev server with KALENDER_DATA_DIR=/tmp/kalender-drag-test-<id>:
// CALENDAR_TEST_URL=http://127.0.0.1:3101 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-calendar-drag.mjs
import assert from "node:assert/strict";

const baseURL = process.env.CALENDAR_TEST_URL;
assert(baseURL && new URL(baseURL).hostname === "127.0.0.1" && new URL(baseURL).port !== "3000", "use an isolated local test server");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ baseURL, viewport: { width: 1200, height: 1000 }, timezoneId: "Europe/Berlin" });
  const credentials = { username: "calendar-drag-test", password: "calendar-drag-test-password" };
  const setup = await context.request.post("/api/auth/setup", { data: { ...credentials, displayName: "Calendar drag test", confirmPassword: credentials.password } });
  if (!setup.ok()) assert((await context.request.post("/api/auth/login", { data: credentials })).ok(), "test account login");
  const page = await context.newPage();
  const original = { id: "drag-test", calendarId: "test-calendar", title: "Drag regression", start: "2026-09-07T07:00:00.000Z", end: "2026-09-07T08:00:00.000Z", allDay: false, status: "confirmed", updatedAt: "2026-09-01T00:00:00.000Z" };
  let stored = { ...original };
  let pendingSave;
  let pendingRefresh;
  let holdRefresh = false;
  await page.route("**/api/calendars", (route) => route.fulfill({ json: { calendars: [{ id: original.calendarId, name: "Test", readOnly: false }] } }));
  await page.route("**/api/calendar-events?*", async (route) => {
    const snapshot = { ...stored };
    if (holdRefresh) {
      holdRefresh = false;
      await new Promise((resolve) => { pendingRefresh = resolve; });
    }
    await route.fulfill({ json: { events: [snapshot] } });
  });
  await page.route("**/api/calendar-events/drag-test", async (route) => {
    const changes = route.request().postDataJSON();
    const status = await new Promise((resolve) => { pendingSave = resolve; });
    pendingSave = undefined;
    if (status === 200) stored = { ...stored, ...changes };
    await route.fulfill({ status, json: status === 200 ? { event: stored } : status === 409 ? { conflicts: [{ ...original, title: "Conflicting event" }] } : { message: "Test save failed" } });
  });
  await page.goto("/calendar?date=2026-09-07");
  const item = page.getByTestId("calendar-event").filter({ hasText: original.title });
  await item.waitFor();
  const originalTop = await item.evaluate((element) => element.style.top);
  const waitFor = async (condition) => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert(condition(), "expected request arrived");
  };
  const day = (index) => page.getByTestId(`calendar-week-day-${index}`);
  const drop = async (index) => {
    await item.dragTo(day(index), { targetPosition: { x: 40, y: 360 } });
    await waitFor(() => pendingSave);
    assert.equal(await day(index).getByTestId("calendar-event").count(), 1, "event stays at dropped day while saving");
  };
  await drop(1);
  holdRefresh = true;
  await page.evaluate(() => window.dispatchEvent(new Event("kalender:calendar-synced")));
  await waitFor(() => pendingRefresh);
  const movedTop = await item.evaluate((element) => element.style.top);
  assert.notEqual(movedTop, originalTop, "new time is shown before the save response");
  pendingSave(200);
  await page.getByText(`已移动“${original.title}”`, { exact: true }).waitFor();
  const refreshed = page.waitForResponse((response) => response.url().includes("/api/calendar-events?") && response.request().method() === "GET");
  pendingRefresh();
  await refreshed;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await day(1).getByTestId("calendar-event").count(), 1, "late stale refresh cannot undo a successful move");
  assert.equal(await item.evaluate((element) => element.style.top), movedTop);
  await drop(2);
  pendingSave(502);
  await page.getByText("Test save failed", { exact: true }).waitFor();
  assert.equal(await day(1).getByTestId("calendar-event").count(), 1, "failed save restores the previous day");
  assert.equal(await item.evaluate((element) => element.style.top), movedTop, "failed save restores the previous time");
  await drop(2);
  pendingSave(409);
  const conflictDialog = page.getByRole("alertdialog", { name: "时间与现有日程冲突" });
  await conflictDialog.waitFor();
  assert.equal(await day(2).getByTestId("calendar-event").count(), 1, "preview remains visible during conflict confirmation");
  await conflictDialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByText("已取消移动日程", { exact: true }).waitFor();
  assert.equal(await day(1).getByTestId("calendar-event").count(), 1, "cancelled conflict restores the original position");
  const originalHeight = await item.evaluate((element) => element.style.height);
  const handle = await item.locator(".calendar-event-resize-handle").boundingBox();
  assert(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 35, { steps: 5 });
  await page.mouse.up();
  await waitFor(() => pendingSave);
  const resizedHeight = await item.evaluate((element) => element.style.height);
  assert.notEqual(resizedHeight, originalHeight, "resized duration remains visible while saving");
  pendingSave(200);
  await page.getByText(`已调整“${original.title}”的时长`, { exact: true }).waitFor();
  assert.equal(await item.evaluate((element) => element.style.height), resizedHeight, "resize settles without jumping back");
  await context.setOffline(true);
  await item.dragTo(day(0), { targetPosition: { x: 40, y: 360 } });
  await page.getByText("移动已保存在本机，联网后自动同步", { exact: true }).waitFor();
  assert.equal(await day(0).getByTestId("calendar-event").count(), 1, "offline move stays in its new position");
  assert(!pendingSave, "offline move does not call the server");
  assert.equal(await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("dayline:calendar-outbox:"));
    return key ? JSON.parse(localStorage.getItem(key)).length : 0;
  }), 1);
  await context.setOffline(false);
  await waitFor(() => pendingSave);
  pendingSave(200);
  await page.waitForFunction(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("dayline:calendar-outbox:"));
    return key && JSON.parse(localStorage.getItem(key)).length === 0;
  });
  assert.equal(await day(0).getByTestId("calendar-event").count(), 1, "successful replay retains the saved position");
  await page.route("**/api/calendars", (route) => route.fulfill({ json: { calendars: [{ id: original.calendarId, name: "Test Exchange", readOnly: false, providerData: { providerId: "exchange" } }] } }));
  stored = { ...stored, providerData: { providerId: "exchange", isMeeting: true, isOrganizer: false }, attendees: [{ address: "organizer@example.test" }] };
  let meetingReplies = 0;
  await page.route("**/api/calendar-events/drag-test/response", (route) => {
    meetingReplies++;
    assert.equal(route.request().postDataJSON().response, "accept");
    return route.fulfill({ json: { event: stored } });
  });
  await page.reload();
  await item.click();
  await page.getByRole("button", { name: "接受", exact: true }).click();
  const inviteConfirmation = page.getByRole("alertdialog", { name: "接受会议邀请？" });
  await inviteConfirmation.waitFor();
  assert.equal(meetingReplies, 0, "no meeting reply before the explicit send action");
  await inviteConfirmation.getByRole("button", { name: "接受并发送回复" }).click();
  await page.getByText("已接受会议邀请", { exact: true }).waitFor();
  assert.equal(meetingReplies, 1);
  console.log("Calendar meeting invitation response and confirmation passed");
  console.log("Calendar offline queue and reconnect replay passed");
  console.log("Calendar drag: pending position, delayed refresh, success, failure, cancellation and resize passed");
} finally {
  await browser.close();
}
