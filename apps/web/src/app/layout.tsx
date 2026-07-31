import type { Metadata, Viewport } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeController } from "@/components/theme-controller";
import { AppDialogProvider } from "@/components/app-dialog-provider";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  applicationName: "Dayline",
  title: "Dayline",
  description: "Dayline 统一管理邮箱、日历、任务和笔记",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: "/icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#111312",
};

const themeBootstrapScript = `
(() => {
  try {
    const mode = ["light", "dark", "system"].includes(localStorage.getItem("qgw.theme.mode")) ? localStorage.getItem("qgw.theme.mode") : "system";
    const storedLightTone = localStorage.getItem("qgw.theme.lightTone");
    const lightTone = ["light-fog", "light-warm", "light-blue"].includes(storedLightTone) ? storedLightTone : "light-fog";
    const darkTone = "dark-pro";
    const scheme = mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
    const theme = scheme === "dark" ? darkTone : lightTone;
    const root = document.documentElement;
    root.dataset.qgwThemeMode = mode;
    root.dataset.qgwScheme = scheme;
    root.dataset.qgwTheme = theme;
    root.classList.toggle("dark", scheme === "dark");
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", scheme === "dark" ? "#111312" : "#f5f7f8");
  } catch {
    document.documentElement.dataset.qgwThemeMode = "system";
    document.documentElement.dataset.qgwScheme = "dark";
    document.documentElement.dataset.qgwTheme = "dark-pro";
    document.documentElement.classList.add("dark");
  }
})();
`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <head>
        <Script id="qgw-theme-bootstrap" strategy="beforeInteractive">{themeBootstrapScript}</Script>
      </head>
      <body>
        <ThemeController />
        <TooltipProvider>
          <AppDialogProvider>{children}</AppDialogProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
