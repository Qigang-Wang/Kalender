import { safeAttachmentPreviewContentType } from "./mail-attachment-preview";

if (safeAttachmentPreviewContentType("application/pdf") !== "application/pdf") throw new Error("PDF should be previewable");
if (safeAttachmentPreviewContentType("TEXT/PLAIN; charset=iso-8859-1") !== "text/plain; charset=utf-8") throw new Error("text should use a safe canonical type");
for (const unsafe of ["text/html", "image/svg+xml", "application/javascript", "application/vnd.ms-excel"]) {
  if (safeAttachmentPreviewContentType(unsafe)) throw new Error(`${unsafe} must not be previewed inline`);
}
console.log("Mail attachment preview type tests passed");
