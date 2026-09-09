import { runCalendarOperation } from "@/server/calendar-operation";
import { NextResponse } from "next/server";
import { calendarErrorResponse } from "@/server/calendar-api";
import { respondToCalendarMeeting } from "@/server/calendar-event-service";
import { CalendarValidationError } from "@/server/calendar-validation";

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  return runCalendarOperation(request, async (beginWrite) => {
    try {
      const body = await request.json();
      if (!body || typeof body.calendarId !== "string" || !["accept", "tentative", "decline"].includes(body.response) || typeof body.expectedUpdatedAt !== "string" || (body.comment !== undefined && (typeof body.comment !== "string" || body.comment.length > 10000))) throw new CalendarValidationError("会议回复参数无效");
      const { eventId } = await context.params;
      await beginWrite();
      const event = await respondToCalendarMeeting(body.calendarId, eventId, body.response, body.expectedUpdatedAt, body.comment);
      return NextResponse.json({ ok: true, event });
    } catch (error) { return calendarErrorResponse(error); }
  });
}
