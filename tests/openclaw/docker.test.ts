import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  inspectContainer, containerStatus, looksLikeStillBooting,
} from '../../src/openclaw/docker.js'
import type { SshSession } from '../../src/transport/ssh.js'
import { resetPrivilegeCache } from '../../src/transport/privileged.js'

/** A host that answers one way to a bare docker command and another under sudo. */
function host(answers: {
  direct: { stdout?: string; stderr?: string; code: number }
  sudo?: { stdout?: string; stderr?: string; code: number }
}) {
  const exec = vi.fn(async (command: string) => {
    const a = command.startsWith('sudo') ? (answers.sudo ?? answers.direct) : answers.direct
    return { stdout: a.stdout ?? '', stderr: a.stderr ?? '', code: a.code }
  })
  return { exec, close: vi.fn() } as unknown as SshSession & { exec: typeof exec }
}

let session: SshSession

beforeEach(() => {
  session = host({ direct: { stdout: 'running\n', code: 0 } })
  resetPrivilegeCache(session)
})

describe('inspectContainer', () => {
  it('returns what docker printed', async () => {
    await expect(inspectContainer(session, 'openclaw', '{{.State.Status}}')).resolves.toEqual({
      kind: 'ok',
      value: 'running',
    })
  })

  it('reports a container docker says does not exist as missing', async () => {
    const s = host({
      direct: { stderr: 'Error: No such object: openclaw', code: 1 },
    })
    resetPrivilegeCache(s)
    await expect(inspectContainer(s, 'openclaw', '{{.State.Status}}')).resolves.toEqual({
      kind: 'missing',
    })
  })

  it('escalates when Docker refuses the user, rather than calling it missing', async () => {
    // The whole bug: the old probe discarded stderr and exited 0, so execPrivileged never saw
    // a refusal, never escalated, and the caller was told the container did not exist.
    const s = host({
      direct: {
        stderr: 'permission denied while trying to connect to the Docker daemon socket',
        code: 1,
      },
      sudo: { stdout: 'running\n', code: 0 },
    })
    resetPrivilegeCache(s)
    await expect(inspectContainer(s, 'openclaw', '{{.State.Status}}')).resolves.toEqual({
      kind: 'ok',
      value: 'running',
    })
  })

  it('reports a refusal that sudo cannot fix as an error, never as missing', async () => {
    const s = host({
      direct: { stderr: 'permission denied … docker.sock', code: 1 },
      sudo: { stderr: 'sudo: a password is required', code: 1 },
    })
    resetPrivilegeCache(s)
    const result = await inspectContainer(s, 'openclaw', '{{.State.Status}}')
    expect(result.kind).toBe('error')
    expect(result).toMatchObject({ detail: expect.stringContaining('password') })
  })

  it('does not mask the failure with a shell fallback', async () => {
    // `2>/dev/null || echo` is what made every failure look like a success.
    await inspectContainer(session, 'openclaw', '{{.State.Status}}')
    const command = String((session as unknown as { exec: ReturnType<typeof vi.fn> }).exec.mock.calls[0]?.[0])
    expect(command).not.toContain('2>/dev/null')
    expect(command).not.toContain('|| echo')
  })

  it('asks about the container it was given', async () => {
    await inspectContainer(session, 'something-else', '{{.State.Status}}')
    expect(String((session as unknown as { exec: ReturnType<typeof vi.fn> }).exec.mock.calls[0]?.[0]))
      .toContain('docker inspect something-else')
  })

  it('can be pointed at a docker on an unusual PATH', async () => {
    await inspectContainer(session, 'openclaw', '{{.X}}', undefined, 'PATH=/opt/bin:$PATH docker')
    expect(String((session as unknown as { exec: ReturnType<typeof vi.fn> }).exec.mock.calls[0]?.[0]))
      .toContain('PATH=/opt/bin:$PATH docker inspect')
  })
})

describe('containerStatus', () => {
  it('gives the status word when docker answers', async () => {
    await expect(containerStatus(session)).resolves.toEqual({ status: 'running' })
  })

  it('says not found when there is genuinely no container', async () => {
    const s = host({ direct: { stderr: 'No such container: openclaw', code: 1 } })
    resetPrivilegeCache(s)
    await expect(containerStatus(s)).resolves.toEqual({ status: 'not found' })
  })

  it('carries the reason when docker could not be asked', async () => {
    const s = host({
      direct: { stderr: 'permission denied … docker.sock', code: 1 },
      sudo: { stderr: 'sudo: a password is required', code: 1 },
    })
    resetPrivilegeCache(s)
    const result = await containerStatus(s)
    expect(result.status).toBe('unknown')
    expect(result.error).toContain('password')
  })

  it('never reports a refusal as "not found"', async () => {
    const s = host({
      direct: { stderr: 'permission denied … docker.sock', code: 1 },
      sudo: { stderr: 'still denied', code: 1 },
    })
    resetPrivilegeCache(s)
    expect((await containerStatus(s)).status).not.toBe('not found')
  })
})

describe('looksLikeStillBooting', () => {
  it.each([
    'bash: line 1: docker: command not found',
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    'Is the docker daemon running?',
    '/var/run/docker.sock: no such file or directory',
  ])('treats %s as the host still coming up', (detail) => {
    // A fresh VM has no Docker for the first minute; the bootstrap installs it.
    expect(looksLikeStillBooting(detail)).toBe(true)
  })

  it.each([
    'permission denied while trying to connect to the Docker daemon socket',
    'sudo: a password is required',
  ])('treats %s as permanent', (detail) => {
    // The SSH user's group membership is fixed when the session opens, so a socket that
    // refuses this session refuses it for the session's whole life.
    expect(looksLikeStillBooting(detail)).toBe(false)
  })
})
