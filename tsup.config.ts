import { defineConfig } from 'tsup'
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs'

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
    // tsup bundles TypeScript only. The local-provider bootstrap template is read at
    // runtime from beside the module, so it has to be copied in — without this,
    // `clawops up` on the local provider throws ENOENT from an installed package.
    onSuccess: async () => {
      mkdirSync('dist', { recursive: true })
      copyFileSync('src/providers/local/bootstrap.sh.tmpl', 'dist/bootstrap.sh.tmpl')
    },
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
