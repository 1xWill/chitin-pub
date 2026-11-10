import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // This repo is a workspace; ensure tracing doesn't jump to an unrelated lockfile.
  outputFileTracingRoot: path.join(__dirname, '..', '..')
};

export default nextConfig;
