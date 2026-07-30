import { NextResponse } from "next/server";

import { getCurrentAppUser, hasAnyAppUser } from "@/server/auth";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    initialized: await hasAnyAppUser(),
    user: await getCurrentAppUser(),
  });
}
