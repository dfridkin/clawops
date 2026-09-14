// Unit tests for src/providers/firewall.ts — resolveIngressCidrs and detectEgressIp.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveIngressCidrs, detectEgressIp } from '../../src/providers/firewall.js'
import type { EgressIpResult } from '../../src/providers/firewall.js'

const ok = (ip: string): EgressIpResult => ({ ok: true, ip })
const fail = (error: string): EgressIpResult => ({ ok: false, error })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveIngressCidrs — restricted mode', () => {
  it('returns empty array when allowedCidrs is empty', () => {
    expect(resolveIngressCidrs('restricted', '', '', ok(''))).toEqual([])
  })

  it('returns empty array when allowedCidrs is whitespace only', () => {
    expect(resolveIngressCidrs('restricted', '  ', '', ok(''))).toEqual([])
  })

  it('returns the single CIDR when one is provided', () => {
    expect(resolveIngressCidrs('restricted', '10.0.0.1/32', '', ok(''))).toEqual(['10.0.0.1/32'])
  })

  it('splits and trims comma-separated CIDRs', () => {
    expect(
      resolveIngressCidrs('restricted', ' 10.0.0.1/32 , 10.0.0.2/32 ', '', ok('')),
    ).toEqual(['10.0.0.1/32', '10.0.0.2/32'])
  })

  it('filters out empty entries from comma-separated list', () => {
    expect(resolveIngressCidrs('restricted', '10.0.0.1/32,,', '', ok(''))).toEqual(['10.0.0.1/32'])
  })
})

describe('resolveIngressCidrs — auto mode', () => {
  it('appends /32 when detectedIp has no mask', () => {
    expect(resolveIngressCidrs('auto', '', '', ok('203.0.113.1'))).toEqual(['203.0.113.1/32'])
  })

  it('preserves existing mask when detectedIp already has one', () => {
    expect(resolveIngressCidrs('auto', '', '', ok('203.0.113.1/32'))).toEqual(['203.0.113.1/32'])
  })

  it('throws when detection failed (ok: false) — never silently locks out', () => {
    expect(() =>
      resolveIngressCidrs('auto', '', '', fail('timeout')),
    ).toThrow(/egress IP detection failed/)
  })

  it('throws when detection returned empty IP', () => {
    expect(() =>
      resolveIngressCidrs('auto', '', '', ok('')),
    ).toThrow(/empty address/)
  })

  it('throws when detection returned whitespace IP', () => {
    expect(() =>
      resolveIngressCidrs('auto', '', '', ok('   ')),
    ).toThrow()
  })

  it('error message includes the detection error detail', () => {
    expect(() =>
      resolveIngressCidrs('auto', '', '', fail('HTTP 503 from https://ifconfig.me')),
    ).toThrow(/HTTP 503/)
  })
})

describe('resolveIngressCidrs — open mode', () => {
  it('returns 0.0.0.0/0', () => {
    expect(resolveIngressCidrs('open', '', '', ok(''))).toEqual(['0.0.0.0/0'])
  })
})

describe('resolveIngressCidrs — unknown mode', () => {
  it('returns empty array for unknown accessMode', () => {
    expect(resolveIngressCidrs('unknown', '10.0.0.1/32', '', ok(''))).toEqual([])
  })
})

describe('resolveIngressCidrs — portOverride precedence', () => {
  it('portOverride takes precedence over restricted mode', () => {
    expect(
      resolveIngressCidrs('restricted', '10.0.0.1/32', '192.168.1.0/24', ok('')),
    ).toEqual(['192.168.1.0/24'])
  })

  it('portOverride takes precedence over auto mode (skips detection entirely)', () => {
    expect(
      resolveIngressCidrs('auto', '', '192.168.1.0/24', fail('never reached')),
    ).toEqual(['192.168.1.0/24'])
  })

  it('portOverride takes precedence over open mode', () => {
    expect(resolveIngressCidrs('open', '', '10.0.0.5/32', ok(''))).toEqual(['10.0.0.5/32'])
  })

  it('splits and trims portOverride CIDRs', () => {
    expect(
      resolveIngressCidrs('restricted', '', ' 10.0.0.1/32 , 10.0.0.2/32 ', ok('')),
    ).toEqual(['10.0.0.1/32', '10.0.0.2/32'])
  })

  it('portOverride whitespace-only falls through to mode', () => {
    expect(resolveIngressCidrs('open', '', '   ', ok(''))).toEqual(['0.0.0.0/0'])
  })
})

describe('detectEgressIp', () => {
  it('returns ok:true with the IP from a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('203.0.113.42\n', { status: 200 }),
    )
    const result = await detectEgressIp('https://ifconfig.me')
    expect(result).toEqual({ ok: true, ip: '203.0.113.42' })
  })

  it('returns ok:false when response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }),
    )
    const result = await detectEgressIp('https://ifconfig.me')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('503')
  })

  it('returns ok:false when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))
    const result = await detectEgressIp('https://ifconfig.me')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('network error')
  })

  it('returns ok:false when response body is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('   \n', { status: 200 }),
    )
    const result = await detectEgressIp('https://ifconfig.me')
    expect(result.ok).toBe(false)
  })

  it('trims whitespace from response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('  10.0.0.1  \n', { status: 200 }),
    )
    const result = await detectEgressIp('https://ifconfig.me')
    expect(result).toEqual({ ok: true, ip: '10.0.0.1' })
  })
})

describe('detectEgressIp — responses that are not an address', () => {
  it('asks for text, because ifconfig.me serves HTML to anything that is not curl', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('203.0.113.42\n', { status: 200 }),
    )
    await detectEgressIp('https://ifconfig.me/ip')
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>)['accept']).toBe('text/plain')
  })

  it('refuses an HTML page instead of reporting it as an IP', async () => {
    // This shipped: the "detected IP" was a 4KB document, and it travelled into a plan as a
    // firewall rule because the value was never checked for being an address.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!DOCTYPE html>\n<html><body>203.0.113.42</body></html>', { status: 200 }),
    )
    const result = await detectEgressIp('https://ifconfig.me')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toMatch(/did not return an IP address/)
  })

  it('quotes only a fragment of an unexpected body, never the whole thing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(4096), { status: 200 }))
    const result = await detectEgressIp('https://ifconfig.me')
    expect((result as { ok: false; error: string }).error.length).toBeLessThan(120)
  })

  it('accepts a plain IPv4 address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('203.0.113.42', { status: 200 }))
    await expect(detectEgressIp('u')).resolves.toEqual({ ok: true, ip: '203.0.113.42' })
  })

  it('accepts IPv6', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('2001:db8::1', { status: 200 }))
    await expect(detectEgressIp('u')).resolves.toEqual({ ok: true, ip: '2001:db8::1' })
  })

  it('refuses an octet out of range', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('999.0.113.42', { status: 200 }))
    expect((await detectEgressIp('u')).ok).toBe(false)
  })

  it('refuses an address that arrives with a prefix already attached', async () => {
    // Callers append /32 themselves; a value that already has one would become a /32/32.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('203.0.113.42/32', { status: 200 }))
    expect((await detectEgressIp('u')).ok).toBe(false)
  })
})
