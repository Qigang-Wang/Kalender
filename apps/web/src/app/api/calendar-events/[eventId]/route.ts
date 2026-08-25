import { NextResponse } from "next/server";

import { calendarErrorResponse } from "@/server/calendar-api";
import { parseCalendarEventInput, type CalendarEventRequestBody } from "@/server/calendar-validation";
import { deleteCalendarEvent, upsertCalendarEvent } from "@/server/calendar-event-service";
import { listStoredCalendarEventConflicts } from "@/server/calendar-repository";

export const runtime = "nodejs";

interface CalendarEventRouteContext {
  readonly params: Promise<{ readonly eventId: string }>;
}

export async function PATCH(request: Request, context: CalendarEventRouteContext) {
  const { eventId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as CalendarEventRequestBody | null;
    const input = parseCalendarEventInput({ ...body, id: eventId });
    const conflicts = await listStoredCalendarEventConflicts({ calendarId: input.calendarId, start: input.start, end: input.end, excludeEventId: eventId });
    if (conflicts.length && body?.allowConflicts !== true) {
      return NextResponse.json({ ok: false, message: "die ausgewählten Zeitkonflikte mit dem bestehenden Kalenderereignis", conflicts }, { status: 409 });
    }
    const event = await upsertCalendarEvent(input);
    return NextResponse.json({ ok: true, event });
  } catch (error) {
    return calendarErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: CalendarEventRouteContext) {
  const { eventId } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const calendarId = searchParams.get("calendarId");
  if (!calendarId) return NextResponse.json({ ok: false, message: "keine Kalender-Identifikatoren verfügbar" }, { status: 400 });
  try {
    const seriesId = searchParams.get("recurrenceSeriesId");
    const recurrenceId = searchParams.get("recurrenceId");
    const requestedScope = searchParams.get("scope");
    const scope = requestedScope === "following" || requestedScope === "series" ? requestedScope : "occurrence";
    await deleteCalendarEvent(
      calendarId,
      eventId,
      seriesId && recurrenceId ? { seriesId, recurrenceId, scope } : undefined,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return calendarErrorResponse(error);
  }
}
