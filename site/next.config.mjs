import { createMDX } from 'fumadocs-mdx/next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    // This app is intentionally not part of the CLI's pnpm project — it has its own
    // package.json and lockfile. Without this, Next walks up, finds the repo's
    // lockfile too, and infers the wrong workspace root.
    root: dirname(fileURLToPath(import.meta.url)),
  },
}

export default withMDX(nextConfig)
