import { NextResponse } from "next/server";

import { noteErrorResponse } from "@/server/note-api";
import { listStoredNotes, saveStoredNote } from "@/server/note-repository";
import { parseNoteInput, type NoteRequestBody } from "@/server/note-validation";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, notes: await listStoredNotes() });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as NoteRequestBody | null;
    const note = await saveStoredNote(parseNoteInput(body));
    return NextResponse.json({ ok: true, note }, { status: 201 });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
