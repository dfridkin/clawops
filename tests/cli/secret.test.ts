import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeLocalFakeContext, FAKE_LOCAL_STATE, FAKE_CONN } from '../helpers/context.js'

// ── Hoisted mock references ────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock() factories, making these available in
// factory closures without triggering the TDZ const issue.

const {
  mockExistsSync, mockReaddirSync, mockReadFileSync, mockWriteFileSync,
  mockUnlinkSync, mockMkdirSync, mockStatSync, mockSpawnSync,
  mockInquirerPrompt,
  mockLoadOverlay, mockListOverlays, mockSaveOverlay,
  mockBuildContext, mockGetConfig,
  mockAcquireSession, mockDrainPool,
  mockReadRemoteConfig, mockAtomicWriteConfig, mockRestartGateway, mockDeepMerge,
  mockResolveSecrets, mockLocalStateToConnectionInfo, mockExtractBaseOutputs,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockSpawnSync: vi.fn(),
  mockInquirerPrompt: vi.fn(),
  mockLoadOverlay: vi.fn(),
  mockListOverlays: vi.fn(),
  mockSaveOverlay: vi.fn(),
  mockBuildContext: vi.fn(),
  mockGetConfig: vi.fn(),
  mockAcquireSession: vi.fn(),
  mockDrainPool: vi.fn(),
  mockReadRemoteConfig: vi.fn(),
  mockAtomicWriteConfig: vi.fn(),
  mockRestartGateway: vi.fn(),
  mockDeepMerge: vi.fn(),
  mockResolveSecrets: vi.fn(),
  mockLocalStateToConnectionInfo: vi.fn(),
  mockExtractBaseOutputs: vi.fn(),
}))

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
    mkdirSync: mockMkdirSync,
    statSync: mockStatSync,
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, spawnSync: mockSpawnSync }
})

vi.mock('inquirer', () => ({ default: { prompt: mockInquirerPrompt } }))

vi.mock('../../src/plan/overlay-store.js', () => ({
  loadOverlay: mockLoadOverlay,
  listOverlays: mockListOverlays,
  saveOverlay: mockSaveOverlay,
}))

vi.mock('../../src/cli/context.js', () => ({ buildContext: mockBuildContext }))
vi.mock('../../src/config/store.js', () => ({ getConfig: mockGetConfig }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: mockAcquireSession,
  drainPool: mockDrainPool,
}))
vi.mock('../../src/plan/remote-config.js', () => ({
  readRemoteConfig: mockReadRemoteConfig,
  atomicWriteConfig: mockAtomicWriteConfig,
  restartGateway: mockRestartGateway,
  deepMerge: mockDeepMerge,
}))
vi.mock('../../src/plan/secrets.js', () => ({ resolveSecrets: mockResolveSecrets }))
vi.mock('../../src/providers/local/state.js', () => ({
  localStateToConnectionInfo: mockLocalStateToConnectionInfo,
}))
vi.mock('../../src/pulumi/outputs.js', () => ({
  extractBaseOutputs: mockExtractBaseOutputs,
}))

// ── Helpers ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void> | void
type SubCmds = Record<string, { run: AnyRunFn }>

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/secret.js')
  return cmd
}

// Collects all output regardless of which write path was used.
// info/success/warn/failure go through console.log/warn/error;
// table rendering and JSON go through process.stdout.write directly.
function getOutput() {
  const stdout = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('')
  const log = vi.mocked(console.log).mock.calls.map(c => c.join(' ')).join('\n')
  const warn = vi.mocked(console.warn).mock.calls.map(c => c.join(' ')).join('\n')
  const err = vi.mocked(console.error).mock.calls.map(c => c.join(' ')).join('\n')
  return stdout + '\n' + log + '\n' + warn + '\n' + err
}

const FAKE_STAT = { mtime: new Date('2026-05-13T00:00:00Z') } as import('node:fs').Stats
const SAMPLE_OVERLAY = { stackName: 'prod', savedAt: '2026-05-13T00:00:00Z', overlay: {}, secrets: [] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()

  // Safe defaults for every test — individual tests override as needed
  mockExistsSync.mockReturnValue(true)
  mockReaddirSync.mockReturnValue([])
  mockReadFileSync.mockReturnValue('secret-value')
  mockStatSync.mockReturnValue(FAKE_STAT)
  mockSpawnSync.mockReturnValue({ status: 0 })
  mockInquirerPrompt.mockResolvedValue({ secretValue: 'prompted-value', confirmed: true })
  mockListOverlays.mockReturnValue([])
  mockLoadOverlay.mockReturnValue(null)
  mockGetConfig.mockReturnValue(null)
  mockDeepMerge.mockReturnValue({})
  mockResolveSecrets.mockReturnValue({})
  mockReadRemoteConfig.mockResolvedValue({})
  mockAtomicWriteConfig.mockResolvedValue(undefined)
  mockRestartGateway.mockResolvedValue(undefined)
  mockLocalStateToConnectionInfo.mockReturnValue(FAKE_CONN)
  mockExtractBaseOutputs.mockReturnValue({ publicIp: '1.2.3.4', sshHost: '1.2.3.4', sshPort: 22, sshUser: 'clawops' })

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => { throw new Error(`exit:${code}`) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── root ───────────────────────────────────────────────────────────────────

describe('secret root', () => {
  it('exposes all five subcommands', async () => {
    const cmd = await getCmd()
    expect(cmd.subCommands).toHaveProperty('list')
    expect(cmd.subCommands).toHaveProperty('set')
    expect(cmd.subCommands).toHaveProperty('delete')
    expect(cmd.subCommands).toHaveProperty('rotate')
    expect(cmd.subCommands).toHaveProperty('audit')
  })
})

// ── list ───────────────────────────────────────────────────────────────────

describe('secret list subcommand', () => {
  it('prints info when no secrets exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const cmd = await getCmd()
    ;(cmd.subCommands as SubCmds)['list'].run({ args: {} })
    expect(getOutput()).toContain('No secrets')
  })

  it('renders a table when secrets exist', async () => {
    mockReaddirSync.mockReturnValue(['ANTHROPIC_API_KEY'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    mockReadFileSync.mockReturnValue('sk-ant-abc123')
    const cmd = await getCmd()
    ;(cmd.subCommands as SubCmds)['list'].run({ args: {} })
    const out = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('')
    expect(out).toContain('ANTHROPIC_API_KEY')
  })

  it('emits JSON with --json flag', async () => {
    mockReaddirSync.mockReturnValue(['MY_SECRET'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    mockReadFileSync.mockReturnValue('value123')
    const cmd = await getCmd()
    ;(cmd.subCommands as SubCmds)['list'].run({ args: { json: true } })
    const raw = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('')
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].name).toBe('MY_SECRET')
    expect(parsed[0].status).toBe('ok')
  })

  it('marks empty files with status empty', async () => {
    mockReaddirSync.mockReturnValue(['EMPTY_SECRET'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    mockReadFileSync.mockReturnValue('   ')
    const cmd = await getCmd()
    ;(cmd.subCommands as SubCmds)['list'].run({ args: { json: true } })
    const raw = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('')
    const parsed = JSON.parse(raw)
    expect(parsed[0].status).toBe('empty')
  })
})

// ── set ────────────────────────────────────────────────────────────────────

describe('secret set subcommand', () => {
  it('exits 2 when no name is given', async () => {
    const cmd = await getCmd()
    await expect(
      (cmd.subCommands as SubCmds)['set'].run({ args: { _: [] } }),
    ).rejects.toThrow('exit:2')
  })

  it('writes secret when --value is provided (no prompt)', async () => {
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['set'].run({ args: { _: ['MY_KEY'], value: 'direct-val' } })
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [, content] = mockWriteFileSync.mock.calls[0]!
    expect(content).toBe('direct-val')
  })

  it('writes secret from inquirer prompt when no --value', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ secretValue: 'prompted-value' })
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['set'].run({ args: { _: ['MY_KEY'] } })
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [, content] = mockWriteFileSync.mock.calls[0]!
    expect(content).toBe('prompted-value')
  })

  it('creates secrets dir before writing', async () => {
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['set'].run({ args: { _: ['MY_KEY'], value: 'v' } })
    expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining('secrets'), { recursive: true })
  })
})

// ── delete ─────────────────────────────────────────────────────────────────

describe('secret delete subcommand', () => {
  it('exits 2 when no name is given', async () => {
    const cmd = await getCmd()
    await expect(
      (cmd.subCommands as SubCmds)['delete'].run({ args: { _: [] } }),
    ).rejects.toThrow('exit:2')
  })

  it('exits 1 when the secret file does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const cmd = await getCmd()
    await expect(
      (cmd.subCommands as SubCmds)['delete'].run({ args: { _: ['MISSING'], yes: true } }),
    ).rejects.toThrow('exit:1')
  })

  it('warns when secret is still referenced by a stack overlay', async () => {
    mockListOverlays.mockReturnValue([
      { stackName: 'prod', savedAt: '2026-05-13', overlay: {}, secrets: [{ name: 'MY_KEY', source: 'file' as const }] },
    ])
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['delete'].run({ args: { _: ['MY_KEY'], yes: true } })
    expect(getOutput()).toContain('prod')
  })

  it('deletes file with --yes without prompting', async () => {
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['delete'].run({ args: { _: ['MY_KEY'], yes: true } })
    expect(mockUnlinkSync).toHaveBeenCalledOnce()
    expect(mockInquirerPrompt).not.toHaveBeenCalled()
  })

  it('prompts for confirmation without --yes', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmed: true })
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['delete'].run({ args: { _: ['MY_KEY'] } })
    expect(mockInquirerPrompt).toHaveBeenCalledOnce()
    expect(mockUnlinkSync).toHaveBeenCalledOnce()
  })

  it('aborts without deleting when user declines', async () => {
    mockInquirerPrompt.mockResolvedValueOnce({ confirmed: false })
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['delete'].run({ args: { _: ['MY_KEY'] } })
    expect(mockUnlinkSync).not.toHaveBeenCalled()
  })
})

// ── rotate ─────────────────────────────────────────────────────────────────

describe('secret rotate subcommand', () => {
  it('exits 2 when no name is given', async () => {
    const cmd = await getCmd()
    await expect(
      (cmd.subCommands as SubCmds)['rotate'].run({ args: { _: [] } }),
    ).rejects.toThrow('exit:2')
  })

  it('writes new secret value to file', async () => {
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['rotate'].run({ args: { _: ['MY_KEY'], value: 'rotated-val' } })
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [, content] = mockWriteFileSync.mock.calls[0]!
    expect(content).toBe('rotated-val')
  })

  it('warns and returns when no stack can be determined', async () => {
    mockGetConfig.mockReturnValue(null)
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['rotate'].run({ args: { _: ['MY_KEY'], value: 'v' } })
    expect(mockRestartGateway).not.toHaveBeenCalled()
    expect(getOutput()).toContain('No stack specified')
  })

  it('warns and returns when no stored overlay exists for the stack', async () => {
    mockGetConfig.mockReturnValue({ defaults: { stack: 'prod' } } as never)
    mockLoadOverlay.mockReturnValue(null)
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['rotate'].run({ args: { _: ['MY_KEY'], value: 'v' } })
    expect(mockRestartGateway).not.toHaveBeenCalled()
    expect(getOutput()).toContain('No stored overlay')
  })

  it('re-applies overlay and restarts gateway on success (local provider)', async () => {
    mockGetConfig.mockReturnValue({ defaults: { stack: 'prod' } } as never)
    mockLoadOverlay.mockReturnValue(SAMPLE_OVERLAY)
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    const release = vi.fn()
    mockAcquireSession.mockResolvedValue({ session: {} as never, release })
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['rotate'].run({ args: { _: ['MY_KEY'], value: 'v' } })
    expect(mockAtomicWriteConfig).toHaveBeenCalledOnce()
    expect(mockRestartGateway).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(mockDrainPool).toHaveBeenCalledOnce()
  })

  it('reports failure without throwing when re-apply errors', async () => {
    mockGetConfig.mockReturnValue({ defaults: { stack: 'prod' } } as never)
    mockLoadOverlay.mockReturnValue(SAMPLE_OVERLAY)
    mockBuildContext.mockImplementation(() => { throw new Error('context error') })
    const cmd = await getCmd()
    await expect(
      (cmd.subCommands as SubCmds)['rotate'].run({ args: { _: ['MY_KEY'], value: 'v' } }),
    ).resolves.not.toThrow()
    expect(getOutput()).toContain('Re-apply failed')
  })
})

// ── audit ──────────────────────────────────────────────────────────────────

describe('secret audit subcommand', () => {
  it('reports success when all secrets are ok', async () => {
    mockReaddirSync.mockReturnValue(['GOOD'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    mockReadFileSync.mockReturnValue('non-empty')
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['audit'].run({ args: {} })
    expect(getOutput()).toContain('No issues')
  })

  it('reports empty-secret issue for empty secret files', async () => {
    mockReaddirSync.mockReturnValue(['EMPTY'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    mockReadFileSync.mockReturnValue('   ')
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['audit'].run({ args: {} })
    const out = getOutput()
    expect(out).toContain('EMPTY')
    expect(out).toContain('empty')
  })

  it('reports missing-file issue for overlay with unresolvable file ref', async () => {
    mockExistsSync.mockImplementation((p: unknown) => !String(p).includes('secrets/API_KEY'))
    mockListOverlays.mockReturnValue([{
      stackName: 'prod',
      savedAt: '2026-05-13',
      overlay: {},
      secrets: [{ name: 'API_KEY', source: 'file' as const, ref: '/home/user/.clawops/secrets/API_KEY' }],
    }])
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['audit'].run({ args: {} })
    const out = getOutput()
    expect(out).toContain('API_KEY')
    expect(out).toContain('prod')
  })

  it('reports missing-env issue when env var is not set', async () => {
    delete process.env['MY_TOKEN_ENV_VAR']
    mockListOverlays.mockReturnValue([{
      stackName: 'staging',
      savedAt: '2026-05-13',
      overlay: {},
      secrets: [{ name: 'MY_TOKEN', source: 'env' as const, ref: 'MY_TOKEN_ENV_VAR' }],
    }])
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['audit'].run({ args: {} })
    expect(getOutput()).toContain('MY_TOKEN')
  })

  it('emits JSON with ok/issues when --json is given', async () => {
    mockListOverlays.mockReturnValue([{
      stackName: 'prod',
      savedAt: '2026-05-13',
      overlay: {},
      secrets: [{ name: 'SM_KEY', source: 'aws-sm' as const, ref: 'arn:aws:secretsmanager:...' }],
    }])
    const cmd = await getCmd()
    await (cmd.subCommands as SubCmds)['audit'].run({ args: { json: true } })
    const raw = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('')
    const parsed = JSON.parse(raw)
    expect(typeof parsed.ok).toBe('boolean')
    expect(Array.isArray(parsed.issues)).toBe(true)
    expect(parsed.issues.length).toBeGreaterThan(0)
  })
})
