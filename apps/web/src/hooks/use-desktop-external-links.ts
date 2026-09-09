"use client";

import { useEffect } from "react";

import { isDesktopApp } from "@/lib/desktop-bridge";

export function useDesktopExternalLinks(): void {
  useEffect(() => {
    const openInDefaultBrowser = (event: MouseEvent) => {
      if (!isDesktopApp() || event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || target.hasAttribute("download")) return;

      let url: URL;
      try {
        url = new URL(target.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin === window.location.origin || !["http:", "https:", "mailto:"].includes(url.protocol)) return;

      event.preventDefault();
      window.open(url.href, "_blank", "noopener,noreferrer");
    };

    document.addEventListener("click", openInDefaultBrowser, true);
    return () => document.removeEventListener("click", openInDefaultBrowser, true);
  }, []);
}
