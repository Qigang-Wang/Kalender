import { NextResponse } from "next/server";

import { AuthError } from "@/server/auth";
import { listCollaboratorUsers } from "@/server/project-collaboration";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, users: await listCollaboratorUsers() });
  } catch (error) {
    const normalized = error instanceof AuthError ? error : new AuthError("keine Mitarbeiter können gelesen werden", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
