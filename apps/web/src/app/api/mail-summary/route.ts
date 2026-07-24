import { NextResponse } from "next/server";

import { getMailNavigationSummary } from "@/server/mail-repository";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, ...await getMailNavigationSummary() });
}
