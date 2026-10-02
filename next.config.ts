import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  poweredByHeader: false,
  // PGlite ships a WASM binary that must not be bundled into the server build.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
