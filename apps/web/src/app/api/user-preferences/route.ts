import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import {
  listUserPreferences,
  saveUserPreference,
  UserPreferenceError,
} from "@/server/user-preferences";

export const runtime = "nodejs";

interface SavePreferenceBody {
  readonly key?: unknown;
  readonly value?: unknown;
}

export async function GET(request: Request) {
  try {
    const actor = await requireActor();
    const url = new URL(request.url);
    const keys = url.searchParams.getAll("key")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    return NextResponse.json({
      ok: true,
      preferences: await listUserPreferences(actor.id, keys),
    });
  } catch (error) {
    return userPreferenceErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireActor();
    const body = await request.json().catch(() => null) as SavePreferenceBody | null;
    if (!body || typeof body.key !== "string") throw new UserPreferenceError("Ungültiges bevorzugtes Format");
    const preference = await saveUserPreference(actor.id, body.key, body.value);
    return NextResponse.json({ ok: true, preference });
  } catch (error) {
    return userPreferenceErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
  return actor;
}

function userPreferenceErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError || error instanceof UserPreferenceError
    ? error
    : new UserPreferenceError("nicht in der Lage, Präferenzen zu speichern", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
