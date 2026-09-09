// Use a fresh, isolated Next server with KALENDER_DATA_DIR=/tmp/kalender-consistency-test-<id>.
// CONSISTENCY_TEST_URL=http://127.0.0.1:3101 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-consistency.mjs
import assert from "node:assert/strict";
const baseURL = process.env.CONSISTENCY_TEST_URL;
assert(baseURL && new URL(baseURL).hostname === "127.0.0.1" && new URL(baseURL).port !== "3000", "use an isolated local test server");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const checked = async (response, status = 200) => {
  assert.equal(response.status(), status, await response.text());
  return response.json();
};
try {
  const context = await browser.newContext({ baseURL });
  const credentials = { username: "consistency-test", password: "consistency-test-password" };
  const setup = await context.request.post("/api/auth/setup", { data: { ...credentials, displayName: "Consistency test", confirmPassword: credentials.password } });
  if (!setup.ok()) await checked(await context.request.post("/api/auth/login", { data: credentials }));
  const request = context.request;
  const title = `private-${Date.now()}`;
  const task = (await checked(await request.post("/api/tasks", { data: { title, status: "inbox" } }), 201)).task;
  const memberCredentials = { username: `member-${Date.now()}`, password: "member-test-password" };
  const member = (await checked(await request.post("/api/users", { data: { ...memberCredentials, displayName: "Member", role: "user", mustChangePassword: false } }), 201)).user;
  const memberContext = await browser.newContext({ baseURL });
  await checked(await memberContext.request.post("/api/auth/login", { data: memberCredentials }));
  const scoped = await checked(await memberContext.request.get("/api/tasks"));
  assert(!JSON.stringify(scoped).includes(task.id), "a valid member session is owner scoped");
  await checked(await request.patch(`/api/users/${member.id}`, { data: { disabled: true } }));
  await checked(await memberContext.request.get("/api/tasks"), 401);
  await checked(await memberContext.request.get(`/api/tasks/${task.id}`), 401);
  await checked(await request.patch(`/api/users/${member.id}`, { data: { disabled: false } }));
  await checked(await memberContext.request.get("/api/tasks"), 401);
  await checked(await memberContext.request.post("/api/auth/login", { data: memberCredentials }));
  await checked(await memberContext.request.get("/api/tasks"));
  await memberContext.close();

  const note = (await checked(await request.post("/api/notes", { data: { title: "Initial", content: "Initial body", noteType: "general" } }), 201)).note;
  const noteURL = `/api/notes/${note.id}`;
  const newer = (await checked(await request.patch(noteURL, { data: { ...note, title: "New server revision", expectedUpdatedAt: note.updatedAt } }))).note;
  await checked(await request.patch(noteURL, { data: { ...note, title: "Late stale write", expectedUpdatedAt: note.updatedAt } }), 409);
  await checked(await request.patch(noteURL, { data: { ...note, title: "Missing revision" } }), 400);
  assert.equal((await checked(await request.get("/api/notes"))).notes.find((item) => item.id === note.id).title, newer.title);

  const page = await context.newPage();
  const saves = [];
  let releaseFirst;
  await page.route(`**${noteURL}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    saves.push(route.request().postDataJSON());
    if (saves.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.goto(`/notes?note=${note.id}`);
  const input = page.getByRole("textbox", { name: "笔记标题", exact: true });
  await input.waitFor();
  await input.fill("First pending save");
  const waitFor = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert(condition(), "expected asynchronous state arrived");
  };
  await waitFor(() => releaseFirst);
  await input.fill("Newest local edit");
  await page.waitForTimeout(1000); // Cross the debounce boundary while the first request is blocked.
  assert.equal(saves.length, 1, "typing during save cannot issue a concurrent stale write");
  releaseFirst();
  await page.locator(".note-save-state.saved").waitFor();
  assert.equal(saves.length, 2);
  assert.notEqual(saves[0].expectedUpdatedAt, saves[1].expectedUpdatedAt, "queued save uses the committed revision");
  assert.equal(await input.inputValue(), "Newest local edit");
  const latest = (await checked(await request.get("/api/notes"))).notes.find((item) => item.id === note.id);
  assert.equal(latest.title, "Newest local edit");
  await checked(await request.patch(noteURL, { data: { ...latest, title: "Other tab edit", expectedUpdatedAt: latest.updatedAt } }));
  await input.fill("Local conflict retained");
  await page.locator(".note-save-state.error").waitFor();
  assert.equal(await input.inputValue(), "Local conflict retained");
  assert.equal((await checked(await request.get("/api/notes"))).notes.find((item) => item.id === note.id).title, "Other tab edit");
  await page.getByRole("button", { name: "另存为副本", exact: true }).click();
  await page.getByText("笔记副本已创建", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "Local conflict retained 副本");

  const calendars = (await checked(await request.get("/api/calendars"))).calendars;
  const calendarId = calendars.find((calendar) => !calendar.readOnly).id;
  const eventData = { calendarId, title: "Occupying slot", start: "2035-09-10T09:00:00.000Z", end: "2035-09-10T10:00:00.000Z", allDay: false, allowConflicts: true };
  const occupied = (await checked(await request.post("/api/calendar-events", { data: eventData }), 201)).event;
  const retryData = { ...eventData, title: "Offline retry", allowConflicts: false };
  const headers = { "x-calendar-operation-id": `consistency-${Date.now()}` };
  await checked(await request.post("/api/calendar-events", { data: retryData, headers }), 409);
  await checked(await request.delete(`/api/calendar-events/${occupied.id}?calendarId=${encodeURIComponent(calendarId)}`));
  const retried = (await checked(await request.post("/api/calendar-events", { data: retryData, headers }), 201)).event;
  const replayed = (await checked(await request.post("/api/calendar-events", { data: retryData, headers }), 201)).event;
  assert.equal(retried.id, replayed.id);
  console.log("Consistency browser/API tests passed: disabled/revoked sessions, note CAS and serialized saves, retained conflicts/copies, resolved offline operation replay");
} finally {
  await browser.close();
}
