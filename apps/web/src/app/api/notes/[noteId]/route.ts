import { NextResponse } from "next/server";

import { noteErrorResponse } from "@/server/note-api";
import { deleteStoredNote, saveStoredNote, NoteRepositoryError } from "@/server/note-repository";
import { parseNoteInput, type NoteRequestBody } from "@/server/note-validation";

export const runtime = "nodejs";

interface NoteRouteContext {
  readonly params: Promise<{ readonly noteId: string }>;
}

export async function PATCH(request: Request, context: NoteRouteContext) {
  const { noteId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as NoteRequestBody | null;
    return NextResponse.json({ ok: true, note: await saveStoredNote(parseNoteInput(body, noteId)) });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: NoteRouteContext) {
  const { noteId } = await context.params;
  try {
    if (!await deleteStoredNote(noteId)) throw new NoteRepositoryError("NOTE_NOT_FOUND", "Notiz nicht gefunden", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
