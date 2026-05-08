// Unit tests for src/providers/firewall.ts — resolveIngressCidrs and detectEgressIp.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveIngressCidrs, detectEgressIp } from '../../src/providers/firewall.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveIngressCidrs — restricted mode', () => {
  it('returns empty array when allowedCidrs is empty', () => {
    expect(resolveIngressCidrs('restricted', '', '', '')).toEqual([])
  })

  it('returns empty array when allowedCidrs is whitespace only', () => {
    expect(resolveIngressCidrs('restricted', '  ', '', '')).toEqual([])
  })

  it('returns the single CIDR when one is provided', () => {
    expect(resolveIngressCidrs('restricted', '10.0.0.1/32', '', '')).toEqual(['10.0.0.1/32'])
  })

  it('splits and trims comma-separated CIDRs', () => {
    expect(resolveIngressCidrs('restricted', ' 10.0.0.1/32 , 10.0.0.2/32 ', '', '')).toEqual([
      '10.0.0.1/32',
      '10.0.0.2/32',
    ])
  })

  it('filters out empty entries from comma-separated list', () => {
    expect(resolveIngressCidrs('restricted', '10.0.0.1/32,,', '', '')).toEqual(['10.0.0.1/32'])
  })
})

describe('resolveIngressCidrs — auto mode', () => {
  it('appends /32 when detectedIp has no mask', () => {
    expect(resolveIngressCidrs('auto', '', '', '203.0.113.1')).toEqual(['203.0.113.1/32'])
  })

  it('preserves existing mask when detectedIp already has one', () => {
    expect(resolveIngressCidrs('auto', '', '', '203.0.113.1/32')).toEqual(['203.0.113.1/32'])
  })

  it('returns empty array when detectedIp is empty', () => {
    expect(resolveIngressCidrs('auto', '', '', '')).toEqual([])
  })

  it('returns empty array when detectedIp is whitespace', () => {
    expect(resolveIngressCidrs('auto', '', '', '   ')).toEqual([])
  })
})

describe('resolveIngressCidrs — open mode', () => {
  it('returns 0.0.0.0/0', () => {
    expect(resolveIngressCidrs('open', '', '', '')).toEqual(['0.0.0.0/0'])
  })
})

describe('resolveIngressCidrs — unknown mode', () => {
  it('returns empty array for unknown accessMode', () => {
    expect(resolveIngressCidrs('unknown', '10.0.0.1/32', '', '')).toEqual([])
  })
})

describe('resolveIngressCidrs — portOverride precedence', () => {
  it('portOverride takes precedence over restricted mode', () => {
    const result = resolveIngressCidrs('restricted', '10.0.0.1/32', '192.168.1.0/24', '')
    expect(result).toEqual(['192.168.1.0/24'])
  })

  it('portOverride takes precedence over auto mode', () => {
    const result = resolveIngressCidrs('auto', '', '192.168.1.0/24', '203.0.113.1')
    expect(result).toEqual(['192.168.1.0/24'])
  })

  it('portOverride takes precedence over open mode', () => {
    const result = resolveIngressCidrs('open', '', '10.0.0.5/32', '')
    expect(result).toEqual(['10.0.0.5/32'])
  })

  it('splits and trims portOverride CIDRs', () => {
    const result = resolveIngressCidrs('restricted', '', ' 10.0.0.1/32 , 10.0.0.2/32 ', '')
    expect(result).toEqual(['10.0.0.1/32', '10.0.0.2/32'])
  })

  it('portOverride whitespace-only does NOT override (falls through to mode)', () => {
    const result = resolveIngressCidrs('open', '', '   ', '')
    expect(result).toEqual(['0.0.0.0/0'])
  })
})

describe('detectEgressIp', () => {
  it('returns the IP from a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('203.0.113.42\n', { status: 200 }),
    )

    const ip = await detectEgressIp('https://checkip.test')
    expect(ip).toBe('203.0.113.42')
  })

  it('returns empty string when response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }),
    )

    const ip = await detectEgressIp('https://checkip.test')
    expect(ip).toBe('')
  })

  it('returns empty string when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    const ip = await detectEgressIp('https://checkip.test')
    expect(ip).toBe('')
  })

  it('trims whitespace from response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('  10.0.0.1  \n', { status: 200 }),
    )

    const ip = await detectEgressIp('https://checkip.test')
    expect(ip).toBe('10.0.0.1')
  })
})
