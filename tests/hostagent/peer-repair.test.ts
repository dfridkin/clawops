// The host agent keeping the fleet firewall table in place (ADR 0015 §4). What a real kernel does
// when the table is flushed under a running agent is the fleet e2e suite's question; this one asks
// whether the agent restores exactly the table install wrote, says so, and keeps quiet otherwise.

import { describe, it, expect } from 'vitest'
import type { SshExecResult, SshSession } from '../../src/transport/ssh.js'
import { repairPeerTable, watchPeerTable, PEER_TABLE_LOAD_CMD, type RepairOutcome } from '../../src/hostagent/peer-repair.js'
import { peerTable } from '../../src/hostagent/peer-firewall.js'
import { listing, UID } from '../helpers/peer-table.js'

/** A host whose kernel holds `table` (empty: none), and whose nft loads what it is given unless told to fail. */
class FakeKernel {
  loads: Array<{ cmd: string; contents: string }> = []
  constructor(public table: string, private load: Partial<SshExecResult> & { holds?: string } = {}) {}

  session(): SshSession {
    const ok = (r: Partial<SshExecResult>): SshExecResult => ({ stdout: '', stderr: '', code: 0, ...r })
    return {
      exec: async (cmd: string) => (/nft list table inet clawops_peer/.test(cmd) ? ok(this.table ? { stdout: this.table } : { code: 1 }) : ok({})),
      execWithInput: async (cmd: string, input: NodeJS.ReadableStream) => {
        const chunks: Buffer[] = []
        for await (const c of input) chunks.push(Buffer.from(c as Buffer))
        this.loads.push({ cmd, contents: Buffer.concat(chunks).toString('utf-8') })
        if ((this.load.code ?? 0) === 0) this.table = this.load.holds ?? listing()
        return ok(this.load)
      },
      stream: async () => { throw new Error('not used') },
      tunnel: async () => { throw new Error('not used') },
      close: () => {},
    } as unknown as SshSession
  }
}

describe('repairPeerTable', () => {
  it('leaves a table that is the one install loaded alone', async () => {
    const k = new FakeKernel(listing())
    expect(await repairPeerTable(k.session(), UID)).toEqual({ kind: 'ok' })
    expect(k.loads).toEqual([])
  })

  it('puts back a missing table, generated from the uid install recorded, without writing under /etc', async () => {
    const k = new FakeKernel('')
    const r = await repairPeerTable(k.session(), UID)
    expect(r).toEqual({ kind: 'repaired', was: expect.stringMatching(/is missing/) })
    expect(k.loads).toHaveLength(1)
    expect(k.loads[0]!.contents).toBe(peerTable(UID))
    // Both measured on the fleet e2e host: the agent's unit has /etc read-only
    // (ProtectSystem=strict), and nft refuses a pipe for -f ("Not a regular file: /dev/stdin").
    expect(k.loads[0]!.cmd).toBe(PEER_TABLE_LOAD_CMD)
    expect(k.loads[0]!.cmd).not.toMatch(/\/etc\/|nft -f -/)
  })

  it('replaces a table someone opened with a rule ahead of the drops', async () => {
    const opened = listing(UID, (l) => [...l.slice(0, 3), '\t\tiifname "docker0" accept', ...l.slice(3)])
    const k = new FakeKernel(opened)
    expect(await repairPeerTable(k.session(), UID)).toEqual({ kind: 'repaired', was: expect.stringMatching(/has been changed/) })
    expect(k.loads[0]!.contents).toBe(peerTable(UID))
  })

  it('reports a load nft refuses, with nft\'s reason', async () => {
    const k = new FakeKernel('', { code: 1, stderr: 'Error: Could not process rule: No such file or directory' })
    expect(await repairPeerTable(k.session(), UID)).toEqual({
      kind: 'failed', was: expect.stringMatching(/is missing/), failure: expect.stringMatching(/nft could not load it: Error: Could not process rule/),
    })
  })

  it('does not call a load repaired unless the kernel then holds the right table', async () => {
    // nft exits 0, but what the kernel lists afterwards is still not the table: a mutation-check
    // that a repair is judged by reading back, not by nft's exit code.
    const k = new FakeKernel('', { code: 0, holds: listing(1001) })
    expect(await repairPeerTable(k.session(), UID)).toMatchObject({ kind: 'failed', failure: expect.stringMatching(/has been changed/) })
  })
})

describe('watchPeerTable', () => {
  async function run(outcomes: Array<RepairOutcome | Error>): Promise<Array<Exclude<RepairOutcome, { kind: 'ok' }>>> {
    const reported: Array<Exclude<RepairOutcome, { kind: 'ok' }>> = []
    const ac = new AbortController()
    let i = 0
    await watchPeerTable({
      repair: async () => {
        const o = outcomes[i++]!
        if (i >= outcomes.length) ac.abort()
        if (o instanceof Error) throw o
        return o
      },
      report: (o) => reported.push(o),
    }, { intervalMs: 0, signal: ac.signal })
    return reported
  }

  const missing = 'The firewall table inet clawops_peer is missing.'

  it('reports every repair and nothing while the table holds', async () => {
    const r = await run([{ kind: 'ok' }, { kind: 'repaired', was: missing }, { kind: 'ok' }, { kind: 'repaired', was: missing }])
    expect(r).toEqual([{ kind: 'repaired', was: missing }, { kind: 'repaired', was: missing }])
  })

  it('reports a failure that repeats once, and again when its reason changes or after it clears', async () => {
    const f1 = { kind: 'failed', was: missing, failure: 'nft could not load it: a' } as const
    const f2 = { kind: 'failed', was: missing, failure: 'nft could not load it: b' } as const
    const r = await run([f1, f1, f1, f2, { kind: 'ok' }, f2])
    expect(r).toEqual([f1, f2, f2])
  })

  it('keeps going past a check that throws, and reports it as a failure', async () => {
    const r = await run([new Error('bash: nft: command not found'), { kind: 'repaired', was: missing }])
    expect(r).toEqual([
      { kind: 'failed', was: 'the table could not be read', failure: 'bash: nft: command not found' },
      { kind: 'repaired', was: missing },
    ])
  })
})
