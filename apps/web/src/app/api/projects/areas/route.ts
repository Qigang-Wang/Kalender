import { NextResponse } from "next/server";

import { noteErrorResponse } from "@/server/note-api";
import { renameStoredProjectArea } from "@/server/note-repository";
import {
  parseProjectAreaRenameInput,
  type ProjectAreaRenameRequestBody,
} from "@/server/note-validation";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null) as ProjectAreaRenameRequestBody | null;
    const input = parseProjectAreaRenameInput(body);
    return NextResponse.json({ ok: true, result: await renameStoredProjectArea(input.previousName, input.name) });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
