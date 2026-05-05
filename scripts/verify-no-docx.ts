#!/usr/bin/env tsx
// scripts/verify-no-docx.ts
// CI check: fail if any .docx files exist in the repo. Per R-meta-2.

import { execSync } from 'node:child_process'
import process from 'node:process'

const result = execSync(
  'find . -name "*.docx" -not -path "./node_modules/*" -not -path "./.git/*"',
  { encoding: 'utf-8', cwd: process.cwd() },
)

if (result.trim()) {
  console.error('R-meta-2 violation: .docx files found in repository:')
  console.error(result)
  console.error('Convert to Markdown and remove the .docx files.')
  process.exit(1)
}

console.log('verify-no-docx: clean')
