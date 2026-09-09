"use client";

import { ChevronDown, ImageIcon, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { buildMailIframeDocument } from "@/lib/mail-html-document";

export function MailBodyFrame({ html, allowRemoteImages }: { readonly html: string; readonly allowRemoteImages: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resize = useCallback(() => {
    const frame = frameRef.current;
    const document = frame?.contentDocument;
    if (!frame || !document) return;
    frame.style.height = `${Math.max(120, document.documentElement.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  return <iframe
    ref={frameRef}
    className="mail-body-frame"
    title="HTML 邮件正文"
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    referrerPolicy="no-referrer"
    srcDoc={buildMailIframeDocument(html, allowRemoteImages)}
    onLoad={resize}
  />;
}

export function enableRemoteEmailImages(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll<HTMLImageElement>("img[data-remote-src]").forEach((image) => {
    const source = image.dataset.remoteSrc;
    if (!source || !/^https?:\/\//i.test(source)) return;
    image.src = source;
    image.removeAttribute("data-remote-src");
  });
  const styles = Array.from(document.head.querySelectorAll("style"), (style) => style.outerHTML).join("");
  return styles + document.body.innerHTML;
}

export function RemoteImagePermissionButton({
  domain,
  onAllowOnce,
  onAlwaysAllow,
}: {
  readonly domain?: string;
  readonly onAllowOnce: () => void;
  readonly onAlwaysAllow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className="remote-image-permission" ref={rootRef}>
    <button
      className="ghost-button show-mail-images"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation();
        setOpen((current) => !current);
      }}
    ><ImageIcon size={14} />显示图片<ChevronDown size={13} /></button>
    {open && <div className="remote-image-permission-menu" role="menu" aria-label="图片加载选项" onClick={(event) => event.stopPropagation()}>
      <button role="menuitem" onClick={onAllowOnce}><ImageIcon size={15} /><strong>仅显示此邮件</strong></button>
      {domain && <button role="menuitem" onClick={onAlwaysAllow}><ShieldCheck size={15} /><strong>始终允许此域名</strong></button>}
    </div>}
  </div>;
}
