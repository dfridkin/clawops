// Privilege escalation for remote Docker commands.
//
// Found by running the real provisioning script on a real EC2 host (SP-11 tier 3): clawops
// connects to AWS as `ubuntu`, which is not in the docker group, so every Docker command
// returned "permission denied while trying to connect to the Docker daemon socket". GCP and
// Azure connect as `clawops`, which is in the group — which is why only AWS broke.

import { describe, it, expect, vi } from 'vitest'
import {
  shellQuote, sudoWrap, execPrivileged, streamPrivileged, resetPrivilegeCache,
} from '../../src/transport/privileged.js'
import type { SshSession, SshExecResult } from '../../src/transport/ssh.js'

const DENIED: SshExecResult = {
  stdout: '',
  stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
  code: 1,
} as SshExecResult
const OK = (stdout = ''): SshExecResult => ({ stdout, stderr: '', code: 0 }) as SshExecResult

function fakeSession(handler: (cmd: string) => SshExecResult) {
  const calls: string[] = []
  const session = {
    exec: vi.fn(async (cmd: string) => { calls.push(cmd); return handler(cmd) }),
    stream: vi.fn(async (cmd: string) => { calls.push(cmd); return {} as never }),
  } as unknown as SshSession
  return { session, calls }
}

describe('shellQuote', () => {
  it('defers expansion to the privileged shell', () => {
    // The whole point. The previous wrapper used DOUBLE quotes, so the outer shell —
    // running as the unprivileged SSH user — evaluated `$(...)` BEFORE sudo was invoked.
    // /home/clawops is mode 750, so `[ -s .../openclaw.env ]` was false for `ubuntu`, the
    // token was never attached, and the gateway exited 78 "Refusing to bind gateway to
    // auto without auth". Escalating after the substitution has happened is too late.
    const cmd = 'docker run $([ -s /home/clawops/openclaw.env ] && echo --env-file) img'
    const wrapped = sudoWrap(cmd)
    expect(wrapped.startsWith("sudo -n bash -c '")).toBe(true)
    expect(wrapped).toContain('$([ -s /home/clawops/openclaw.env ]')
    expect(wrapped).not.toContain('"')
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
    // Round-trips: the inner shell sees exactly the original string.
    expect(shellQuote("echo 'hi'")).toContain(`'\\''hi'\\''`)
  })
})

describe('execPrivileged', () => {
  it('does not escalate when the SSH user can already reach Docker (GCP, Azure)', async () => {
    const { session, calls } = fakeSession(() => OK('running'))
    const r = await execPrivileged(session, 'docker inspect openclaw')
    expect(r.stdout).toBe('running')
    expect(calls).toEqual(['docker inspect openclaw'])
    expect(calls.some((c) => c.includes('sudo'))).toBe(false)
  })

  it('escalates once on permission denied, then remembers (AWS)', async () => {
    const { session, calls } = fakeSession((cmd) => (cmd.startsWith('sudo') ? OK('ok') : DENIED))
    resetPrivilegeCache(session)

    await execPrivileged(session, 'docker inspect openclaw')
    expect(calls).toHaveLength(2)                       // direct, then sudo
    expect(calls[1]).toContain('sudo -n bash -c')

    await execPrivileged(session, 'docker logs openclaw')
    // Second call skips the doomed direct attempt: one round trip per connection, not per
    // command.
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain('sudo -n bash -c')
  })

  it('does not escalate a command that merely failed', async () => {
    // `docker inspect` on an absent container exits non-zero meaning "not there", not
    // "not allowed". Retrying that under sudo would double the round trips and blur the
    // two failures together.
    const { session, calls } = fakeSession(() => ({
      stdout: '', stderr: 'Error: No such object: openclaw', code: 1,
    }) as SshExecResult)
    resetPrivilegeCache(session)
    const r = await execPrivileged(session, 'docker inspect openclaw')
    expect(r.code).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('sudo')
  })
})

describe('streamPrivileged', () => {
  it('settles the privilege question before streaming', async () => {
    // A stream cannot be retried once it has started emitting, so it probes first.
    const { session, calls } = fakeSession((cmd) => (cmd.includes('docker version') ? DENIED : OK()))
    resetPrivilegeCache(session)
    await streamPrivileged(session, 'docker logs -f openclaw')
    expect(calls[0]).toContain('docker version')
    expect(calls[1]).toContain('sudo -n bash -c')
    expect(calls[1]).toContain('docker logs -f openclaw')
  })

  it('streams directly when no escalation is needed', async () => {
    const { session, calls } = fakeSession(() => OK('29.8.0'))
    resetPrivilegeCache(session)
    await streamPrivileged(session, 'docker logs -f openclaw')
    expect(calls[1]).toBe('docker logs -f openclaw')
  })
})

describe('every remote Docker call is routed through this module', () => {
  it('no command file invokes Docker on a raw session', async () => {
    // This is the guard that would have caught the original bug. plan/remote-config.ts had
    // the fix for two years, in one file, with a comment naming the AWS case — and nine
    // other files kept calling Docker directly. A fix applied where a bug was reported,
    // rather than across the surface it belongs to.
    const { readFileSync, readdirSync } = await import('node:fs')
    const { resolve, join } = await import('node:path')
    const root = resolve(import.meta.dirname, '../..')

    const dirs = ['src/cli/commands', 'src/mcp/tools/cli', 'src/plan']
    const offenders: string[] = []

    for (const dir of dirs) {
      for (const name of readdirSync(join(root, dir))) {
        if (!name.endsWith('.ts')) continue
        const path = join(dir, name)
        const src = readFileSync(join(root, path), 'utf8')
        const lines = src.split('\n')
        lines.forEach((line, i) => {
          // execWithInput too: it was added for backup restore and slipped past a
          // narrower `exec\(`-anchored pattern, which is exactly the gap this guards.
          if (!/session\.(exec|execWithInput|stream)\(/.test(line)) return
          // Look at the call and the few lines after it, since arguments wrap.
          const window = lines.slice(i, i + 4).join(' ')
          const touchesDocker = /docker|dockerRunCmd|INSPECT_CMD/i.test(window)
          // An explicitly sudo-prefixed literal is already privileged.
          const alreadySudo = /'sudo |"sudo |`sudo /.test(window)
          if (touchesDocker && !alreadySudo) offenders.push(`${path}:${i + 1}`)
        })
      }
    }

    expect(offenders, `route these through execPrivileged/streamPrivileged:\n${offenders.join('\n')}`)
      .toEqual([])
  })
})
