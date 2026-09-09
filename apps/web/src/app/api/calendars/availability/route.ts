import { NextResponse } from "next/server";
import { calendarErrorResponse } from "@/server/calendar-api";
import { calendarParticipantAvailability } from "@/server/calendar-event-service";
import { parseCalendarEventInput, CalendarValidationError } from "@/server/calendar-validation";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const input = parseCalendarEventInput({ ...body, title: "空闲时间查询" });
    if (!input.attendees?.length || new Date(input.end).getTime() - new Date(input.start).getTime() > 42 * 86400000) throw new CalendarValidationError("请选择参与者，查询范围最多 42 天");
    return NextResponse.json({ ok: true, participants: await calendarParticipantAvailability(input.calendarId, input.attendees.map((attendee) => attendee.address), input.start, input.end) });
  } catch (error) { return calendarErrorResponse(error); }
}
