"use client";

import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState, type PointerEvent } from "react";

import { invokeDesktop, usesNativeDesktopFrame, waitForDesktopApp } from "@/lib/desktop-bridge";

export function DesktopWindowControls() {
  const [available, setAvailable] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    const syncMaximized = () => {
      void invokeDesktop<boolean>("desktop_window_is_maximized")
        .then((nextMaximized) => {
          if (!disposed) setMaximized(nextMaximized);
        })
        .catch(() => undefined);
    };
    void waitForDesktopApp().then(async (desktopAvailable) => {
      if (!desktopAvailable || disposed) return;
      if (usesNativeDesktopFrame()) return;
      document.documentElement.classList.add("desktop-window");
      setAvailable(true);
      window.addEventListener("resize", syncMaximized);
      syncMaximized();
    });
    return () => {
      disposed = true;
      window.removeEventListener("resize", syncMaximized);
      document.documentElement.classList.remove("desktop-window");
    };
  }, []);

  if (!available) return null;

  const toggleMaximized = async () => {
    try {
      setMaximized(await invokeDesktop<boolean>("desktop_window_toggle_maximized"));
    } catch (error) {
      console.warn("Desktop window maximize command failed", error);
    }
  };
  const runWindowCommand = async (command: "desktop_window_minimize" | "desktop_window_close") => {
    try {
      await invokeDesktop(command);
    } catch (error) {
      console.warn(`Desktop window command failed: ${command}`, error);
    }
  };
  const startDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) return;
    void invokeDesktop("desktop_window_start_dragging").catch(() => undefined);
  };

  return (
    <div className="desktop-window-command-area">
      <div
        className="desktop-window-drag-region"
        aria-label="Kalender-Fenster ziehen"
        title="Ziehen Sie Fenster, doppelklicken Sie, um zu maximieren"
        onDoubleClick={() => void toggleMaximized()}
        onPointerDown={startDragging}
      />
      <div className="desktop-window-controls" aria-label="Fenstersteuerung">
        <button type="button" aria-label="Minimierung" title="Minimierung" onPointerDown={(event) => event.stopPropagation()} onClick={() => void runWindowCommand("desktop_window_minimize")}>
          <Minus size={16} strokeWidth={1.7} />
        </button>
        <button type="button" aria-label={maximized ? "Wiederherstellen" : "Maximieren"} title={maximized ? "Wiederherstellen" : "Maximieren"} onPointerDown={(event) => event.stopPropagation()} onClick={() => void toggleMaximized()}>
          {maximized ? <Copy size={13} strokeWidth={1.7} /> : <Square size={12} strokeWidth={1.7} />}
        </button>
        <button className="desktop-window-close" type="button" aria-label="Schließen" title="Schließen" onPointerDown={(event) => event.stopPropagation()} onClick={() => void runWindowCommand("desktop_window_close")}>
          <X size={16} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}
