import { NextResponse } from "next/server";

import { AuthError, createInitialAdmin, setAuthCookie } from "@/server/auth";

export const runtime = "nodejs";

interface SetupBody {
  readonly displayName?: unknown;
  readonly email?: unknown;
  readonly password?: unknown;
  readonly confirmPassword?: unknown;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as SetupBody | null;
    const password = stringValue(body?.password);
    if (password !== stringValue(body?.confirmPassword)) {
      throw new AuthError("Inkonsistente Passwörter zweimal eingegeben", 400);
    }
    const user = await createInitialAdmin({
      displayName: stringValue(body?.displayName),
      email: stringValue(body?.email),
      password,
    });
    const response = NextResponse.json({ ok: true, user }, { status: 201 });
    setAuthCookie(response, user, request);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function authErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError ? error : new AuthError("Initialisierung fehlgeschlagen", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
