import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../../src/providers/firewall.js', () => ({ detectEgressIp: vi.fn() }))

import { detectEgressIp } from '../../src/providers/firewall.js'
import {
  detectSshCidrDefault, validateCidrAnswer, admitsInternet,
} from '../../src/cli/commands/setup.js'

const mockDetect = vi.mocked(detectEgressIp)

beforeEach(() => vi.clearAllMocks())

describe('the setup wizard no longer defaults SSH to the internet', () => {
  it('offers the operator\'s own IP as a /32', async () => {
    mockDetect.mockResolvedValue({ ok: true, ip: '203.0.113.42\n' })
    expect(await detectSshCidrDefault()).toBe('203.0.113.42/32')
  })

  it('keeps a prefix the service already supplied', async () => {
    mockDetect.mockResolvedValue({ ok: true, ip: '203.0.113.0/24' })
    expect(await detectSshCidrDefault()).toBe('203.0.113.0/24')
  })

  it('offers no default when detection fails', async () => {
    // The prompt then requires an answer. An unanswerable prompt is better than a wide
    // default: pressing Enter used to open SSH to the whole internet.
    mockDetect.mockResolvedValue({ ok: false, error: 'timeout' })
    expect(await detectSshCidrDefault()).toBeUndefined()
  })

  it('offers no default when detection returns nothing useful', async () => {
    mockDetect.mockResolvedValue({ ok: true, ip: '   ' })
    expect(await detectSshCidrDefault()).toBeUndefined()
  })

  it('never hardcodes 0.0.0.0/0 as the prompt default', () => {
    // The specific regression: `default: '0.0.0.0/0'` on the SSH CIDR prompt, which made
    // the fastest path through the wizard the one N10 forbids.
    const source = readFileSync('src/cli/commands/setup.ts', 'utf-8')
    expect(source).not.toContain("default: '0.0.0.0/0'")
    expect(source).not.toContain("sshCidr ?? '0.0.0.0/0'")
  })
})

describe('validateCidrAnswer', () => {
  it('requires an answer', () => {
    expect(validateCidrAnswer('')).toMatch(/Required/)
    expect(validateCidrAnswer('   ')).toMatch(/Required/)
  })

  it.each(['203.0.113.4/32', '10.0.0.0/8', '192.168.1.0/24', '0.0.0.0/0'])(
    'accepts %s',
    (cidr) => expect(validateCidrAnswer(cidr)).toBe(true),
  )

  it('accepts an IPv6 CIDR', () => {
    expect(validateCidrAnswer('2001:db8::/32')).toBe(true)
  })

  it.each(['203.0.113.4', 'not-a-cidr', '203.0.113.4/33', '203.0.113.4/'])(
    'rejects %s',
    (bad) => expect(validateCidrAnswer(bad)).toMatch(/not a CIDR/),
  )
})

describe('admitsInternet', () => {
  it('recognises both forms', () => {
    expect(admitsInternet('0.0.0.0/0')).toBe(true)
    expect(admitsInternet(' ::/0 ')).toBe(true)
  })

  it('does not flag a specific range', () => {
    expect(admitsInternet('10.0.0.0/8')).toBe(false)
    expect(admitsInternet('203.0.113.4/32')).toBe(false)
  })
})
