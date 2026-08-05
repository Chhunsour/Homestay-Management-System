import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @homestay/shared ships raw TypeScript on purpose (no build step).
  transpilePackages: ['@homestay/shared'],
  typedRoutes: false,
};

export default config;
