import type { NextConfig } from "next";

const configuredDevOrigins = process.env.KALENDER_ALLOWED_DEV_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean) ?? [];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.178.49", ...configuredDevOrigins],
  serverExternalPackages: ["@electric-sql/pglite", "imapflow", "nodemailer", "postal-mime"],
};

export default nextConfig;
