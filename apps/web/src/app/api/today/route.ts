import { NextResponse } from "next/server";

import { getTodaySnapshot, parseTodayRange, TodayRangeError } from "@/server/today-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const range = parseTodayRange(new URL(request.url));
    return NextResponse.json({ ok: true, snapshot: await getTodaySnapshot(range.from, range.to) });
  } catch (error) {
    if (error instanceof TodayRangeError) return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
    console.error("Today snapshot failed", error);
    return NextResponse.json({ ok: false, message: "Daten können heute nicht gelesen werden" }, { status: 500 });
  }
}
