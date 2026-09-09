const SAFE_ATTACHMENT_PREVIEW_TYPES = new Map([
  ["application/pdf", "application/pdf"],
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["text/plain", "text/plain; charset=utf-8"],
  ["text/csv", "text/csv; charset=utf-8"],
]);

export function safeAttachmentPreviewContentType(contentType: string): string | undefined {
  return SAFE_ATTACHMENT_PREVIEW_TYPES.get(contentType.split(";", 1)[0]!.trim().toLocaleLowerCase());
}
