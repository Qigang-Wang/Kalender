export interface MailAttachmentDescriptor {
  readonly filename: string;
  readonly contentType: string;
}

export function isSmimeSignatureAttachment(attachment: MailAttachmentDescriptor): boolean {
  const filename = attachment.filename.trim().toLocaleLowerCase();
  const contentType = attachment.contentType.trim().toLocaleLowerCase();
  const baseContentType = contentType.split(";", 1)[0]?.trim();

  if (baseContentType === "application/pkcs7-signature" || baseContentType === "application/x-pkcs7-signature") return true;
  if (baseContentType === "multipart/signed") return true;
  if (filename === "smime.p7s" || filename.endsWith(".p7s")) return true;
  return filename === "smime.p7m" && contentType.includes("signed");
}
