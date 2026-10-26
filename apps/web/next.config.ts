import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4080';

const config: NextConfig = {
  output: 'standalone',
  // Monorepo root, so the standalone build includes workspace packages (next runs from apps/web).
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  transpilePackages: ['@openbus/core'],
  poweredByHeader: false,
  // The browser talks to the same origin; Next proxies API calls (no CORS, one public port).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
