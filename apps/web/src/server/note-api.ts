import { NextResponse } from "next/server";

import { AuthError } from "./auth";
import { NoteRepositoryError } from "./note-repository";
import { NoteValidationError } from "./note-validation";

export function noteErrorResponse(error: unknown) {
  if (error instanceof AuthError || error instanceof NoteRepositoryError || error instanceof NoteValidationError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  console.error("Note operation failed", error);
  return NextResponse.json({ ok: false, message: "笔记操作失败" }, { status: 500 });
}
