"use client";

import { useLayoutEffect } from "react";

const THEME_MODE_KEY = "qgw.theme.mode";
const LIGHT_TONE_KEY = "qgw.theme.lightTone";
const DARK_TONE_KEY = "qgw.theme.darkTone";

type ThemeMode = "system" | "light" | "dark";

function applyTheme() {
  const mode = safeMode(window.localStorage.getItem(THEME_MODE_KEY));
  const lightTone = safeLightTone(window.localStorage.getItem(LIGHT_TONE_KEY));
  const darkTone = safeDarkTone(window.localStorage.getItem(DARK_TONE_KEY));
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const scheme = mode === "system" ? prefersDark ? "dark" : "light" : mode;
  const theme = scheme === "dark" ? darkTone : lightTone;
  const root = document.documentElement;
  root.dataset.qgwThemeMode = mode;
  root.dataset.qgwScheme = scheme;
  root.dataset.qgwTheme = theme;
  root.classList.toggle("dark", scheme === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", scheme === "dark" ? "#111312" : "#f5f7f8");
}

export function ThemeController() {
  useLayoutEffect(() => {
    applyTheme();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme();
    media.addEventListener("change", onChange);
    window.addEventListener("storage", onChange);
    window.addEventListener("qgw-theme-change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("qgw-theme-change", onChange);
    };
  }, []);

  return null;
}

export function saveThemePreference(input: {
  readonly mode: ThemeMode;
  readonly lightTone: "light-fog" | "light-warm" | "light-blue";
  readonly darkTone: "dark-pro";
}) {
  window.localStorage.setItem(THEME_MODE_KEY, input.mode);
  window.localStorage.setItem(LIGHT_TONE_KEY, input.lightTone);
  window.localStorage.setItem(DARK_TONE_KEY, input.darkTone);
  applyTheme();
  window.dispatchEvent(new Event("qgw-theme-change"));
}

export function readThemePreference() {
  if (typeof window === "undefined") {
    return { mode: "system" as ThemeMode, lightTone: "light-fog" as const, darkTone: "dark-pro" as const };
  }
  return {
    mode: safeMode(window.localStorage.getItem(THEME_MODE_KEY)),
    lightTone: safeLightTone(window.localStorage.getItem(LIGHT_TONE_KEY)),
    darkTone: safeDarkTone(window.localStorage.getItem(DARK_TONE_KEY)),
  };
}

function safeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function safeLightTone(value: string | null): "light-fog" | "light-warm" | "light-blue" {
  return value === "light-warm" || value === "light-blue" || value === "light-fog" ? value : "light-fog";
}

function safeDarkTone(value: string | null): "dark-pro" {
  return "dark-pro";
}
