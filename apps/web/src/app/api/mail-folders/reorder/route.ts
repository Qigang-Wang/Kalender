import { NextResponse } from "next/server";

import { updateFolderManualOrder } from "@/server/mail-repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as {
    readonly accountId?: unknown;
    readonly parentFolderId?: unknown;
    readonly orderedFolderIds?: unknown;
  } | null;
  if (typeof input?.accountId !== "string" ||
      (input.parentFolderId !== undefined && typeof input.parentFolderId !== "string") ||
      !Array.isArray(input.orderedFolderIds) ||
      input.orderedFolderIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ message: "Ordnersortierungsparameter sind ungültig" }, { status: 400 });
  }
  try {
    await updateFolderManualOrder(input.accountId, input.parentFolderId, input.orderedFolderIds as string[]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      message: error instanceof Error ? error.message : "Ordner-Ordner-Ordner-Ordner kann nicht gespeichert werden",
    }, { status: 409 });
  }
}
