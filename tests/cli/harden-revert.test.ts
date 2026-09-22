// `clawops harden --tailscale-revert`: leave the tailnet over the public address, never over the
// tailnet itself, and never when the public address cannot be reached.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  buildContext: vi.fn(),
  probeSsh: vi.fn(),
  leaveTailnet: vi.fn(),
  withRemoteExec: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  forgetHost: vi.fn(),
}))
vi.mock('../../src/cli/context.js', () => ({ buildContext: h.buildContext }))
vi.mock('../../src/harden/tailscale-cutover.js', () => ({ probeSsh: h.probeSsh, leaveTailnet: h.leaveTailnet }))
vi.mock('../../src/harden/index.js', () => ({
  MODULE_CATALOG: [],
  resolveModules: vi.fn(() => []),
  runHardening: vi.fn(),
  formatHardenSummary: vi.fn(),
  makeTailscaleModule: vi.fn(),
  withRemoteExec: h.withRemoteExec,
}))
vi.mock('../../src/config/store.js', () => ({ getConfig: h.getConfig, setConfig: h.setConfig }))
vi.mock('../../src/transport/known-hosts-file.js', () => ({ forgetHost: h.forgetHost }))

const TAILNET = { ip: '100.96.109.52', verifiedAt: '2026-09-22T00:00:00.000Z' }
const PUBLIC = '34.200.67.239'
const OUTPUTS = {
  instanceId: { value: 'i-0abc' }, publicIp: { value: PUBLIC }, gatewayUrl: { value: 'http://gw' },
  region: { value: 'us-east-1' }, provisionedAt: { value: '2026-09-22T00:00:00.000Z' },
  sshHost: { value: PUBLIC }, sshPort: { value: 22 }, sshUser: { value: 'ubuntu' },
}

function configWith(tailscale?: object) {
  return {
    version: 1,
    defaults: { stack: 'prod', provider: 'aws' },
    stacks: { prod: { provider: 'aws', stateUrl: 's3://b', credentialsRef: { source: 'cli-profile' }, ...(tailscale ? { tailscale } : {}) } },
    ssh: { keyPath: '/k', knownHostsPath: '/kh' },
  }
}

/** buildContext as the real one behaves: the override redirects the host unless told to ignore it. */
function contextFor(config: ReturnType<typeof configWith>) {
  h.buildContext.mockImplementation((args: { ignoreTailnet?: boolean }) => {
    const override = args.ignoreTailnet ? undefined : (config.stacks.prod as { tailscale?: { ip: string } }).tailscale
    return {
      config,
      stackName: 'prod',
      adapter: {
        name: 'aws',
        getConnectionInfo: (o: Record<string, unknown>) => ({
          host: override?.ip ?? String(o['sshHost']),
          port: Number(o['sshPort']),
          user: String(o['sshUser']),
          privateKeyPath: String(o['privateKeyPath']),
          knownHostsPath: String(o['knownHostsPath']),
        }),
      },
      getStack: async () => ({ outputs: async () => OUTPUTS }),
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmd: any

beforeEach(async () => {
  vi.clearAllMocks()
  h.withRemoteExec.mockImplementation(async (_conn: unknown, _signal: unknown, fn: (exec: unknown) => unknown) => fn(vi.fn()))
  h.leaveTailnet.mockResolvedValue({ ok: true })
  h.probeSsh.mockResolvedValue(true)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
  cmd = (await import('../../src/cli/commands/harden.js')).default
})
afterEach(() => vi.restoreAllMocks())

function setUp(tailscale?: object) {
  const config = configWith(tailscale)
  h.getConfig.mockReturnValue(config)
  contextFor(config)
}

const run = (extra: Record<string, unknown> = {}) =>
  cmd.run({ args: { 'tailscale-revert': true, yes: true, ...extra } })

describe('harden --tailscale-revert', () => {
  it('leaves over the public address, then forgets the tailnet one', async () => {
    setUp(TAILNET)
    await run()
    expect(h.probeSsh).toHaveBeenCalledWith(expect.objectContaining({ host: PUBLIC }))
    expect(h.withRemoteExec).toHaveBeenCalledWith(expect.objectContaining({ host: PUBLIC }), undefined, expect.any(Function))
    expect(h.leaveTailnet).toHaveBeenCalledOnce()
    const written = h.setConfig.mock.calls[0]?.[0]
    expect(written.stacks.prod).not.toHaveProperty('tailscale')
    expect(written.stacks.prod.provider).toBe('aws')
    expect(h.forgetHost).toHaveBeenCalledWith('/kh', TAILNET.ip, 22)
  })

  it('does nothing on a stack that never joined', async () => {
    setUp()
    await run()
    expect(h.probeSsh).not.toHaveBeenCalled()
    expect(h.leaveTailnet).not.toHaveBeenCalled()
    expect(h.setConfig).not.toHaveBeenCalled()
  })

  it('refuses on a private-only stack, and says how to reopen it', async () => {
    setUp({ ...TAILNET, privateOnly: true })
    h.probeSsh.mockResolvedValue(false)
    const errs: string[] = []
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => void errs.push(a.join(' ')))
    vi.mocked(process.stderr.write).mockImplementation(((s: string) => (errs.push(String(s)), true)) as never)
    await expect(run()).rejects.toThrow('exit 1')
    expect(errs.join('\n')).toMatch(/clawops plan --stack prod --ssh-cidr auto/)
    expect(h.leaveTailnet).not.toHaveBeenCalled()
    expect(h.setConfig).not.toHaveBeenCalled()
    expect(h.forgetHost).not.toHaveBeenCalled()
  })

  it('refuses when the public address does not answer, private-only or not', async () => {
    setUp(TAILNET)
    h.probeSsh.mockResolvedValue(false)
    await expect(run()).rejects.toThrow('exit 1')
    expect(h.leaveTailnet).not.toHaveBeenCalled()
    expect(h.setConfig).not.toHaveBeenCalled()
  })

  it('keeps the override when the host would not leave', async () => {
    setUp(TAILNET)
    h.leaveTailnet.mockResolvedValue({ ok: false, reason: 'tailscale logout failed on the host: boom' })
    await expect(run()).rejects.toThrow('exit 1')
    expect(h.setConfig).not.toHaveBeenCalled()
    expect(h.forgetHost).not.toHaveBeenCalled()
  })

  it('runs no hardening modules', async () => {
    setUp(TAILNET)
    const { runHardening } = await import('../../src/harden/index.js')
    await run()
    expect(runHardening).not.toHaveBeenCalled()
  })
})
