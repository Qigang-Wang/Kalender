export type MailDateGroupId = "today" | "yesterday" | "this-week" | "last-week" | "last-month" | "older";

export interface MailDateGroup<T> {
  readonly id: MailDateGroupId;
  readonly label: string;
  readonly items: readonly T[];
}

interface DatedMailItem {
  readonly receivedAt: string;
}

const groupDefinitions: ReadonlyArray<{ readonly id: MailDateGroupId; readonly label: string }> = [
  { id: "today", label: "Heute" },
  { id: "yesterday", label: "Gestern" },
  { id: "this-week", label: "Diese Woche" },
  { id: "last-week", label: "Letzte Woche" },
  { id: "last-month", label: "Letzter Monat" },
  { id: "older", label: "Früher" },
];

function localDayStart(date: Date, dayOffset = 0): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset).getTime();
}

function localWeekStart(date: Date, weekOffset = 0): number {
  const mondayOffset = (date.getDay() + 6) % 7;
  return localDayStart(date, -mondayOffset + weekOffset * 7);
}

function resolveGroupId(value: string, now: Date): MailDateGroupId {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "older";

  const todayStart = localDayStart(now);
  const yesterdayStart = localDayStart(now, -1);
  const thisWeekStart = localWeekStart(now);
  const lastWeekStart = localWeekStart(now, -1);
  const lastMonthStart = localDayStart(now, -30);

  if (timestamp >= todayStart) return "today";
  if (timestamp >= yesterdayStart) return "yesterday";
  if (timestamp >= thisWeekStart) return "this-week";
  if (timestamp >= lastWeekStart) return "last-week";
  if (timestamp >= lastMonthStart) return "last-month";
  return "older";
}

export function groupMailByDate<T extends DatedMailItem>(
  items: readonly T[],
  now = new Date(),
): readonly MailDateGroup<T>[] {
  const grouped = new Map<MailDateGroupId, T[]>(groupDefinitions.map(({ id }) => [id, []]));
  items.forEach((item) => grouped.get(resolveGroupId(item.receivedAt, now))!.push(item));

  return groupDefinitions.flatMap(({ id, label }) => {
    const groupItems = grouped.get(id)!;
    return groupItems.length ? [{ id, label, items: groupItems }] : [];
  });
}
