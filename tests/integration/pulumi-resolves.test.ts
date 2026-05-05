// Integration test: verifies Pulumi Automation API resolves correctly.
// Per ADR 0003 — run separately, not part of default `pnpm test`.
// Run with: pnpm vitest run tests/integration

import { describe, it, expect } from 'vitest'
import { LocalWorkspace } from '@pulumi/pulumi/automation'

describe('Pulumi Automation API resolution', () => {
  it('LocalWorkspace.create succeeds (smoke test for pnpm hoisting)', async () => {
    const ws = await LocalWorkspace.create({
      projectSettings: { name: 'clawops-hoisting-test', runtime: 'nodejs' },
    })
    expect(ws).toBeDefined()
  })
})
