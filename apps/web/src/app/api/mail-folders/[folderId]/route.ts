import { NextResponse } from "next/server";

import {
  deleteMailFolder,
  MailFolderActionError,
  moveMailFolder,
  renameMailFolder,
} from "@/server/mail-folder-actions";

export const runtime = "nodejs";
export const maxDuration = 60;

interface FolderRouteContext {
  readonly params: Promise<{ readonly folderId: string }>;
}

export async function PATCH(request: Request, context: FolderRouteContext) {
  const { folderId } = await context.params;
  const input = await request.json().catch(() => null) as {
    readonly action?: unknown;
    readonly name?: unknown;
    readonly parentFolderId?: unknown;
  } | null;
  try {
    if (input?.action === "rename" && typeof input.name === "string") {
      return NextResponse.json({ ok: true, result: await renameMailFolder(folderId, input.name) });
    }
    if (input?.action === "move" && (input.parentFolderId === undefined || typeof input.parentFolderId === "string")) {
      return NextResponse.json({ ok: true, result: await moveMailFolder(folderId, input.parentFolderId) });
    }
    return NextResponse.json({ message: "nicht unterstützte Ordner-Operationen" }, { status: 400 });
  } catch (error) {
    return folderErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: FolderRouteContext) {
  const { folderId } = await context.params;
  try {
    return NextResponse.json({ ok: true, result: await deleteMailFolder(folderId) });
  } catch (error) {
    return folderErrorResponse(error);
  }
}

function folderErrorResponse(error: unknown) {
  if (error instanceof MailFolderActionError) {
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
  }
  return NextResponse.json({ ok: false, message: "Mail-Ordner-Operation fehlgeschlagen" }, { status: 500 });
}
