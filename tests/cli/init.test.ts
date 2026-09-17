// Unit tests for the `init` command.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { getConfig } from '../../src/config/store.js'

// `init` derives the state backend from the account it is pointed at, so without this these
// tests would read whatever project the developer's gcloud happens to have configured — and
// find none at all in CI. Pinned so every run names the same backend.
const { mockProjectId, mockAwsAccount } = vi.hoisted(() => ({
  mockProjectId: vi.fn<() => string | undefined>(() => 'unit-test-project'),
  mockAwsAccount: vi.fn<() => Promise<string | undefined>>(async () => '000000000000'),
}))
vi.mock('../../src/providers/gcp/preflight.js', () => ({ resolveProjectId: mockProjectId }))
vi.mock('../../src/providers/aws/preflight.js', () => ({ callerAccount: mockAwsAccount }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/init.js')
  return cmd
}


// `clawops init` generates a key and writes a config. Three tests here asserted only that it
// throws, and it throws *after* creating the config directory — so running this suite wrote an
// SSH key into the developer's real ~/.clawops. It is also what made the doctor suite pass
// locally and fail in CI: the key it found had been left there by this file.
//
// Every test gets its own CLAWOPS_HOME, whether it asked for one or not.
let suiteHome: string
const savedHome = { value: undefined as string | undefined }

beforeEach(() => {
  savedHome.value = process.env['CLAWOPS_HOME']
  suiteHome = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-suite-'))
  process.env['CLAWOPS_HOME'] = suiteHome
})
afterEach(() => {
  if (savedHome.value === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = savedHome.value
  rmSync(suiteHome, { recursive: true, force: true })
})

describe('init command — cloud providers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('creates config with gcp defaults when no args given', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({ args: { provider: 'gcp', 'non-interactive': true } })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.stacks['default']?.provider).toBe('gcp')
      expect(cfg?.stacks['default']?.region).toBe('us-central1')
      expect(cfg?.stacks['default']?.credentialsRef.source).toBe('env')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('names the state backend after the account instead of writing a placeholder', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({ args: { provider: 'gcp', 'non-interactive': true } })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      expect(getConfig()?.stacks['default']?.stateUrl)
        .toBe('gs://clawops-state-unit-test-project/clawops')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('puts the region in an S3 name, because an S3 bucket lives in one', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'aws', region: 'eu-west-2', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      expect(getConfig()?.stacks['default']?.stateUrl)
        .toBe('s3://clawops-state-000000000000-eu-west-2/clawops')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('writes nothing, and says what it needs, when no account resolves', async () => {
    mockProjectId.mockReturnValueOnce(undefined)
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await expect(
        (cmd.run as AnyRunFn)({ args: { provider: 'gcp', 'non-interactive': true } }),
      ).rejects.toThrow(/gcloud config set project/)
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      // The old placeholder left a stack that looked registered and could never deploy.
      expect(getConfig()?.stacks['default']).toBeUndefined()
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('still takes --state verbatim without asking any cloud who we are', async () => {
    mockProjectId.mockReturnValueOnce(undefined)
    mockAwsAccount.mockResolvedValueOnce(undefined)
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'aws', state: 's3://mine/clawops', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      expect(getConfig()?.stacks['default']?.stateUrl).toBe('s3://mine/clawops')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses --state URL verbatim', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'aws', state: 's3://my-real-bucket/clawops', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.stacks['default']?.stateUrl).toBe('s3://my-real-bucket/clawops')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses --stack name for the stack key and default', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'gcp', stack: 'prod', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.defaults.stack).toBe('prod')
      expect(cfg?.stacks['prod']).toBeDefined()
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reuses an existing SSH key when present (file content unchanged)', async () => {
    const { readFileSync } = await import('node:fs')
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    const keyPath = path.join(tmpDir, 'id_ed25519')
    // Pre-create the key file so generation is skipped
    writeFileSync(keyPath, 'FAKE_KEY_CONTENT', { mode: 0o600 })
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'gcp', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      // Content should be unchanged — we did NOT regenerate the key
      const content = readFileSync(keyPath, 'utf-8')
      expect(content).toBe('FAKE_KEY_CONTENT')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('--non-interactive without --provider throws UsageError', async () => {
    vi.resetModules()
    const cmd = await getCmd()
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { 'non-interactive': true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('unsupported provider throws UsageError', async () => {
    vi.resetModules()
    const cmd = await getCmd()
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { provider: 'digitalocean', 'non-interactive': true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })
})

describe('init command — local provider', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('writes localOpts with correct defaults', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'local', host: '192.168.1.10', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      const opts = cfg?.stacks['default']?.localOpts
      expect(opts?.host).toBe('192.168.1.10')
      expect(opts?.sshUser).toBe('root')
      expect(opts?.sshPort).toBe(22)
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('respects --ssh-user and --ssh-port overrides', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: {
          provider: 'local',
          host: '10.0.0.5',
          'ssh-user': 'ubuntu',
          'ssh-port': '2222',
          'non-interactive': true,
        },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      const opts = cfg?.stacks['default']?.localOpts
      expect(opts?.sshUser).toBe('ubuntu')
      expect(opts?.sshPort).toBe(2222)
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws UsageError when --host is missing', async () => {
    vi.resetModules()
    const cmd = await getCmd()
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { provider: 'local', 'non-interactive': true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('writes stateUrl as file:// scheme', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'local', host: '10.0.0.1', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.stacks['default']?.stateUrl).toMatch(/^file:\/\//)
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('the generated SSH key', () => {
  it('is one ssh2 can parse — the library every clawops SSH command uses', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const saved = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      const cmd = (await import('../../src/cli/commands/init.js')).default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (cmd.run as any)({ args: { provider: 'local', host: 'example.com' } })

      const ssh2 = (await import('ssh2')).default
      const parsed = ssh2.utils.parseKey(readFileSync(path.join(tmpDir, 'id_ed25519')))
      // `crypto.generateKeyPairSync` writes a PKCS#8 PEM — a valid ed25519 key that ssh2
      // cannot parse and OpenSSH calls "invalid format". init produced one of those, so the
      // key it generated could not be used by the tool that generated it.
      expect(parsed).not.toBeInstanceOf(Error)
      expect((parsed as { type: string }).type).toBe('ssh-ed25519')
    } finally {
      if (saved === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = saved
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('writes the .pub beside it', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const saved = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      const cmd = (await import('../../src/cli/commands/init.js')).default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (cmd.run as any)({ args: { provider: 'local', host: 'example.com' } })
      expect(readFileSync(path.join(tmpDir, 'id_ed25519.pub'), 'utf-8')).toMatch(/^ssh-ed25519 /)
    } finally {
      if (saved === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = saved
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('init and the filesystem it writes to', () => {
  it('generates the key before it validates --host, and puts it under CLAWOPS_HOME', async () => {
    // init creates the config directory and key, then throws. Three tests in this file
    // exercise that path, and without the suite's own CLAWOPS_HOME they wrote an SSH key into
    // the developer's real ~/.clawops — which is what made the doctor suite pass locally and
    // fail in CI.
    const cmd = await getCmd()
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { provider: 'local', 'non-interactive': true } }),
    ).rejects.toBeInstanceOf(UsageError)
    expect(existsSync(path.join(suiteHome, 'id_ed25519'))).toBe(true)
  })

  it('refuses rather than reporting success when ssh-keygen fails', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      spawnSync: () => ({ status: 1, stderr: Buffer.from('ssh-keygen: not found'), error: undefined }),
    }))
    try {
      const cmd = (await import('../../src/cli/commands/init.js')).default
      // Carrying on would write a config pointing at a key that does not exist, and the
      // failure would surface much later as a connection error.
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (cmd.run as any)({ args: { provider: 'gcp', 'non-interactive': true } }),
      ).rejects.toThrow(/Could not generate an SSH key.*ssh-keygen: not found/s)
      expect(existsSync(path.join(suiteHome, 'config.json'))).toBe(false)
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('names the manual way out when it cannot generate one', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      spawnSync: () => ({ status: null, stderr: undefined, error: new Error('spawn ENOENT') }),
    }))
    try {
      const cmd = (await import('../../src/cli/commands/init.js')).default
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (cmd.run as any)({ args: { provider: 'gcp', 'non-interactive': true } }),
      ).rejects.toThrow(/ssh-keygen -t ed25519[\s\S]*clawops init --key-path/)
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

describe('init with a config that already exists', () => {
  /** Write a config with one registered stack, the way a first `init` would have. */
  function seed(stack: string) {
    writeFileSync(
      path.join(suiteHome, 'config.json'),
      JSON.stringify({
        version: 1,
        defaults: { stack, provider: 'gcp' },
        stacks: {
          [stack]: {
            provider: 'gcp',
            stateUrl: 'gs://first-bucket/clawops',
            region: 'us-central1',
            credentialsRef: { source: 'env', envVars: ['GOOGLE_APPLICATION_CREDENTIALS'] },
          },
        },
        ssh: {
          keyPath: path.join(suiteHome, 'id_ed25519'),
          knownHostsPath: path.join(suiteHome, 'known_hosts'),
        },
        mcp: { auditLogPath: '/var/log/clawops-audit.jsonl' },
      }) + '\n',
    )
  }

  it('adds a second stack without deleting the first', async () => {
    // This is the bug: init wrote a whole new config with one stacks entry, so registering a
    // second stack dropped the first — along with its stateUrl, the only pointer to where that
    // stack's Pulumi state lives. The infrastructure stayed up and clawops could no longer
    // see, reach or destroy it.
    seed('production')
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({
      args: { provider: 'gcp', stack: 'staging', state: 'gs://second-bucket/clawops' },
    })

    const config = getConfig()!
    expect(Object.keys(config.stacks).sort()).toEqual(['production', 'staging'])
    expect(config.stacks['production']?.stateUrl).toBe('gs://first-bucket/clawops')
    expect(config.stacks['staging']?.stateUrl).toBe('gs://second-bucket/clawops')
  })

  it('needs no --force to add a stack that is not there yet', async () => {
    seed('production')
    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { provider: 'gcp', stack: 'staging' } }),
    ).resolves.not.toThrow()
  })

  it('points defaults at the stack just initialised', async () => {
    seed('production')
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { provider: 'gcp', stack: 'staging' } })
    expect(getConfig()!.defaults.stack).toBe('staging')
  })

  it('keeps config outside stacks, such as the MCP block', async () => {
    seed('production')
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { provider: 'gcp', stack: 'staging' } })
    expect(getConfig()!.mcp?.auditLogPath).toBe('/var/log/clawops-audit.jsonl')
  })

  it('refuses to overwrite an existing stack without --force, naming its state', async () => {
    // Changing a registered stack's stateUrl orphans its state as thoroughly as deleting it.
    seed('production')
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    try {
      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({
          args: { provider: 'gcp', stack: 'production', state: 'gs://somewhere-else/clawops' },
        }),
      ).rejects.toThrow('exit')
      expect(getConfig()!.stacks['production']?.stateUrl).toBe('gs://first-bucket/clawops')
    } finally {
      exit.mockRestore()
    }
  })

  it('overwrites that stack when --force is given', async () => {
    seed('production')
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({
      args: {
        provider: 'gcp',
        stack: 'production',
        state: 'gs://somewhere-else/clawops',
        force: true,
      },
    })
    expect(getConfig()!.stacks['production']?.stateUrl).toBe('gs://somewhere-else/clawops')
  })
})
