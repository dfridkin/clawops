#!/usr/bin/env tsx
// scripts/scaffold-provider.ts
// Scaffolds a new provider adapter directory.
// Used by the /add-provider skill.
// Usage: tsx scripts/scaffold-provider.ts <name>

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const name = process.argv[2]
if (!name || !['aws', 'gcp', 'azure', 'local'].includes(name)) {
  console.error('Usage: tsx scripts/scaffold-provider.ts <aws|gcp|azure|local>')
  process.exit(1)
}

const dir = join(root, 'src/providers', name)
if (existsSync(dir)) {
  console.error(`Provider directory already exists: ${dir}`)
  process.exit(1)
}

mkdirSync(dir, { recursive: true })

writeFileSync(
  join(dir, 'index.ts'),
  `// src/providers/${name}/index.ts
// ${name.toUpperCase()} provider adapter — implement ProviderAdapter interface.

import type { ProviderAdapter } from '../types'

const adapter: ProviderAdapter = {
  name: '${name}',
  program: async () => {
    throw new Error('${name} provider: program not yet implemented')
  },
  getConnectionInfo: () => {
    throw new Error('${name} provider: getConnectionInfo not yet implemented')
  },
  normalizeInstanceType: () => {
    throw new Error('${name} provider: normalizeInstanceType not yet implemented')
  },
  defaultRegion: () => {
    throw new Error('${name} provider: defaultRegion not yet implemented')
  },
  stateBackendUrl: () => {
    throw new Error('${name} provider: stateBackendUrl not yet implemented')
  },
  validateConfig: async () => ({ ok: false, errors: ['${name} provider: not yet implemented'] }),
}

export default adapter
`,
)

console.log(`Scaffolded provider: src/providers/${name}/index.ts`)
console.log('Next steps:')
console.log('  1. Implement each method in the adapter')
console.log('  2. Register in src/providers/index.ts')
console.log('  3. Add docs/providers/${name}.md')
console.log('  4. Run pnpm test')
