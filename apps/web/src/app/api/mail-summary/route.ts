import { NextResponse } from "next/server";

import { getMailNavigationSummary } from "@/server/mail-repository";
import { ensureMailSyncScheduler } from "@/server/mail-sync-scheduler";

export const runtime = "nodejs";

export async function GET() {
  await ensureMailSyncScheduler();
  return NextResponse.json({ ok: true, ...await getMailNavigationSummary() });
}
