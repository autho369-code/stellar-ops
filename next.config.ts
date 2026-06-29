import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Allow larger AppFolio CSV uploads through the Sync server action.
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
