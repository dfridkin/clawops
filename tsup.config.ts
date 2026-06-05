import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
    shims: true,
    outDir: 'dist',
    // Inline the package version at build time so runtime require() isn't needed.
    define: { __CLI_VERSION__: JSON.stringify(version) },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    dts: true,
    clean: false,
    outDir: 'dist',
  },
])
