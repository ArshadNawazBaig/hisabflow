import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  webpack(config, { webpack }) {
    // Workers retain their native bindings; Next runs with server environment
    // variables and the portable storage adapters on Vercel.
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /^cloudflare:workers$/,
      path.join(process.cwd(), "lib/server/vercel-env.ts"),
    ));
    return config;
  },
};

export default nextConfig;
