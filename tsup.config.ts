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
    // The host agent (ADR 0014), with its dependencies inlined: `agent install` copies this
    // directory to the gateway host, where there is a Node runtime and nothing else. The
    // cloud SDKs are left out. Host-agent mode never reaches them (it holds no Pulumi state
    // and no cloud credentials), and tests/hostagent/bundle.test.ts runs the build with them
    // absent to prove it.
    //
    // Split into chunks, not one file. Without splitting, esbuild inlines every lazily
    // imported module and hoists that module's static imports to the top of the file, so a
    // `@pulumi/pulumi` import that only `up` reaches would be loaded at start, and fail.
    entry: { 'host-agent': 'src/hostagent/main.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: false,
    shims: true,
    outDir: 'dist/host-agent',
    outExtension: () => ({ js: '.mjs' }),
    splitting: true,
    define: { __CLI_VERSION__: JSON.stringify(version) },
    // Everything is inlined except native addons. ssh2 tries
    // `require('./crypto/build/Release/sshcrypto.node')` inside a try and falls back to
    // JavaScript, and the host agent never opens SSH. Left to tsup's native-module plugin, an
    // addon that was never compiled fails the build: the Docker build has no Python for
    // node-gyp. tsup's external plugin runs before that one, so it has to claim them there.
    noExternal: [/^(?!.*\.node$)/],
    external: [/\.node$/],
    // Set on esbuild itself: tsup's noExternal wins over its own `external`.
    esbuildOptions(o) {
      o.external = ['*.node', '@pulumi/*', '@aws-sdk/*', '@smithy/*', 'google-auth-library', 'inquirer', 'cpu-features']
    },
    // esbuild's ESM output still calls require() for CommonJS dependencies; give it one.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
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
