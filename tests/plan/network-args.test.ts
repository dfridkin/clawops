import { describe, it, expect, vi } from 'vitest'
import {
  isCidr, parseCidrList, parsePublishGateway, resolveNetworkFlags,
} from '../../src/plan/network-args.js'

const detected = (ip: string) => ({ detectEgressIp: vi.fn().mockResolvedValue({ ok: true, ip }) })
const failed = (error: string) => ({ detectEgressIp: vi.fn().mockResolvedValue({ ok: false, error }) })

describe('isCidr', () => {
  it('accepts an address with a prefix', () => {
    expect(isCidr('203.0.113.4/32')).toBe(true)
    expect(isCidr('10.0.0.0/8')).toBe(true)
    expect(isCidr(' 10.0.0.0/8 ')).toBe(true)
  })

  it('rejects an address without one — a bare IP is not a range', () => {
    expect(isCidr('203.0.113.4')).toBe(false)
  })

  it('rejects a prefix wider than the address space', () => {
    expect(isCidr('10.0.0.0/33')).toBe(false)
  })

  it('accepts IPv6 without parsing it, as the wizard always has', () => {
    expect(isCidr('::/0')).toBe(true)
    expect(isCidr('2001:db8::/32')).toBe(true)
  })
})

describe('parseCidrList', () => {
  it('splits on commas and trims', () => {
    expect(parseCidrList('--ssh-cidr', '10.0.0.0/8, 203.0.113.4/32')).toEqual([
      '10.0.0.0/8',
      '203.0.113.4/32',
    ])
  })

  it('treats an empty value as none rather than an error', () => {
    expect(parseCidrList('--ssh-cidr', '')).toEqual([])
    expect(parseCidrList('--ssh-cidr', ' , ')).toEqual([])
  })

  it('names the flag and the offending value when one is not a CIDR', () => {
    expect(() => parseCidrList('--ssh-cidr', '10.0.0.0/8,nonsense')).toThrow(
      /--ssh-cidr: "nonsense" is not a CIDR/,
    )
  })

  it('refuses a bare IP rather than guessing /32', () => {
    // Guessing would silently narrow or widen what the operator asked for.
    expect(() => parseCidrList('--ssh-cidr', '203.0.113.4')).toThrow(/not a CIDR/)
  })
})

describe('parsePublishGateway', () => {
  it('accepts the two values the plan schema allows', () => {
    expect(parsePublishGateway('loopback')).toBe('loopback')
    expect(parsePublishGateway(' all ')).toBe('all')
  })

  it('rejects anything else, quoting what was passed', () => {
    expect(() => parsePublishGateway('public')).toThrow(/expected "loopback" or "all", got "public"/)
  })
})

describe('resolveNetworkFlags', () => {
  it('leaves both lists empty when neither flag is passed', async () => {
    const deps = detected('203.0.113.4')
    await expect(resolveNetworkFlags({}, deps)).resolves.toEqual({
      allowedSshCidrs: [],
      allowedGatewayCidrs: [],
    })
    // No flag, no network call.
    expect(deps.detectEgressIp).not.toHaveBeenCalled()
  })

  it('resolves `auto` to this machine as a /32', async () => {
    await expect(resolveNetworkFlags({ sshCidr: 'auto' }, detected('203.0.113.4'))).resolves
      .toMatchObject({ allowedSshCidrs: ['203.0.113.4/32'] })
  })

  it('does not append a second prefix when the lookup already returned one', async () => {
    await expect(resolveNetworkFlags({ sshCidr: 'auto' }, detected('203.0.113.4/32'))).resolves
      .toMatchObject({ allowedSshCidrs: ['203.0.113.4/32'] })
  })

  it('trims the address before using it', async () => {
    await expect(resolveNetworkFlags({ sshCidr: 'auto' }, detected(' 203.0.113.4\n'))).resolves
      .toMatchObject({ allowedSshCidrs: ['203.0.113.4/32'] })
  })

  it('refuses when detection fails, keeping the reason', async () => {
    // Falling back to no rules makes an unreachable host; falling back to 0.0.0.0/0 is what
    // N10 forbids. Neither is a better answer than stopping.
    await expect(
      resolveNetworkFlags({ sshCidr: 'auto' }, failed('getaddrinfo ENOTFOUND ifconfig.me')),
    ).rejects.toThrow(/--ssh-cidr auto: could not detect.*ENOTFOUND ifconfig\.me/s)
  })

  it('refuses when detection succeeds with nothing in it', async () => {
    await expect(resolveNetworkFlags({ sshCidr: 'auto' }, detected('  '))).rejects.toThrow(
      /empty address/,
    )
  })

  it('resolves the gateway flag the same way, under its own name', async () => {
    await expect(
      resolveNetworkFlags({ gatewayCidr: 'auto' }, detected('203.0.113.4')),
    ).resolves.toMatchObject({ allowedGatewayCidrs: ['203.0.113.4/32'] })
    await expect(
      resolveNetworkFlags({ gatewayCidr: 'auto' }, failed('offline')),
    ).rejects.toThrow(/--gateway-cidr auto/)
  })

  it('keeps the two lists apart', async () => {
    await expect(
      resolveNetworkFlags(
        { sshCidr: '10.0.0.0/8', gatewayCidr: '192.168.0.0/16' },
        detected('203.0.113.4'),
      ),
    ).resolves.toEqual({
      allowedSshCidrs: ['10.0.0.0/8'],
      allowedGatewayCidrs: ['192.168.0.0/16'],
    })
  })

  it('carries publishGateway through only when asked', async () => {
    const deps = detected('203.0.113.4')
    await expect(resolveNetworkFlags({ publishGateway: 'all' }, deps)).resolves.toMatchObject({
      publishGateway: 'all',
    })
    expect(await resolveNetworkFlags({}, deps)).not.toHaveProperty('publishGateway')
  })

  it('validates an explicit list rather than passing it through', async () => {
    await expect(
      resolveNetworkFlags({ sshCidr: '10.0.0.0/8,nope' }, detected('203.0.113.4')),
    ).rejects.toThrow(/not a CIDR/)
  })
})
