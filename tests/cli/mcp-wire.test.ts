import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  wireGatewayMcp,
  GATEWAY_MCP_MIN_VERSION,
  GATEWAY_MCP_ENTRY,
} from '../../src/cli/mcp-wire.js'
import type { SshSession } from '../../src/transport/ssh.js'

const mockReadRemoteConfig = vi.fn()
const mockAtomicWriteConfig = vi.fn()
const mockDeepMerge = vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) }))
const mockRestartGateway = vi.fn()

vi.mock('../../src/plan/remote-config.js', () => ({
  readRemoteConfig: (...args: unknown[]) => mockReadRemoteConfig(...args),
  atomicWriteConfig: (...args: unknown[]) => mockAtomicWriteConfig(...args),
  deepMerge: (...args: unknown[]) => mockDeepMerge(...args),
  restartGateway: (...args: unknown[]) => mockRestartGateway(...args),
}))

function makeSession(): SshSession {
  return { exec: vi.fn(), close: vi.fn() } as unknown as SshSession
}

const signal = AbortSignal.timeout(5_000)

beforeEach(() => {
  vi.clearAllMocks()
  mockAtomicWriteConfig.mockResolvedValue(undefined)
  mockRestartGateway.mockResolvedValue(undefined)
})

describe('wireGatewayMcp', () => {
  describe('version check', () => {
    it('returns version-blocked when gateway version is below minimum', async () => {
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: '2025.12' } })
      const result = await wireGatewayMcp(makeSession(), signal)
      expect(result).toEqual({ status: 'version-blocked', version: '2025.12' })
    })

    it('returns version-blocked for same year, earlier month', async () => {
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: '2026.3' } })
      const result = await wireGatewayMcp(makeSession(), signal)
      expect(result).toEqual({ status: 'version-blocked', version: '2026.3' })
    })

    it('proceeds when gateway version meets the minimum', async () => {
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: GATEWAY_MCP_MIN_VERSION } })
      const result = await wireGatewayMcp(makeSession(), signal)
      expect(result.status).toBe('wired')
    })

    it('proceeds when gateway version is newer', async () => {
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: '2027.1' } })
      const result = await wireGatewayMcp(makeSession(), signal)
      expect(result.status).toBe('wired')
    })

    it('proceeds when version is missing (no meta)', async () => {
      mockReadRemoteConfig.mockResolvedValue({})
      const result = await wireGatewayMcp(makeSession(), signal)
      expect(result.status).toBe('wired')
    })

    it('bypasses version check when force is true', async () => {
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: '2024.1' } })
      const result = await wireGatewayMcp(makeSession(), signal, { force: true })
      expect(result.status).toBe('wired')
    })
  })

  describe('rewired detection', () => {
    it('sets rewired: false when no existing clawops entry', async () => {
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: '2026.4' } })
      const result = await wireGatewayMcp(makeSession(), signal)
      expect(result).toEqual({ status: 'wired', rewired: false })
    })

    it('sets rewired: true when clawops entry already exists', async () => {
      mockReadRemoteConfig.mockResolvedValue({
        meta: { lastTouchedVersion: '2026.4' },
        gateway: { mcpClients: { clawops: { command: 'old' } } },
      })
      const result = await wireGatewayMcp(makeSession(), signal)
      expect(result).toEqual({ status: 'wired', rewired: true })
    })
  })

  describe('config write', () => {
    it('calls atomicWriteConfig and restartGateway', async () => {
      const session = makeSession()
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: '2026.4' } })
      await wireGatewayMcp(session, signal)
      expect(mockAtomicWriteConfig).toHaveBeenCalledOnce()
      expect(mockRestartGateway).toHaveBeenCalledWith(session, signal)
    })

    it('merges the GATEWAY_MCP_ENTRY into config', async () => {
      mockReadRemoteConfig.mockResolvedValue({ meta: { lastTouchedVersion: '2026.4' } })
      await wireGatewayMcp(makeSession(), signal)
      expect(mockDeepMerge).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          gateway: { mcpClients: { clawops: GATEWAY_MCP_ENTRY } },
        }),
      )
    })
  })
})
