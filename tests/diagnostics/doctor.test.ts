import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeSshSession } from '../helpers/ssh.js'

// ── mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../../src/config/store.js', () => ({
  getConfig: vi.fn(),
  getConfigDir: vi.fn(() => '/tmp/clawops-test'),
}))

const { mockValidateConfig, mockAccessSync, mockMkdirSync, mockReadFileSync } = vi.hoisted(() => ({
  mockValidateConfig: vi.fn(),
  mockAccessSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}))
vi.mock('../../src/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ validateConfig: mockValidateConfig })),
}))
vi.mock('../../src/providers/aws/index.js', () => ({}))
vi.mock('../../src/providers/gcp/index.js', () => ({}))
vi.mock('../../src/providers/azure/index.js', () => ({}))
vi.mock('../../src/providers/local/index.js', () => ({}))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
const { mockCliStatus } = vi.hoisted(() => ({ mockCliStatus: vi.fn() }))
vi.mock('../../src/pulumi/cli.js', () => ({ pulumiCliStatus: mockCliStatus }))
const { mockPassphraseStatus } = vi.hoisted(() => ({ mockPassphraseStatus: vi.fn() }))
vi.mock('../../src/pulumi/passphrase.js', () => ({
  passphraseStatus: mockPassphraseStatus,
  passphrasePath: (dir: string) => `${dir}/secrets/pulumi-passphrase`,
}))
vi.mock('../../src/cli/context.js', () => ({
  buildContext: vi.fn(() => ({ adapter: { name: 'aws' } })),
}))
vi.mock('../../src/harden/index.js', () => ({
  MODULE_CATALOG: [],
  resolveModules: vi.fn(() => []),
  withRemoteExec: vi.fn(async (_c: unknown, _s: unknown, fn: (e: unknown) => Promise<void>) => fn({})),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    accessSync: mockAccessSync,
    mkdirSync: mockMkdirSync,
    // Defaults to the real one in beforeEach; individual tests override it to hand the SSH
    // key check specific key material.
    readFileSync: mockReadFileSync,
  }
})

import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { getConfig, getConfigDir } from '../../src/config/store.js'

const { readFileSync: realReadFileSync, mkdtempSync: realMkdtemp, rmSync: realRm } =
  await vi.importActual<typeof import('node:fs')>('node:fs')

/** A real OpenSSH key, because the check under test is "can ssh2 parse this". */
const REAL_ED25519_KEY = (() => {
  const dir = realMkdtemp(nodePath.join(tmpdir(), 'clawops-doctor-key-'))
  const keyPath = nodePath.join(dir, 'id_ed25519')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'clawops', '-q'])
  const contents = realReadFileSync(keyPath)
  realRm(dir, { recursive: true, force: true })
  return contents
})()
import { runDiagnostics, summarise, type Check, type DiagnosticsReport } from '../../src/diagnostics/index.js'

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

/** Every check in the report, flattened — assertions rarely care which section. */
function checks(report: DiagnosticsReport): Check[] {
  return report.sections.flatMap((s) => s.checks)
}
function find(report: DiagnosticsReport, name: string): Check | undefined {
  return checks(report).find((c) => c.name === name)
}

/** A healthy remote: container up, supported version, gateway answering, loopback only. */
function healthyHost(): FakeSshSession {
  return new FakeSshSession()
    .respond(/State\.Status/, { stdout: 'running' })
    .respond(/Config\.Image/, { stdout: 'ghcr.io/openclaw/openclaw:2026.9.2' })
    .respond(/startupz/, { stdout: '{"ok":true,"status":"started"}' })
    // Real `docker inspect --format '{{json .HostConfig.PortBindings}}'` output.
    // A looser fixture here passed the healthy case for the wrong reason: it never
    // matched the command, publishForRestart parsed '' , threw, and fell back to
    // 'loopback' — the answer the test wanted, from a probe that never ran.
    .respond(/PortBindings/, { stdout: '{"18789/tcp":[{"HostIp":"127.0.0.1","HostPort":"18789"}]}' })
    .respond(/df -h/, { stdout: '12% used (1.2G of 20G)' })
    .respond(/logrotate/, { stdout: 'configured' })
}

function withHost(session: FakeSshSession) {
  return {
    openSession: async () => ({
      session,
      release: () => {},
      conn: {
        host: 'h', port: 22, user: 'ubuntu',
        privateKeyPath: '/k', knownHostsPath: '/kh',
      },
    }),
  }
}

beforeEach(() => {
  mockPassphraseStatus.mockReset().mockReturnValue('stored')
  // The SSH key check parses real key material, so the fixture must come from the test rather
  // than from whatever happens to be at that path on this machine — locally that was the
  // developer's own key, and CI has none.
  mockReadFileSync.mockReset().mockImplementation(((file: unknown, ...rest: unknown[]) =>
    String(file).endsWith('id_ed25519')
      ? REAL_ED25519_KEY
      : (realReadFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as never)
  mockCliStatus.mockReset().mockResolvedValue({ kind: 'managed', version: 'v3.201.0', root: '/tmp/clawops-test/.pulumi-cli' })
  vi.clearAllMocks()
  mockGetConfigDir.mockReturnValue('/tmp/clawops-test')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockGetConfig.mockReturnValue(baseConfig as any)
  mockValidateConfig.mockResolvedValue({ ok: true, errors: [] })
  mockMkdirSync.mockImplementation(() => undefined)
  mockAccessSync.mockImplementation(() => undefined)
  vi.spyOn(process, 'version', 'get').mockReturnValue('v22.0.0')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runDiagnostics — local checks', () => {
  it('reports ok when everything passes', async () => {
    const report = await runDiagnostics()
    expect(report.ok).toBe(true)
    expect(report.counts.fail).toBe(0)
    expect(report.counts.pass).toBeGreaterThan(0)
  })

  it('makes no SSH connection without a stack', async () => {
    const openSession = vi.fn()
    const report = await runDiagnostics({}, { openSession })
    expect(openSession).not.toHaveBeenCalled()
    expect(report.sections.map((s) => s.title)).not.toContain('Remote health')
  })

  it('fails on an unreadable SSH key', async () => {
    mockAccessSync.mockImplementation((p: unknown, flag: unknown) => {
      if (String(p).includes('id_ed25519') && flag !== undefined) throw new Error('ENOENT')
    })
    const report = await runDiagnostics()
    expect(find(report, 'SSH key')?.status).toBe('fail')
    expect(report.ok).toBe(false)
  })

  it('fails on provider credential errors, naming each one', async () => {
    mockValidateConfig.mockResolvedValue({ ok: false, errors: ['AWS_PROFILE not set'] })
    const report = await runDiagnostics()
    const failed = checks(report).filter((c) => c.status === 'fail')
    expect(failed.map((c) => c.detail).join(' ')).toMatch(/AWS_PROFILE not set/)
    expect(report.ok).toBe(false)
  })

  it('checks each provider once, not once per stack', async () => {
    mockGetConfig.mockReturnValue({
      ...baseConfig,
      stacks: {
        default: { provider: 'aws' as const, region: 'us-east-1', stateUrl: 's3://b/c' },
        staging: { provider: 'aws' as const, region: 'eu-west-1', stateUrl: 's3://b/c2' },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await runDiagnostics()
    expect(mockValidateConfig).toHaveBeenCalledOnce()
  })

  it('fails an old Node.js rather than warning', async () => {
    vi.spyOn(process, 'version', 'get').mockReturnValue('v18.0.0')
    const report = await runDiagnostics()
    expect(find(report, 'Node.js')?.status).toBe('fail')
    expect(report.ok).toBe(false)
  })

  it('warns rather than fails when there is no config', async () => {
    mockGetConfig.mockReturnValue(null)
    const report = await runDiagnostics()
    // A machine that has never run `clawops init` is unconfigured, not broken. If this
    // failed, `doctor` would exit 1 on a fresh install and read as an error.
    expect(find(report, 'Config file')?.status).toBe('warn')
    expect(report.ok).toBe(true)
  })
})

describe('runDiagnostics — remote checks', () => {
  it('reports a healthy host', async () => {
    const report = await runDiagnostics({ stack: 'prod' }, withHost(healthyHost()))
    expect(report.ok).toBe(true)
    expect(find(report, 'Container')?.status).toBe('pass')
    expect(find(report, 'Gateway')?.status).toBe('pass')
    expect(find(report, 'Deployed')?.detail).toContain('2026.9.2')
  })

  it('fails when the gateway answers with the Control UI instead of JSON', async () => {
    // The catch-all SPA route answers 200 on any unmatched path, so a probe that only
    // checked the status code passed while the endpoint was gone (WO-44).
    const session = healthyHost().respond(/startupz/, { stdout: '<!doctype html><html>' })
    const report = await runDiagnostics({ stack: 'prod' }, withHost(session))
    const gateway = find(report, 'Gateway')
    expect(gateway?.status).toBe('fail')
    expect(gateway?.detail).toMatch(/HTML/)
    expect(report.ok).toBe(false)
  })

  it('fails when the gateway does not answer at all', async () => {
    const session = healthyHost().respond(/startupz/, { stdout: '' })
    const report = await runDiagnostics({ stack: 'prod' }, withHost(session))
    expect(find(report, 'Gateway')?.status).toBe('fail')
  })

  it('does not call the gateway healthy because the container is running', async () => {
    // Container up, gateway silent. These are different questions and the old doctor
    // only asked the first.
    const session = healthyHost().respond(/startupz/, { stdout: '' })
    const report = await runDiagnostics({ stack: 'prod' }, withHost(session))
    expect(find(report, 'Container')?.status).toBe('pass')
    expect(find(report, 'Gateway')?.status).toBe('fail')
    expect(report.ok).toBe(false)
  })

  it('fails an unsupported deployed version and points at migrate', async () => {
    const session = healthyHost().respond(/Config\.Image/, {
      stdout: 'ghcr.io/openclaw/openclaw:2026.7.1',
    })
    const report = await runDiagnostics({ stack: 'prod' }, withHost(session))
    const deployed = find(report, 'Deployed')
    expect(deployed?.status).toBe('fail')
    expect(deployed?.remedy).toMatch(/clawops migrate/)
  })

  it('warns on a moving tag', async () => {
    const session = healthyHost().respond(/Config\.Image/, {
      stdout: 'ghcr.io/openclaw/openclaw:latest',
    })
    const report = await runDiagnostics({ stack: 'prod' }, withHost(session))
    expect(find(report, 'Deployed')?.status).toBe('warn')
  })

  it('warns, and does not fail, when the port is published to every interface', async () => {
    const session = healthyHost().respond(/PortBindings/, {
      stdout: '{"18789/tcp":[{"HostIp":"0.0.0.0","HostPort":"18789"}]}',
    })
    const published = find(
      await runDiagnostics({ stack: 'prod' }, withHost(session)),
      'Published',
    )
    expect(published?.status).toBe('warn')
    expect(published?.remedy).toMatch(/tunnel|TLS/)
  })

  it('fails a full disk and warns a filling one', async () => {
    const full = healthyHost().respond(/df -h/, { stdout: '94% used (19G of 20G)' })
    expect(find(await runDiagnostics({ stack: 'prod' }, withHost(full)), 'Disk')?.status).toBe('fail')

    const filling = healthyHost().respond(/df -h/, { stdout: '80% used (16G of 20G)' })
    expect(find(await runDiagnostics({ stack: 'prod' }, withHost(filling)), 'Disk')?.status).toBe('warn')
  })

  it('reports a connection failure as a failed check, not a thrown error', async () => {
    const report = await runDiagnostics(
      { stack: 'prod' },
      { openSession: async () => { throw new Error('no such stack') } },
    )
    expect(find(report, 'Connection')?.status).toBe('fail')
    expect(find(report, 'Connection')?.detail).toMatch(/no such stack/)
    expect(report.ok).toBe(false)
  })

  it('releases the session even when a remote check throws', async () => {
    const release = vi.fn()
    const session = new FakeSshSession().respond(/State\.Status/, () => {
      throw new Error('docker exploded')
    })
    await expect(
      runDiagnostics(
        { stack: 'prod' },
        {
          openSession: async () => ({
            session, release,
            conn: { host: 'h', port: 22, user: 'u', privateKeyPath: '/k', knownHostsPath: '/kh' },
          }),
        },
      ),
    ).rejects.toThrow('docker exploded')
    expect(release).toHaveBeenCalled()
  })
})

describe('summarise', () => {
  it('counts every status and sets ok from failures alone', () => {
    const report = summarise([
      { title: 'A', checks: [{ name: 'a', status: 'pass' }, { name: 'b', status: 'warn' }] },
      { title: 'B', checks: [{ name: 'c', status: 'info' }] },
    ])
    expect(report.counts).toEqual({ pass: 1, fail: 0, warn: 1, info: 1 })
    expect(report.ok).toBe(true)
  })

  it('is not ok when any check failed', () => {
    expect(summarise([{ title: 'A', checks: [{ name: 'a', status: 'fail' }] }]).ok).toBe(false)
  })
})

describe('the Pulumi CLI check', () => {
  it('passes with the version and location of our own copy', async () => {
    mockGetConfig.mockReturnValue(null)
    mockCliStatus.mockResolvedValue({
      kind: 'managed',
      version: 'v3.201.0',
      root: '/tmp/clawops-test/.pulumi-cli',
    })
    const check = find(await runDiagnostics(), 'Pulumi CLI')
    expect(check?.status).toBe('pass')
    expect(check?.detail).toBe('v3.201.0 (/tmp/clawops-test/.pulumi-cli)')
  })

  it('says so when the CLI came from PATH rather than from us', async () => {
    mockGetConfig.mockReturnValue(null)
    mockCliStatus.mockResolvedValue({ kind: 'path', version: 'v3.150.0' })
    const check = find(await runDiagnostics(), 'Pulumi CLI')
    expect(check?.status).toBe('pass')
    expect(check?.detail).toBe('v3.150.0 (on PATH)')
  })

  it('warns when there is none, and names where the first apply will put it', async () => {
    mockGetConfig.mockReturnValue(null)
    mockCliStatus.mockResolvedValue({ kind: 'missing' })
    const report = await runDiagnostics()
    const check = find(report, 'Pulumi CLI')
    expect(check?.status).toBe('warn')
    expect(check?.detail).toBe('not installed')
    expect(check?.remedy).toContain('/tmp/clawops-test/.pulumi-cli')
    // A machine that has never deployed is not a broken machine — `ok` stays with the fails.
    expect(report.ok).toBe(true)
  })

  it('is measured against the config dir, not the process CWD (R7)', async () => {
    mockGetConfig.mockReturnValue(null)
    mockGetConfigDir.mockReturnValue('/elsewhere/.clawops')
    await runDiagnostics()
    expect(mockCliStatus).toHaveBeenCalledWith('/elsewhere/.clawops')
  })

  it('is reported in the Runtime section, beside the other prerequisites', async () => {
    mockGetConfig.mockReturnValue(null)
    const report = await runDiagnostics()
    const runtime = report.sections.find((s) => s.title === 'Runtime')
    expect(runtime?.checks.map((c) => c.name)).toContain('Pulumi CLI')
  })
})

describe('the state passphrase check', () => {
  it('passes and names the file, telling the operator to keep it', async () => {
    mockGetConfig.mockReturnValue(null)
    const check = find(await runDiagnostics(), 'State passphrase')
    expect(check?.status).toBe('pass')
    expect(check?.detail).toBe('/tmp/clawops-test/secrets/pulumi-passphrase')
    // Losing it makes an existing stack's secrets unreadable — the one piece of clawops state
    // that cannot be regenerated.
    expect(check?.remedy).toMatch(/back this up/)
  })

  it('says so when the operator supplies their own', async () => {
    mockGetConfig.mockReturnValue(null)
    mockPassphraseStatus.mockReturnValue('environment')
    const check = find(await runDiagnostics(), 'State passphrase')
    expect(check?.status).toBe('pass')
    expect(check?.detail).toMatch(/PULUMI_CONFIG_PASSPHRASE/)
  })

  it('warns before first use without failing a fresh machine', async () => {
    mockGetConfig.mockReturnValue(null)
    mockPassphraseStatus.mockReturnValue('absent')
    const report = await runDiagnostics()
    expect(find(report, 'State passphrase')?.status).toBe('warn')
    expect(report.ok).toBe(true)
  })
})

describe('the SSH key check', () => {
  it('fails a readable key that ssh2 cannot use, and says how to replace it', async () => {
    // Readable is not usable: a PKCS#8 PEM is a perfectly good key file that ssh2 cannot
    // parse. This check passed on one, and every SSH command then failed at connect time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetConfig.mockReturnValue(baseConfig as any)
    mockAccessSync.mockImplementation(() => undefined)
    mockReadFileSync.mockReturnValue(
      '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPPf60xCO0DaINAtOfOAMqn1MD4023YeF98CSxEQy2lG\n-----END PRIVATE KEY-----\n',
    )
    const check = find(await runDiagnostics(), 'SSH key')
    expect(check?.status).toBe('fail')
    expect(check?.remedy).toMatch(/ssh-keygen -t ed25519/)
  })

  it('passes a usable key and names its type', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetConfig.mockReturnValue(baseConfig as any)
    mockAccessSync.mockImplementation(() => undefined)
    mockReadFileSync.mockReturnValue(REAL_ED25519_KEY)
    const check = find(await runDiagnostics(), 'SSH key')
    expect(check?.status).toBe('pass')
    expect(check?.detail).toMatch(/ssh-ed25519/)
  })
})
