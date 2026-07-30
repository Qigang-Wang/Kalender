import { NextResponse } from "next/server";

import { localCalendarContext, localCalendarProvider } from "@/server/local-calendar-provider";
import { ensureCalendarSyncScheduler } from "@/server/calendar-sync-scheduler";

export const runtime = "nodejs";

export async function GET() {
  await ensureCalendarSyncScheduler();
  const calendars = await localCalendarProvider.listCalendars(localCalendarContext);
  return NextResponse.json({ ok: true, calendars });
}
