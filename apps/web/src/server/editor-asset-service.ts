import { randomUUID } from "node:crypto";

import { getDatabase } from "./database";

export const MAX_EDITOR_ASSET_BYTES = 10 * 1024 * 1024;

const INLINE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

interface EditorAssetRow {
  readonly id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly content: Uint8Array;
}

export interface StoredEditorAsset {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content: Uint8Array;
}

export class EditorAssetError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "EditorAssetError";
  }
}

export async function saveEditorAsset(file: File, userId: string): Promise<Omit<StoredEditorAsset, "content">> {
  const normalized = await normalizeEditorAsset(file);
  const id = randomUUID();
  const database = await getDatabase();
  await database.query(
    `INSERT INTO editor_assets (id, user_id, filename, mime_type, size_bytes, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, normalized.filename, normalized.mimeType, normalized.content.byteLength, normalized.content],
  );
  return {
    id,
    filename: normalized.filename,
    mimeType: normalized.mimeType,
    sizeBytes: normalized.content.byteLength,
  };
}

export async function getEditorAsset(assetId: string, userId: string): Promise<StoredEditorAsset | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) return undefined;
  const database = await getDatabase();
  const result = await database.query<EditorAssetRow>(
    `SELECT id, filename, mime_type, size_bytes, content
       FROM editor_assets
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [assetId, userId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    content: row.content,
  } : undefined;
}

export function editorAssetDisposition(mimeType: string): "inline" | "attachment" {
  return INLINE_MIME_TYPES.has(mimeType) ? "inline" : "attachment";
}

async function normalizeEditorAsset(file: File): Promise<{
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
}> {
  if (!(file instanceof File)) throw new EditorAssetError("上传文件格式无效");
  if (file.size <= 0) throw new EditorAssetError("上传文件不能为空");
  if (file.size > MAX_EDITOR_ASSET_BYTES) throw new EditorAssetError("编辑器文件不能超过 10 MB", 413);
  const filename = file.name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!filename || filename.length > 240) throw new EditorAssetError("文件名称无效或过长");
  const mimeType = file.type.trim().toLocaleLowerCase() || "application/octet-stream";
  if (mimeType === "image/svg+xml") throw new EditorAssetError("暂不支持 SVG 图片，请使用 PNG、JPEG、GIF 或 WebP");
  if (mimeType.startsWith("image/") && !INLINE_MIME_TYPES.has(mimeType)) {
    throw new EditorAssetError("图片格式不受支持，请使用 PNG、JPEG、GIF 或 WebP");
  }
  return { filename, mimeType, content: new Uint8Array(await file.arrayBuffer()) };
}
