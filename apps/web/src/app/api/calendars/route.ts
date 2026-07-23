import { NextResponse } from "next/server";

import { localCalendarContext, localCalendarProvider } from "@/server/local-calendar-provider";

export const runtime = "nodejs";

export async function GET() {
  const calendars = await localCalendarProvider.listCalendars(localCalendarContext);
  return NextResponse.json({ ok: true, calendars });
}
