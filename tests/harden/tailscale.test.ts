// Unit tests for the Tailscale module. The pure helpers are exercised directly; apply() and
// check() drive a fake exec, so nothing runs and no key leaves the process.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RemoteExec } from '../../src/harden/types.js'
import {
  parseStatus,
  isTailscaleIpv4,
  tailnetHostname,
  redactKey,
  makeTailscaleModule,
  AUTH_KEY_SECRET,
} from '../../src/harden/modules/tailscale.js'

beforeEach(() => vi.resetModules())

/** An exec that answers by pattern, and records everything it was asked to run. */
function fakeExec(
  answers: Array<[RegExp, string]>,
): RemoteExec & { calls: string[]; stdins: Array<string | undefined> } {
  const calls: string[] = []
  const stdins: Array<string | undefined> = []
  const exec = (async (cmd: string, opts?: { stdin?: string }) => {
    calls.push(cmd)
    stdins.push(opts?.stdin)
    const hit = answers.find(([re]) => re.test(cmd))
    return { stdout: hit ? hit[1] : '', stderr: '', code: 0 }
  }) as RemoteExec & { calls: string[]; stdins: Array<string | undefined> }
  exec.calls = calls
  exec.stdins = stdins
  return exec
}

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { TailscaleIPs: ['100.101.102.103', 'fd7a:115c::1'], HostName: 'clawops-prod' },
})

describe('status parsing', () => {
  it('takes the IPv4 out of a list that also carries IPv6', () => {
    expect(parseStatus(RUNNING).ipv4).toBe('100.101.102.103')
  })
  it('reads the backend state', () => {
    expect(parseStatus(RUNNING).state).toBe('Running')
  })
  it('reports unparseable output as unknown rather than guessing', () => {
    // "not on the network" and "could not tell" lead to different actions.
    expect(parseStatus('tailscale: command not found').state).toBe('unknown')
  })
  it('a host that needs login has no address', () => {
    expect(parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { TailscaleIPs: [] } })).ipv4).toBeUndefined()
  })
})

describe('the address is checked, not assumed', () => {
  // `tailscale ip -4` prints nothing on a host that is not up, and an empty string reaching a
  // config rewrite as "the new SSH host" is a lockout.
  it('accepts the CGNAT range Tailscale hands out', () => {
    expect(isTailscaleIpv4('100.64.0.1')).toBe(true)
    expect(isTailscaleIpv4('100.127.255.254')).toBe(true)
  })
  it('rejects a public address that merely starts with 100', () => {
    expect(isTailscaleIpv4('100.63.0.1')).toBe(false)
    expect(isTailscaleIpv4('100.128.0.1')).toBe(false)
  })
  it('rejects an empty string', () => {
    expect(isTailscaleIpv4('')).toBe(false)
  })
  it('rejects an octet over 255', () => {
    expect(isTailscaleIpv4('100.999.0.1')).toBe(false)
  })
  it('rejects a LAN address', () => {
    expect(isTailscaleIpv4('192.168.1.10')).toBe(false)
  })
})

describe('the tailnet hostname', () => {
  it('prefixes the stack name', () => {
    expect(tailnetHostname('prod')).toBe('clawops-prod')
  })
  it('strips what a DNS label cannot carry', () => {
    expect(tailnetHostname('My Stack_01')).toBe('clawops-my-stack-01')
  })
  it('copes with the trailing newline a remote `hostname` returns', () => {
    expect(tailnetHostname('box-7\n')).toBe('clawops-box-7')
  })
  it('never exceeds a DNS label', () => {
    expect(tailnetHostname('x'.repeat(200)).length).toBeLessThanOrEqual(63)
  })
  it('falls back rather than emitting a bare prefix', () => {
    expect(tailnetHostname('!!!')).toBe('clawops-stack')
  })
})

describe('the auth key never reaches output', () => {
  it('redacts the key wherever it appears', () => {
    expect(redactKey('failed with tskey-abc123 twice: tskey-abc123', 'tskey-abc123')).toBe(
      'failed with [redacted] twice: [redacted]',
    )
  })
  it('leaves text alone when there is no key', () => {
    expect(redactKey('nothing to hide', '')).toBe('nothing to hide')
  })
})

describe('check()', () => {
  const mod = makeTailscaleModule('prod')

  it('reports missing when the binary is absent', async () => {
    const r = await mod.check(fakeExec([[/command -v tailscale/, 'no']]))
    expect(r.status).toBe('missing')
    expect(r.detail).toContain('not installed')
  })

  it('reports applied with the address once joined', async () => {
    const r = await mod.check(fakeExec([[/command -v tailscale/, 'yes'], [/tailscale status/, RUNNING]]))
    expect(r.status).toBe('applied')
    expect(r.detail).toContain('100.101.102.103')
  })

  it('installed but not joined is missing, and names the state', async () => {
    const r = await mod.check(
      fakeExec([[/command -v tailscale/, 'yes'], [/tailscale status/, JSON.stringify({ BackendState: 'NeedsLogin' })]]),
    )
    expect(r.status).toBe('missing')
    expect(r.detail).toContain('NeedsLogin')
  })

  it('unparseable status is drift, not absence', async () => {
    const r = await mod.check(fakeExec([[/command -v tailscale/, 'yes'], [/tailscale status/, 'garbage']]))
    expect(r.status).toBe('drifted')
  })
})

describe('apply()', () => {
  it('does nothing without a key, and says where to put one', async () => {
    vi.doMock('../../src/config/secrets.js', () => ({ resolveSecretRef: () => null }))
    const { makeTailscaleModule: make } = await import('../../src/harden/modules/tailscale.js')
    const r = await make('prod').apply(fakeExec([]))
    expect(r.changed).toBe(false)
    expect(r.detail).toContain(AUTH_KEY_SECRET)
  })

  it('puts the key in no command string at all, only on stdin', async () => {
    /*
     * Both exposures. The key must not be a `tailscale up` argument, and it must not be
     * anywhere in the command string either: sshd runs that string as `$SHELL -c '<string>'`,
     * so a key embedded in it — in a heredoc, say — lands in the outer shell's argv. A process
     * snapshot taken while an earlier version ran showed exactly that.
     */
    vi.doMock('../../src/config/secrets.js', () => ({ resolveSecretRef: () => 'tskey-SECRET' }))
    const { makeTailscaleModule: make } = await import('../../src/harden/modules/tailscale.js')
    const exec = fakeExec([[/command -v tailscale/, 'yes'], [/tailscale status/, RUNNING]])
    await make('prod').apply(exec)
    expect(exec.calls.some((c) => c.includes('tskey-SECRET'))).toBe(false)
    expect(exec.calls.some((c) => c.includes('--auth-key=file:'))).toBe(true)
    expect(exec.stdins).toContain('tskey-SECRET')
  })

  it('reports the address it joined on, and that nothing has been repointed', async () => {
    vi.doMock('../../src/config/secrets.js', () => ({ resolveSecretRef: () => 'tskey-SECRET' }))
    const { makeTailscaleModule: make } = await import('../../src/harden/modules/tailscale.js')
    const r = await make('prod').apply(fakeExec([[/command -v tailscale/, 'yes'], [/tailscale status/, RUNNING]]))
    expect(r.detail).toContain('100.101.102.103')
    expect(r.detail).toContain('nothing has been pointed at the new one')
  })

  it('keeps the key out of a failure message, even when the output echoes it back', async () => {
    // The key is passed by file and should never come back. This is the belt-and-braces path:
    // a leaked auth key is a machine someone else can add to the tailnet.
    vi.doMock('../../src/config/secrets.js', () => ({ resolveSecretRef: () => 'tskey-SECRET' }))
    const { makeTailscaleModule: make } = await import('../../src/harden/modules/tailscale.js')
    const r = await make('prod').apply(
      fakeExec([
        [/command -v tailscale/, 'yes'],
        [/--auth-key=file:/, 'invalid key tskey-SECRET rejected'],
        [/tailscale status/, JSON.stringify({ BackendState: 'NeedsLogin' })],
      ]),
    )
    expect(r.detail).not.toContain('tskey-SECRET')
    expect(r.detail).toContain('[redacted]')
  })

  it('removes the staged key file even if the command is interrupted', async () => {
    vi.doMock('../../src/config/secrets.js', () => ({ resolveSecretRef: () => 'tskey-SECRET' }))
    const { makeTailscaleModule: make } = await import('../../src/harden/modules/tailscale.js')
    const exec = fakeExec([[/command -v tailscale/, 'yes'], [/tailscale status/, RUNNING]])
    await make('prod').apply(exec)
    const join = exec.calls.find((c) => c.includes('--auth-key=file:')) ?? ''
    expect(join).toContain('trap')
    expect(join).toContain('umask 077')
  })
})
