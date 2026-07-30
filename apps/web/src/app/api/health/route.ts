import { NextResponse } from "next/server";

import { getDatabase } from "@/server/database";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = process.env.KALENDER_HEALTHCHECK_TOKEN;
  if (token) {
    const provided = new URL(request.url).searchParams.get("token") ?? request.headers.get("x-healthcheck-token");
    if (provided !== token) return NextResponse.json({ ok: false, status: "unauthorized" }, { status: 401 });
  }
  try {
    await (await getDatabase()).query("SELECT 1");
    return NextResponse.json({ ok: true, status: "healthy", checkedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ ok: false, status: "unhealthy", checkedAt: new Date().toISOString() }, { status: 503 });
  }
}
