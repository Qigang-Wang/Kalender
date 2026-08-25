import { NextResponse } from "next/server";

import { NoteRepositoryError } from "./note-repository";
import { ProjectRepositoryError } from "./project-repository";
import { NoteValidationError } from "./note-validation";
import { ProjectValidationError } from "./project-validation";

export function projectErrorResponse(error: unknown) {
  if (
    error instanceof ProjectRepositoryError
    || error instanceof ProjectValidationError
    || error instanceof NoteRepositoryError
    || error instanceof NoteValidationError
  ) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  console.error("Project operation failed", error);
  return NextResponse.json({ ok: false, message: "Projektbetrieb fehlgeschlagen" }, { status: 500 });
}
