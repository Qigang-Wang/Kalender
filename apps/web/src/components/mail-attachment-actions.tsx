"use client";

import { createPortal } from "react-dom";
import { Download, Eye, X } from "lucide-react";
import { useEffect, useState } from "react";

import { safeAttachmentPreviewContentType } from "@/lib/mail-attachment-preview";

export function MailAttachmentActions({ messageId, attachmentIndex, filename, contentType }: {
  readonly messageId: string;
  readonly attachmentIndex: number;
  readonly filename: string;
  readonly contentType: string;
}) {
  const [open, setOpen] = useState(false);
  const downloadUrl = `/api/messages/${encodeURIComponent(messageId)}/attachments/${attachmentIndex}`;
  const canPreview = Boolean(safeAttachmentPreviewContentType(contentType));

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return <>
    <span className="incoming-attachment-actions">
      {canPreview && <button type="button" onClick={() => setOpen(true)}><Eye size={13} />预览</button>}
      <a href={downloadUrl} download><Download size={13} />下载</a>
    </span>
    {open && createPortal(
      <div className="attachment-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <section className="attachment-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览附件：${filename}`}>
          <header><strong>{filename}</strong><span><a href={downloadUrl} download><Download size={15} />下载</a><button type="button" aria-label="关闭附件预览" onClick={() => setOpen(false)}><X size={18} /></button></span></header>
          <iframe title={`附件预览：${filename}`} src={`${downloadUrl}?preview=1`} sandbox="" referrerPolicy="no-referrer" />
        </section>
      </div>,
      document.body,
    )}
  </>;
}
