// A preview that would destroy the instance used to summarise as "0 to create, 0 to update,
// 0 to delete". Pulumi marks a replacement with two characters, `+-`, and the parser matched
// only single-character ops, so the most destructive operation it has was the one the plan did
// not mention. These tests cover both the parse and what the operator is told.

import { describe, it, expect } from 'vitest'
import { parseDiffForTest } from '../../src/plan/generate.js'

/** parseDiff always returns a diff; the field is optional only on a persisted plan. */
const parse = (lines: string[]) => parseDiffForTest(lines)!
import { disruptionWarnings } from '../../src/cli/commands/plan.js'

const ref = (type: string, name: string) => ({ urn: `urn:pulumi:::clawops::${type}::${name}`, type, name })

describe('a replacement is visible in the diff', () => {
  it('counts a +- line instead of dropping it', () => {
    const d = parse(['+-  gcp:compute:Instance  clawops-instance  replace'])
    expect(d.replace).toHaveLength(1)
    expect(d.replace[0]?.name).toBe('clawops-instance')
    expect(d.totalChanges).toBe(1)
  })

  it('counts -+ as well, which is how Pulumi prints a delete-before-replace', () => {
    expect(parse(['-+  gcp:compute:Instance  clawops-instance  replace']).replace).toHaveLength(1)
  })

  it('does not confuse a replacement for a create', () => {
    const d = parse(['+-  gcp:compute:Instance  clawops-instance'])
    expect(d.create).toEqual([])
    expect(d.delete).toEqual([])
  })

  it('still reads the ordinary operations', () => {
    const d = parse([
      '+   gcp:compute:Network   clawops-network',
      '~   gcp:compute:Instance  clawops-instance',
      '-   gcp:compute:Address   clawops-address',
    ])
    expect([d.create.length, d.update.length, d.delete.length, d.replace.length]).toEqual([1, 1, 1, 0])
    expect(d.totalChanges).toBe(3)
  })
})

describe('what the operator is warned about', () => {
  const empty = { create: [], update: [], delete: [], replace: [], totalChanges: 0 }

  it('says nothing for a first deploy', () => {
    expect(disruptionWarnings({ ...empty, create: [ref('gcp:compute:Instance', 'i')], totalChanges: 1 }))
      .toEqual([])
  })

  it('names the state a replaced instance takes with it', () => {
    const w = disruptionWarnings({ ...empty, replace: [ref('gcp:compute:Instance', 'clawops-instance')], totalChanges: 1 })
    expect(w[0]).toContain('REPLACES')
    expect(w[0]).toContain('destroys its boot disk')
    expect(w[0]).toContain('clawops backup create')
  })

  it('does not claim a disk is lost when the replaced resource is not the instance', () => {
    const w = disruptionWarnings({ ...empty, replace: [ref('gcp:compute:Address', 'clawops-address')], totalChanges: 1 })
    expect(w[0]).toContain('REPLACES')
    expect(w[0]).not.toContain('boot disk')
  })

  it('warns that an instance update stops the machine, and that disk state survives', () => {
    const w = disruptionWarnings({
      ...empty,
      update: [{ resource: ref('gcp:compute:Instance', 'clawops-instance'), before: null, after: null }],
      totalChanges: 1,
    })
    expect(w[0]).toContain('gateway')
    expect(w[0]).toContain('State on disk is kept')
  })

  it('reports a deletion', () => {
    const w = disruptionWarnings({ ...empty, delete: [ref('gcp:compute:Address', 'a')], totalChanges: 1 })
    expect(w.some((l) => l.includes('DELETES'))).toBe(true)
  })

  it('tolerates a plan written before replace existed', () => {
    const legacy = { create: [], update: [], delete: [], totalChanges: 0 } as never
    expect(() => disruptionWarnings(legacy)).not.toThrow()
  })
})
