"use client";

import { useEffect } from "react";

export function useVisualViewportLayout(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;

    const syncViewport = () => {
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      root.style.setProperty("--visual-viewport-height", `${Math.round(height)}px`);
      root.style.setProperty("--visual-viewport-offset-top", `${Math.round(offsetTop)}px`);

      const focusedElement = document.activeElement;
      const editableFocused = focusedElement instanceof HTMLElement && (
        focusedElement.matches("input, textarea, select, [contenteditable='true']")
        || focusedElement.closest("[contenteditable='true']") !== null
      );
      const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
      const keyboardOpen = window.innerWidth <= 760 && editableFocused && layoutHeight - height > 120;
      document.body.classList.toggle("software-keyboard-open", keyboardOpen);
    };

    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    document.addEventListener("focusin", syncViewport);
    document.addEventListener("focusout", syncViewport);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      document.removeEventListener("focusin", syncViewport);
      document.removeEventListener("focusout", syncViewport);
      document.body.classList.remove("software-keyboard-open");
      root.style.removeProperty("--visual-viewport-height");
      root.style.removeProperty("--visual-viewport-offset-top");
    };
  }, []);
}
