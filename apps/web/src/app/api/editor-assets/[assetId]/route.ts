import { AuthError, getCurrentAppUser } from "@/server/auth";
import { editorAssetDisposition, EditorAssetError, getEditorAsset } from "@/server/editor-asset-service";

export const runtime = "nodejs";

interface EditorAssetRouteContext {
  readonly params: Promise<{ readonly assetId: string }>;
}

export async function GET(_request: Request, context: EditorAssetRouteContext) {
  try {
    const actor = await getCurrentAppUser();
    if (!actor) throw new AuthError("请先登录", 401);
    const { assetId } = await context.params;
    const asset = await getEditorAsset(assetId, actor.id);
    if (!asset) throw new EditorAssetError("文件不存在", 404);
    return new Response(Buffer.from(asset.content), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${editorAssetDisposition(asset.mimeType)}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        "Content-Length": String(asset.sizeBytes),
        "Content-Type": asset.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const normalized = error instanceof AuthError || error instanceof EditorAssetError
      ? error
      : new EditorAssetError("无法读取编辑器文件", 500);
    return Response.json({ ok: false, message: normalized.message }, { status: normalized.status });
  }
}
