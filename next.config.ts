import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,

    output: "export",
    // 2. Disable image optimization (Tauri doesn't have the server for it)
    images: {
        unoptimized: true,
    },

    // 3. Optional: Helpful for Tauri's internal routing
    trailingSlash: true,
    typescript: {
        ignoreBuildErrors: true,
    }
};

export default nextConfig;


