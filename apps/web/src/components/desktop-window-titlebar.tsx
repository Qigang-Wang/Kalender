"use client";

import { Copy, Maximize2, Minus, X } from "lucide-react";
import { useEffect, useState, type PointerEvent } from "react";

import { invokeDesktop, waitForDesktopApp } from "@/lib/desktop-bridge";

export function DesktopWindowTitlebar() {
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
  const runWindowCommand = (command: "desktop_window_minimize" | "desktop_window_close") => {
    void invokeDesktop(command).catch((error) => {
      console.warn(`Desktop window command failed: ${command}`, error);
    });
  };
  const startDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) return;
    void invokeDesktop("desktop_window_start_dragging").catch(() => undefined);
  };

  return (
    <header className="desktop-window-titlebar">
      <div
        className="desktop-window-drag-region"
        aria-label="拖动 Kalender 窗口"
        onDoubleClick={() => void toggleMaximized()}
        onPointerDown={startDragging}
      >
        <span>Kalender</span>
      </div>
      <div className="desktop-window-controls" aria-label="窗口控制">
        <button type="button" aria-label="最小化" title="最小化" onClick={() => runWindowCommand("desktop_window_minimize")}>
          <Minus size={16} strokeWidth={1.7} />
        </button>
        <button type="button" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={() => void toggleMaximized()}>
          {maximized ? <Copy size={13} strokeWidth={1.7} /> : <Maximize2 size={14} strokeWidth={1.7} />}
        </button>
        <button className="desktop-window-close" type="button" aria-label="关闭" title="关闭" onClick={() => runWindowCommand("desktop_window_close")}>
          <X size={16} strokeWidth={1.7} />
        </button>
      </div>
    </header>
  );
}
