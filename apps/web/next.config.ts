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
  experimental: {
    // Allow a 100 MB file plus multipart form overhead through the auth proxy.
    proxyClientMaxBodySize: "101mb",
  },
  allowedDevOrigins: ["127.0.0.1", "localhost", ...configuredDevOrigins],
  serverExternalPackages: ["imapflow", "nodemailer", "pg", "postal-mime"],
};

export default nextConfig;
