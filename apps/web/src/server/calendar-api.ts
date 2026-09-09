import { NextResponse } from "next/server";

import { CalendarRepositoryError } from "./calendar-repository";
import { CalendarValidationError } from "./calendar-validation";
import { ExchangeEwsError } from "./exchange-ews-client";
import { CalDavError } from "./caldav-client";

export function calendarErrorResponse(error: unknown) {
  if (error instanceof CalendarValidationError || error instanceof CalendarRepositoryError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  if (error instanceof ExchangeEwsError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  if (error instanceof CalDavError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  console.error("Calendar operation failed", error);
  return NextResponse.json({ ok: false, message: "日历操作失败" }, { status: 500 });
}
