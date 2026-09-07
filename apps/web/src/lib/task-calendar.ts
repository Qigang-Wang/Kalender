export function taskCalendarRange(
  startsAt?: string,
  estimatedMinutes?: number,
): { readonly start: string; readonly end: string } | undefined {
  if (!startsAt || !estimatedMinutes) return undefined;
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return undefined;
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + estimatedMinutes * 60_000).toISOString(),
  };
}
