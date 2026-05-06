// Local provider bootstrap unit tests.
// Uses vi.mock to avoid real SSH connections.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

// ── Mock SSH pool ──────────────────────────────────────────────────────────────
let execResult = { stdout: 'clawops: bootstrap complete\n', stderr: '', code: 0 }
const mockSession = {
  exec: vi.fn(async () => execResult),
  close: vi.fn(),
}
const mockRelease = vi.fn()

vi.mock('../../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(async () => ({ session: mockSession, release: mockRelease })),
  drainPool: vi.fn(),
}))

// ── Mock fetch for health poll ─────────────────────────────────────────────────
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ── Import after mocks ─────────────────────────────────────────────────────────
import { localBootstrap } from '../../../src/providers/local/bootstrap.js'
import { readLocalState } from '../../../src/providers/local/state.js'

const BASE_OPTS = {
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  privateKeyPath: '/tmp/id_ed25519',
  knownHostsPath: '/tmp/known_hosts',
  openclawVersion: '2026.4',
  stackName: 'test-stack',
  noWait: true, // skip health poll by default
}

describe('localBootstrap()', () => {
  let tmpDir: string
  let prevHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-bootstrap-test-'))
    prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    vi.clearAllMocks()
    execResult = { stdout: 'clawops: bootstrap complete\n', stderr: '', code: 0 }
    mockFetch.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
    else process.env['CLAWOPS_HOME'] = prevHome
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a LocalState with correct fields', async () => {
    const state = await localBootstrap(BASE_OPTS)
    expect(state.sshHost).toBe('10.0.0.1')
    expect(state.sshPort).toBe(22)
    expect(state.sshUser).toBe('root')
    expect(state.gatewayUrl).toBe('http://10.0.0.1:18789')
    expect(state.region).toBe('local')
    expect(state.provisionedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('persists LocalState to disk', async () => {
    await localBootstrap(BASE_OPTS)
    const loaded = readLocalState('test-stack')
    expect(loaded?.sshHost).toBe('10.0.0.1')
  })

  it('executes the bootstrap script via SSH exec', async () => {
    const { acquireSession } = await import('../../../src/transport/pool.js')
    await localBootstrap(BASE_OPTS)
    expect(acquireSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.0.0.1', port: 22, user: 'root' }),
    )
    expect(mockSession.exec).toHaveBeenCalledTimes(1)
    const [cmd] = mockSession.exec.mock.calls[0] as unknown as [string]
    expect(cmd).toContain('base64 -d')
    expect(cmd).toContain('sudo bash')
  })

  it('renders OPENCLAW_VERSION into the script', async () => {
    await localBootstrap({ ...BASE_OPTS, openclawVersion: '2099.1' })
    const [cmd] = mockSession.exec.mock.calls[0] as unknown as [string]
    // The b64 payload contains the rendered script; decode and check
    const b64Match = cmd.match(/echo '([A-Za-z0-9+/=]+)'/)
    expect(b64Match).toBeTruthy()
    const script = Buffer.from(b64Match![1]!, 'base64').toString('utf-8')
    expect(script).toContain('2099.1')
    expect(script).not.toContain('{{OPENCLAW_VERSION}}')
  })

  it('throws ProviderError when the script exits non-zero', async () => {
    execResult = { stdout: '', stderr: 'apt-get: command not found', code: 1 }
    await expect(localBootstrap(BASE_OPTS)).rejects.toThrow(/Bootstrap script failed/)
  })

  it('calls release() after exec even on failure', async () => {
    execResult = { stdout: '', stderr: 'error', code: 1 }
    await localBootstrap(BASE_OPTS).catch(() => {})
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('polls /health when noWait is false', async () => {
    mockFetch.mockResolvedValue({ ok: true })
    await localBootstrap({ ...BASE_OPTS, noWait: false })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://10.0.0.1:18789/health',
      expect.anything(),
    )
  })

  it('skips /health poll when noWait is true', async () => {
    await localBootstrap({ ...BASE_OPTS, noWait: true })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
