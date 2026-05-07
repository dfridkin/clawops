import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../../src/config/store.js', () => ({
  getConfig: vi.fn(),
  getConfigDir: vi.fn(() => '/tmp/clawops-test'),
}))

const mockValidateConfig = vi.fn()
vi.mock('../../src/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ validateConfig: mockValidateConfig })),
}))

// Suppress provider side-effect imports
vi.mock('../../src/providers/aws/index.js', () => ({}))
vi.mock('../../src/providers/gcp/index.js', () => ({}))
vi.mock('../../src/providers/azure/index.js', () => ({}))
vi.mock('../../src/providers/local/index.js', () => ({}))

const mockAccessSync = vi.fn()
const mockMkdirSync = vi.fn()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, accessSync: mockAccessSync, mkdirSync: mockMkdirSync }
})

import { getConfig, getConfigDir } from '../../src/config/store.js'
const mockGetConfig = vi.mocked(getConfig)
const mockGetConfigDir = vi.mocked(getConfigDir)

const baseConfig = {
  version: 1 as const,
  defaults: { stack: 'default', provider: 'aws' as const },
  stacks: {
    default: { provider: 'aws' as const, region: 'us-east-1', stateUrl: 's3://bucket/clawops' },
  },
  ssh: { keyPath: '~/.clawops/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' },
  mcp: {},
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmd: any

beforeEach(async () => {
  vi.clearAllMocks()
  mockGetConfigDir.mockReturnValue('/tmp/clawops-test')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockGetConfig.mockReturnValue(baseConfig as any)
  mockValidateConfig.mockResolvedValue({ ok: true, errors: [] })
  mockMkdirSync.mockImplementation(() => undefined)

  // Default to a passing Node version so other tests don't trip the exit(1) guard
  vi.spyOn(process, 'version', 'get').mockReturnValue('v22.0.0')

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const mod = await import('../../src/cli/commands/doctor.js')
  cmd = mod.default
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('doctor command', () => {
  it('runs successfully when config and credentials are present', async () => {
    await expect((cmd.run as AnyRunFn)({})).resolves.not.toThrow()
  })

  it('calls validateConfig for each configured provider', async () => {
    await (cmd.run as AnyRunFn)({})
    expect(mockValidateConfig).toHaveBeenCalledOnce()
  })

  it('shows warning when no config file is found', async () => {
    mockGetConfig.mockReturnValue(null)
    const warns: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args) => { warns.push(args.join(' ')) })

    await (cmd.run as AnyRunFn)({})

    expect(warns.join('\n')).toMatch(/No config file/)
  })

  it('shows failure when SSH key is not readable', async () => {
    mockAccessSync.mockImplementation((p: string, flag: number) => {
      // Only fail for key file reads (not known_hosts existence check)
      if (String(p).includes('id_ed25519') && flag !== undefined) {
        throw new Error('ENOENT')
      }
    })
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')) })

    await (cmd.run as AnyRunFn)({})

    expect(errors.join('\n')).toMatch(/SSH key|not found|not readable/)
  })

  it('shows failure when validateConfig returns errors', async () => {
    mockValidateConfig.mockResolvedValue({ ok: false, errors: ['AWS_PROFILE not set'] })
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')) })

    await (cmd.run as AnyRunFn)({})

    expect(errors.join('\n')).toMatch(/AWS_PROFILE/)
  })

  it('skips duplicate provider checks for multiple stacks on same provider', async () => {
    mockGetConfig.mockReturnValue({
      ...baseConfig,
      stacks: {
        default: { provider: 'aws' as const, region: 'us-east-1', stateUrl: 's3://b/c' },
        staging: { provider: 'aws' as const, region: 'eu-west-1', stateUrl: 's3://b/c2' },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    await (cmd.run as AnyRunFn)({})

    expect(mockValidateConfig).toHaveBeenCalledOnce()
  })

  it('exits with code 1 when Node.js version is too old', async () => {
    vi.spyOn(process, 'version', 'get').mockReturnValue('v18.0.0')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

    await expect((cmd.run as AnyRunFn)({})).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
