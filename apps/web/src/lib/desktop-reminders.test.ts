import assert from "node:assert/strict";

import { DEFAULT_DESKTOP_REMINDER_SETTINGS } from "./desktop-bridge";
import { createDesktopReminderSyncPayload, type CalendarReminderEvent } from "./desktop-reminders";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 7, day, hour, minute).toISOString();
const now = new Date(2026, 7, 4, 13, 40);
const events: CalendarReminderEvent[] = [
  { id: "local", title: "个人日历", start: at(4, 8, 30), end: at(4, 8, 40), allDay: false, status: "confirmed" },
  { id: "exchange", title: "AMT", start: at(4, 13), end: at(4, 13, 30), allDay: false, status: "confirmed" },
  { id: "spanning", title: "跨日事项", start: at(3, 23), end: at(4, 1), allDay: false, status: "tentative" },
  { id: "cancelled", title: "已取消", start: at(4, 15), end: at(4, 16), allDay: false, status: "cancelled" },
  { id: "future", title: "后续日程", start: at(5, 9), end: at(5, 10), allDay: false, status: "confirmed" },
  { id: "silent", title: "不提醒", start: at(5, 10), end: at(5, 11), allDay: false, status: "confirmed", reminderMinutesBefore: 0 },
  { id: "custom", title: "提前一天", location: "Meeting room", start: at(6, 9), end: at(6, 10), allDay: false, status: "confirmed", reminderMinutesBefore: 1440 },
  { id: "invalid", title: "无效日程", start: "invalid", end: at(5, 12), allDay: false, status: "confirmed" },
];

const payload = createDesktopReminderSyncPayload(events, DEFAULT_DESKTOP_REMINDER_SETTINGS, now);

assert.equal(payload.summary.todayCount, 3, "summary includes overlapping events from every calendar source");
assert.equal(payload.summary.nextTitle, "后续日程", "next event skips completed and cancelled events");
assert.equal(payload.reminders.length, 5, "queue excludes cancelled, invalid, and explicitly silent events");
assert(payload.reminders.some((reminder) => reminder.id === "exchange"), "Exchange events remain in the reminder queue");
assert.equal(
  payload.reminders.find((reminder) => reminder.id === "local")?.remindAt,
  new Date(at(4, 8, 20)).getTime(),
  "timed reminders use the configured lead time",
);
assert.equal(
  payload.reminders.find((reminder) => reminder.id === "custom")?.remindAt,
  new Date(at(5, 9)).getTime(),
  "event-specific reminder lead time overrides the desktop default",
);
assert.equal(payload.reminders.find((reminder) => reminder.id === "custom")?.location, "Meeting room", "location is available to the custom reminder window");
assert(!payload.reminders.some((reminder) => reminder.id === "silent"), "events set to no reminder stay out of the native queue");

console.log("Desktop calendar reminder tests passed");
