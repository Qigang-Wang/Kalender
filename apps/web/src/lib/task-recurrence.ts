export const taskRecurrenceFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type TaskRecurrenceFrequency = (typeof taskRecurrenceFrequencies)[number];

export interface TaskRecurrenceRule {
  readonly frequency: TaskRecurrenceFrequency;
  readonly interval: number;
}

export function nextTaskOccurrence(value: string, rule: TaskRecurrenceRule): string {
  const current = new Date(value);
  if (Number.isNaN(current.getTime())) throw new Error("重复任务开始时间无效");
  const next = new Date(current);
  if (rule.frequency === "daily") next.setUTCDate(next.getUTCDate() + rule.interval);
  if (rule.frequency === "weekly") next.setUTCDate(next.getUTCDate() + rule.interval * 7);
  if (rule.frequency === "monthly") moveUtcMonth(next, rule.interval);
  if (rule.frequency === "yearly") moveUtcMonth(next, rule.interval * 12);
  return next.toISOString();
}

function moveUtcMonth(value: Date, months: number): void {
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, lastDay));
}
