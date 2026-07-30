"use client";

import { useEffect, useRef } from "react";

import { useSyncSettings } from "@/components/sync-settings-context";

export const LIVE_DATA_REFRESH_INTERVAL_MS = 15_000;

export function useVisiblePageRefresh(
  refresh: () => void | Promise<void>,
  intervalMs = LIVE_DATA_REFRESH_INTERVAL_MS,
) {
  const { settings } = useSyncSettings();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const followsWorkspaceSettings = intervalMs === LIVE_DATA_REFRESH_INTERVAL_MS;
  const enabled = followsWorkspaceSettings ? settings.clientRefreshEnabled : true;
  const effectiveIntervalMs = followsWorkspaceSettings ? settings.clientRefreshIntervalMs : intervalMs;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let running = false;

    const run = () => {
      if (!active || running || document.visibilityState === "hidden") return;
      running = true;
      void Promise.resolve(refreshRef.current())
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") run();
    };
    const timer = window.setInterval(run, effectiveIntervalMs);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [effectiveIntervalMs, enabled]);
}
