import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { EditorAssetError, saveEditorAsset } from "@/server/editor-asset-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) throw new EditorAssetError("Wählen Sie die Datei zum Hochladen");
    const asset = await saveEditorAsset(file, actor.id);
    return NextResponse.json({
      ok: true,
      file: {
        key: asset.id,
        name: asset.filename,
        size: asset.sizeBytes,
        type: asset.mimeType,
        url: `/api/editor-assets/${encodeURIComponent(asset.id)}`,
      },
    }, { status: 201 });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof EditorAssetError
      ? error
      : new EditorAssetError("Editordatei kann nicht gespeichert werden", 500);
    return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
