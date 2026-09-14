import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

const { mockGet, mockInstall } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockInstall: vi.fn(),
}))
vi.mock('@pulumi/pulumi/automation', () => ({
  PulumiCommand: { get: mockGet, install: mockInstall },
}))

import { pulumiCliRoot, pulumiCliStatus, ensurePulumiCli } from '../../src/pulumi/cli.js'

const CONFIG_DIR = '/home/u/.clawops'
const ROOT = '/home/u/.clawops/.pulumi-cli'

/** What PulumiCommand.get resolves to — only `version` is read. */
function cmd(version: string | null) {
  return { command: 'pulumi', version: version === null ? null : { toString: () => version } }
}

/** Resolve for a lookup with these opts, reject for every other. */
function resolveFor(match: (opts: unknown) => boolean, value: unknown) {
  return (opts?: unknown) =>
    match(opts) ? Promise.resolve(value) : Promise.reject(new Error('spawn pulumi ENOENT'))
}
const isRootLookup = (o: unknown) => (o as { root?: string } | undefined)?.root === ROOT
const isPathLookup = (o: unknown) => o === undefined

beforeEach(() => {
  mockGet.mockReset()
  mockInstall.mockReset()
})

describe('pulumiCliRoot', () => {
  it('is a sibling of the Pulumi home, not the home itself', () => {
    expect(pulumiCliRoot(CONFIG_DIR)).toBe(ROOT)
    // The CLI's *home* (state, plugins) is `.pulumi`. Installing the binary into it would
    // put clawops' files where the CLI expects its own.
    expect(pulumiCliRoot(CONFIG_DIR)).not.toBe('/home/u/.clawops/.pulumi')
  })
})

describe('pulumiCliStatus', () => {
  it('reports our own copy, with its version and root', async () => {
    mockGet.mockImplementation(resolveFor(isRootLookup, cmd('3.201.0')))
    await expect(pulumiCliStatus(CONFIG_DIR)).resolves.toEqual({
      kind: 'managed',
      version: 'v3.201.0',
      root: ROOT,
    })
  })

  it('prefers our own copy over one on PATH', async () => {
    // Both resolve. Ours is pinned to the SDK the programs were written against, so it wins.
    mockGet.mockImplementation((opts?: unknown) =>
      Promise.resolve(isRootLookup(opts) ? cmd('3.201.0') : cmd('3.99.0')),
    )
    await expect(pulumiCliStatus(CONFIG_DIR)).resolves.toMatchObject({
      kind: 'managed',
      version: 'v3.201.0',
    })
  })

  it('falls back to a CLI on PATH when we have no copy', async () => {
    mockGet.mockImplementation(resolveFor(isPathLookup, cmd('3.150.0')))
    await expect(pulumiCliStatus(CONFIG_DIR)).resolves.toEqual({ kind: 'path', version: 'v3.150.0' })
  })

  it('reports missing when neither lookup finds one', async () => {
    mockGet.mockRejectedValue(new Error('spawn pulumi ENOENT'))
    await expect(pulumiCliStatus(CONFIG_DIR)).resolves.toEqual({ kind: 'missing' })
  })

  it('names the version even when the CLI does not report one', async () => {
    mockGet.mockImplementation(resolveFor(isRootLookup, cmd(null)))
    await expect(pulumiCliStatus(CONFIG_DIR)).resolves.toMatchObject({ version: 'unknown version' })
  })

  it('never installs — doctor must not change what it measures', async () => {
    mockGet.mockRejectedValue(new Error('spawn pulumi ENOENT'))
    await pulumiCliStatus(CONFIG_DIR)
    expect(mockInstall).not.toHaveBeenCalled()
  })
})

describe('ensurePulumiCli', () => {
  it('returns our own copy without installing or announcing', async () => {
    const found = cmd('3.201.0')
    mockGet.mockImplementation(resolveFor(isRootLookup, found))
    const onInstall = vi.fn()
    await expect(ensurePulumiCli({ configDir: CONFIG_DIR, onInstall })).resolves.toBe(found)
    expect(mockInstall).not.toHaveBeenCalled()
    expect(onInstall).not.toHaveBeenCalled()
  })

  it('uses a CLI already on PATH rather than downloading one', async () => {
    const found = cmd('3.150.0')
    mockGet.mockImplementation(resolveFor(isPathLookup, found))
    const onInstall = vi.fn()
    await expect(ensurePulumiCli({ configDir: CONFIG_DIR, onInstall })).resolves.toBe(found)
    expect(mockInstall).not.toHaveBeenCalled()
    expect(onInstall).not.toHaveBeenCalled()
  })

  it('installs into our root when there is none, announcing first', async () => {
    mockGet.mockRejectedValue(new Error('spawn pulumi ENOENT'))
    const installed = cmd('3.201.0')
    mockInstall.mockResolvedValue(installed)
    const order: string[] = []
    const onInstall = vi.fn(() => void order.push('announce'))
    mockInstall.mockImplementation(() => {
      order.push('install')
      return Promise.resolve(installed)
    })

    await expect(ensurePulumiCli({ configDir: CONFIG_DIR, onInstall })).resolves.toBe(installed)
    expect(mockInstall).toHaveBeenCalledWith({ root: ROOT })
    expect(onInstall).toHaveBeenCalledWith({ root: ROOT })
    // Announcing after the download would defeat the point: the wait is what needs explaining.
    expect(order).toEqual(['announce', 'install'])
  })

  it('explains a failed install, keeping the underlying reason and a manual remedy', async () => {
    mockGet.mockRejectedValue(new Error('spawn pulumi ENOENT'))
    mockInstall.mockRejectedValue(new Error('getaddrinfo ENOTFOUND get.pulumi.com'))
    await expect(
      ensurePulumiCli({ configDir: CONFIG_DIR, onInstall: vi.fn() }),
    ).rejects.toThrow(
      /could not install the Pulumi CLI into \/home\/u\/\.clawops\/\.pulumi-cli: getaddrinfo ENOTFOUND get\.pulumi\.com[\s\S]*pulumi\.com\/docs\/install/,
    )
  })

  describe('the default announcement', () => {
    let stderr: MockInstance<typeof process.stderr.write>
    let stdout: MockInstance<typeof process.stdout.write>
    beforeEach(() => {
      stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    })
    afterEach(() => {
      stderr.mockRestore()
      stdout.mockRestore()
    })

    it('goes to stderr and never stdout (R15)', async () => {
      mockGet.mockRejectedValue(new Error('spawn pulumi ENOENT'))
      mockInstall.mockResolvedValue(cmd('3.201.0'))

      await ensurePulumiCli({ configDir: CONFIG_DIR })

      expect(stderr).toHaveBeenCalledTimes(1)
      expect(stderr.mock.calls[0]?.[0]).toContain(ROOT)
      // A stdio MCP server that prints one stray byte here corrupts the protocol.
      expect(stdout).not.toHaveBeenCalled()
    })
  })
})
