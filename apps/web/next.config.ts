import path from "node:path";
import type { NextConfig } from "next";

const workspaceRoot = path.resolve(
  process.cwd(),
  process.cwd().endsWith(path.join("apps", "web")) ? "../.." : ".",
);

const configuredDevOrigins = process.env.KALENDER_ALLOWED_DEV_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean) ?? [];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  reactStrictMode: true,
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.178.49", ...configuredDevOrigins],
  serverExternalPackages: ["imapflow", "nodemailer", "pg", "postal-mime"],
};

export default nextConfig;
