// SSH transport unit tests using FakeSshSession.

import { describe, it, expect } from 'vitest'
import { FakeSshSession, fakeSshSession, fakeReadable } from '../helpers/ssh.js'

describe('FakeSshSession', () => {
  it('exec() returns queued result', async () => {
    const session = new FakeSshSession().onExec(() => ({
      stdout: 'hello',
      stderr: '',
      code: 0,
    }))
    const result = await session.exec('echo hello')
    expect(result.stdout).toBe('hello')
    expect(result.code).toBe(0)
  })

  it('exec() falls back to empty result when no handler queued', async () => {
    const session = new FakeSshSession()
    const result = await session.exec('whoami')
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('no handler')
  })

  it('exec() rejects when signal is already aborted', async () => {
    const session = new FakeSshSession()
    const controller = new AbortController()
    controller.abort()
    await expect(session.exec('ls', controller.signal)).rejects.toThrow('aborted')
  })

  it('stream() returns queued readable', async () => {
    const session = new FakeSshSession().onStream(() => fakeReadable(['line1\n', 'line2\n']))
    const stream = await session.stream('tail -f /var/log/syslog')
    const chunks: string[] = []
    for await (const chunk of stream) {
      chunks.push(String(chunk))
    }
    expect(chunks.join('')).toBe('line1\nline2\n')
  })

  it('close() marks session as closed', () => {
    const session = new FakeSshSession()
    expect(session.closed).toBe(false)
    session.close()
    expect(session.closed).toBe(true)
  })
})

describe('fakeSshSession()', () => {
  it('creates a session with a default success result', async () => {
    const session = fakeSshSession({ stdout: 'test output', code: 0 })
    const result = await session.exec('cmd')
    expect(result.stdout).toBe('test output')
  })
})
