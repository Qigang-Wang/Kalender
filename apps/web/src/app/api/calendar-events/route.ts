import { NextResponse } from "next/server";

import { calendarErrorResponse } from "@/server/calendar-api";
import {
  parseCalendarEventInput,
  parseCalendarRange,
  type CalendarEventRequestBody,
} from "@/server/calendar-validation";
import { localCalendarContext, localCalendarProvider } from "@/server/local-calendar-provider";
import { upsertCalendarEvent } from "@/server/calendar-event-service";
import { listStoredCalendarEventConflicts } from "@/server/calendar-repository";
import { listCalendarTaskLinks } from "@/server/task-schedule";
import { ensureCalendarSyncScheduler } from "@/server/calendar-sync-scheduler";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await ensureCalendarSyncScheduler();
    const range = parseCalendarRange(new URL(request.url));
    const events = await localCalendarProvider.listEvents(localCalendarContext, { ...range, limit: 1000 });
    const links = await listCalendarTaskLinks(events.items.map((event) => event.id));
    return NextResponse.json({
      ok: true,
      events: events.items.map((event) => ({ ...event, linkedTask: links.get(event.id) })),
    });
  } catch (error) {
    return calendarErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as CalendarEventRequestBody | null;
    const input = parseCalendarEventInput(body);
    const conflicts = await listStoredCalendarEventConflicts({ calendarId: input.calendarId, start: input.start, end: input.end });
    if (conflicts.length && body?.allowConflicts !== true) {
      return NextResponse.json({ ok: false, message: "所选时间与现有日程冲突", conflicts }, { status: 409 });
    }
    const event = await upsertCalendarEvent(input);
    return NextResponse.json({ ok: true, event }, { status: 201 });
  } catch (error) {
    return calendarErrorResponse(error);
  }
}
