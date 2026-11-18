import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Les rendus FFmpeg peuvent dépasser la limite par défaut des Server Actions.
    serverActions: { bodySizeLimit: "512mb" },
  },
  // ffmpeg/ffprobe sont appelés en child_process : ne pas bundler.
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
