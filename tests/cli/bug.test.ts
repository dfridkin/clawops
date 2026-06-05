import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/config/store.js', () => ({
  getConfig: vi.fn(),
  getConfigDir: vi.fn(() => '/tmp/clawops-test'),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

const mockRlQuestion = vi.fn()
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: mockRlQuestion,
    close: vi.fn(),
  })),
}))

import { getConfig } from '../../src/config/store.js'
import { execSync } from 'node:child_process'
const mockGetConfig = vi.mocked(getConfig)
const mockExecSync = vi.mocked(execSync)

const baseConfig = {
  version: 1 as const,
  defaults: { stack: 'default', provider: 'aws' as const },
  stacks: {
    default: { provider: 'aws' as const, region: 'us-east-1', stateUrl: 's3://bucket/clawops' },
  },
  ssh: { keyPath: '/tmp/id_ed25519', knownHostsPath: '/tmp/known_hosts' },
  mcp: {},
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmd: any

beforeEach(async () => {
  vi.clearAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockGetConfig.mockReturnValue(baseConfig as any)
  mockRlQuestion
    .mockResolvedValueOnce('something broke')
    .mockResolvedValueOnce('clawops up')

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})

  const mod = await import('../../src/cli/commands/bug.js')
  cmd = mod.default
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bug command', () => {
  it('prompts for description and command then opens browser', async () => {
    mockExecSync.mockImplementation(() => Buffer.from(''))
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(mockRlQuestion).toHaveBeenCalledTimes(2)
    expect(mockExecSync).toHaveBeenCalledOnce()
  })

  it('constructs a URL containing the issue title', async () => {
    let capturedUrl = ''
    mockExecSync.mockImplementation((cmd: string) => {
      capturedUrl = cmd
      return Buffer.from('')
    })
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(capturedUrl).toContain('something+broke')
    expect(capturedUrl).toContain('github.com')
  })

  it('includes system context in the URL body', async () => {
    let capturedCmd = ''
    mockExecSync.mockImplementation((c: string) => {
      capturedCmd = c
      return Buffer.from('')
    })
    await (cmd.run as AnyRunFn)({ args: {} })
    // Extract URL from: open "https://..."
    const urlMatch = capturedCmd.match(/"(https:\/\/[^"]+)"/)
    const rawUrl = urlMatch?.[1] ?? ''
    const params = new URL(rawUrl).searchParams
    // URLSearchParams.get() decodes both %XX and + correctly
    const body = params.get('body') ?? ''
    expect(body).toContain('clawops version')
    expect(body).toContain('Node')
    expect(body).toContain('aws')
  })

  it('emits JSON and skips browser when --json is set', async () => {
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      written.push(String(s))
      return true
    })
    await (cmd.run as AnyRunFn)({ args: { json: true } })
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockRlQuestion).not.toHaveBeenCalled()
    const output = written.join('')
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.url).toContain('github.com')
  })

  it('prints URL as fallback when browser open fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('xdg-open not found') })
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      written.push(String(s))
      return true
    })
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(written.join('')).toContain('github.com')
  })

  it('handles missing config gracefully', async () => {
    mockGetConfig.mockReturnValue(null)
    mockExecSync.mockImplementation(() => Buffer.from(''))
    await expect((cmd.run as AnyRunFn)({ args: {} })).resolves.not.toThrow()
  })
})
