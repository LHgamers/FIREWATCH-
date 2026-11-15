/** @type {import('next').NextConfig} */
const ENGINE_URL = process.env.ENGINE_URL || "http://127.0.0.1:8010";

const nextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
    // The local Python "ask" endpoint can take >30s to ingest the corpus
    // (multiple concurrent HTTP fetches to NASA/NOAA endpoints) before it
    // even begins composing the answer. The App Router's default proxy
    // timeout is 30s and aborts with a fetch-failed error if the upstream
    // hasn't responded yet, which makes /api/ask look broken even though
    // the engine is still working. Bump the proxy timeout so the request
    // is allowed to complete and a slow but honest answer is delivered.
    proxyTimeout: 180000,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${ENGINE_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
