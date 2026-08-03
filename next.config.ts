import type { NextConfig } from "next";

// Inside Docker, Next.js reaches Grafana via the service name on the internal
// network. Outside Docker (local dev), fall back to the exposed host port.
const grafanaInternalUrl = process.env.GRAFANA_INTERNAL_URL ?? "http://grafana:3000";

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/grafana/:path*',
        destination: `${grafanaInternalUrl}/grafana/:path*`,
      },
    ];
  },
};

export default nextConfig;
