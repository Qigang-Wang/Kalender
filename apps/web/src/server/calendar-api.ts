import { NextResponse } from "next/server";

import { CalendarRepositoryError } from "./calendar-repository";
import { CalendarValidationError } from "./calendar-validation";
import { ExchangeCalendarError } from "./exchange-calendar";

export function calendarErrorResponse(error: unknown) {
  if (error instanceof CalendarValidationError || error instanceof CalendarRepositoryError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  if (error instanceof ExchangeCalendarError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  return NextResponse.json({ ok: false, message: "Kalenderoperation fehlgeschlagen" }, { status: 500 });
}
