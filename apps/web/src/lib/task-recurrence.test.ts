import { nextTaskOccurrence } from "./task-recurrence";

if (nextTaskOccurrence("2026-01-31T09:00:00.000Z", { frequency: "monthly", interval: 1 }) !== "2026-02-28T09:00:00.000Z") throw new Error("monthly recurrence should clamp to month end");
if (nextTaskOccurrence("2024-02-29T09:00:00.000Z", { frequency: "yearly", interval: 1 }) !== "2025-02-28T09:00:00.000Z") throw new Error("yearly recurrence should clamp leap day");
console.log("Task recurrence tests passed");
