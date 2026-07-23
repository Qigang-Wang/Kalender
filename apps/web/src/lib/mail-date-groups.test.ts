import assert from "node:assert/strict";

import { groupMailByDate } from "./mail-date-groups";

const localIso = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour).toISOString();

const now = new Date(2026, 6, 23, 18);
const items = [
  { id: "today", receivedAt: localIso(2026, 7, 23) },
  { id: "yesterday", receivedAt: localIso(2026, 7, 22) },
  { id: "this-week", receivedAt: localIso(2026, 7, 20) },
  { id: "last-week", receivedAt: localIso(2026, 7, 19) },
  { id: "last-month", receivedAt: localIso(2026, 7, 12) },
  { id: "older", receivedAt: localIso(2026, 6, 20) },
  { id: "invalid", receivedAt: "not-a-date" },
] as const;

const groups = groupMailByDate(items, now);

assert.deepEqual(groups.map((group) => group.id), ["today", "yesterday", "this-week", "last-week", "last-month", "older"]);
assert.deepEqual(groups.map((group) => group.label), ["今天", "昨天", "本周", "上周", "上月", "更早"]);
assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [
  ["today"],
  ["yesterday"],
  ["this-week"],
  ["last-week"],
  ["last-month"],
  ["older", "invalid"],
]);

console.log("mail date grouping tests passed");
