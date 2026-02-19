import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Next.js 15 — App Router, streaming enabled by default
  // File upload size is controlled via route config or middleware
  serverExternalPackages: ['js-tiktoken'],
}

export default nextConfig
