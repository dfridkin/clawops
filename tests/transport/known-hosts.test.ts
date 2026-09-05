// Host-key verification against known_hosts.
//
// The bug this covers: the previous verifier read `parts[1]` of each line as the key.
// In OpenSSH format that field is the key *type*, so every standard entry failed to
// match and produced "Host denied (verification failed)" — permanently.

import { describe, it, expect } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import {
  parseKnownHosts,
  verifyAgainstKnownHosts,
  formatKnownHostsLine,
  keyTypeFromBlob,
  hostEntryFor,
} from '../../src/transport/known-hosts.js'

/** Build a realistic SSH public-key blob: length-prefixed type, then body. */
function makeKeyBlob(type = 'ssh-ed25519', body = randomBytes(32)): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length, 0)
  return Buffer.concat([len, Buffer.from(type), body])
}

const KEY = makeKeyBlob()
const OTHER = makeKeyBlob('ssh-ed25519', randomBytes(32))
const B64 = KEY.toString('base64')

describe('keyTypeFromBlob', () => {
  it('reads the type out of the wire format', () => {
    expect(keyTypeFromBlob(KEY)).toBe('ssh-ed25519')
    expect(keyTypeFromBlob(makeKeyBlob('ssh-rsa'))).toBe('ssh-rsa')
  })

  it('rejects malformed blobs rather than guessing', () => {
    expect(keyTypeFromBlob(Buffer.alloc(0))).toBeUndefined()
    expect(keyTypeFromBlob(Buffer.from([0, 0, 0, 200, 1, 2]))).toBeUndefined()
  })
})

describe('hostEntryFor', () => {
  it('uses the bare host on port 22 and bracket form otherwise', () => {
    expect(hostEntryFor('example.com', 22)).toBe('example.com')
    expect(hostEntryFor('example.com', 2222)).toBe('[example.com]:2222')
  })
})

describe('parseKnownHosts', () => {
  it('parses the standard three-field form', () => {
    const [e] = parseKnownHosts(`example.com ssh-ed25519 ${B64}`)
    expect(e?.keyType).toBe('ssh-ed25519')
    expect(e?.base64Key).toBe(B64)
  })

  it('parses comma-separated host lists', () => {
    const [e] = parseKnownHosts(`a.example,b.example ssh-ed25519 ${B64}`)
    expect(e?.hosts).toEqual(['a.example', 'b.example'])
  })

  it('parses markers', () => {
    const [e] = parseKnownHosts(`@revoked example.com ssh-ed25519 ${B64}`)
    expect(e?.marker).toBe('@revoked')
    expect(e?.hosts).toEqual(['example.com'])
  })

  it('still reads clawops legacy two-field hex lines', () => {
    const [e] = parseKnownHosts(`example.com ${KEY.toString('hex')}`)
    expect(e?.hexKey).toBe(KEY.toString('hex'))
  })

  it('skips comments and blanks', () => {
    expect(parseKnownHosts('\n# a comment\n\n')).toHaveLength(0)
  })
})

describe('verifyAgainstKnownHosts', () => {
  it('matches a standard entry — the case that used to fail', () => {
    const content = `example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('match')
  })

  it('reports a genuine key change as a mismatch', () => {
    const content = `example.com ssh-ed25519 ${OTHER.toString('base64')}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('mismatch')
  })

  it('reports an absent host as unknown, not a mismatch', () => {
    // The distinction matters: unknown is trust-on-first-use, mismatch is a hard fail.
    expect(verifyAgainstKnownHosts('other.example ssh-ed25519 AAAA', 'example.com', 22, KEY))
      .toBe('unknown')
    expect(verifyAgainstKnownHosts('', 'example.com', 22, KEY)).toBe('unknown')
  })

  it('matches within a comma-separated host list', () => {
    const content = `a.example,example.com,c.example ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('match')
  })

  it('matches a non-default port through the bracket form', () => {
    const content = `[example.com]:2222 ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 2222, KEY)).toBe('match')
    // ...and does not leak across ports.
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('unknown')
  })

  it('matches hashed hostnames', () => {
    const salt = randomBytes(20)
    const hash = createHmac('sha1', salt).update('example.com').digest('base64')
    const content = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('match')
  })

  it('does not match a hashed entry for a different host', () => {
    const salt = randomBytes(20)
    const hash = createHmac('sha1', salt).update('other.example').digest('base64')
    const content = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('unknown')
  })

  it('treats a revoked key as a mismatch', () => {
    const content = `@revoked example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('mismatch')
  })

  it('ignores @cert-authority lines when looking for a host key', () => {
    const content = `@cert-authority example.com ssh-ed25519 ${OTHER.toString('base64')}`
    // A CA entry is not this host's key, so its presence must not read as a mismatch.
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('unknown')
  })

  it('accepts legacy clawops hex entries so existing installs keep working', () => {
    const content = `example.com ${KEY.toString('hex')}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('match')
  })

  it('finds the right key when a host has several', () => {
    const content = [
      `example.com ssh-rsa ${OTHER.toString('base64')}`,
      `example.com ssh-ed25519 ${B64}`,
    ].join('\n')
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('match')
  })

})

describe('wildcard patterns', () => {
  it('matches a subdomain wildcard', () => {
    const content = `*.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'host.example.com', 22, KEY)).toBe('match')
  })

  it('spans dots, as OpenSSH * does', () => {
    const content = `*.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'a.b.example.com', 22, KEY)).toBe('match')
  })

  it('still requires the literal separator', () => {
    // `*.example.com` must not cover the apex; the dot is literal.
    const content = `*.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'example.com', 22, KEY)).toBe('unknown')
  })

  it('supports ? as exactly one character', () => {
    const content = `web?.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'web1.example.com', 22, KEY)).toBe('match')
    expect(verifyAgainstKnownHosts(content, 'web12.example.com', 22, KEY)).toBe('unknown')
  })

  it('is case-insensitive, as OpenSSH is', () => {
    const content = `*.EXAMPLE.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'host.example.COM', 22, KEY)).toBe('match')
  })

  it('treats brackets in a port pattern as literal, not a character class', () => {
    const content = `[*.example.com]:2222 ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'host.example.com', 2222, KEY)).toBe('match')
    expect(verifyAgainstKnownHosts(content, 'host.example.com', 22, KEY)).toBe('unknown')
  })

  it('refuses a wrong key covered by a wildcard — the reason to support them', () => {
    // Previously this fell through to `unknown`, so TOFU accepted a key the user's
    // own file contradicted and then recorded it.
    const content = `*.example.com ssh-ed25519 ${OTHER.toString('base64')}`
    expect(verifyAgainstKnownHosts(content, 'host.example.com', 22, KEY)).toBe('mismatch')
  })

  it('does not match an unrelated domain', () => {
    const content = `*.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'host.evil.com', 22, KEY)).toBe('unknown')
  })
})

describe('negated patterns', () => {
  it('voids the entry for an explicitly excluded host', () => {
    const content = `!secure.example.com,*.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'secure.example.com', 22, KEY)).toBe('unknown')
  })

  it('still covers the rest of the wildcard', () => {
    const content = `!secure.example.com,*.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'other.example.com', 22, KEY)).toBe('match')
  })

  it('wins regardless of order in the list', () => {
    const content = `*.example.com,!secure.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'secure.example.com', 22, KEY)).toBe('unknown')
  })

  it('supports a negated pattern, not just a literal', () => {
    const content = `!*.internal.example.com,*.example.com ssh-ed25519 ${B64}`
    expect(verifyAgainstKnownHosts(content, 'db.internal.example.com', 22, KEY)).toBe('unknown')
    expect(verifyAgainstKnownHosts(content, 'www.example.com', 22, KEY)).toBe('match')
  })

  it('does not let an exclusion in one entry suppress another entry', () => {
    // Exclusion is per-entry; a later concrete entry still applies.
    const content = [
      `!host.example.com,*.example.com ssh-ed25519 ${OTHER.toString('base64')}`,
      `host.example.com ssh-ed25519 ${B64}`,
    ].join('\n')
    expect(verifyAgainstKnownHosts(content, 'host.example.com', 22, KEY)).toBe('match')
  })
})

describe('trust on first use with wildcards present', () => {
  it('records the concrete host, never a pattern', () => {
    const line = formatKnownHostsLine('host.example.com', 22, 'ssh-ed25519', KEY)
    expect(line).not.toContain('*')
    expect(line.startsWith('host.example.com ')).toBe(true)
  })
})

describe('formatKnownHostsLine', () => {
  it('writes a line OpenSSH itself can parse', () => {
    const line = formatKnownHostsLine('example.com', 22, 'ssh-ed25519', KEY)
    expect(line).toBe(`example.com ssh-ed25519 ${B64}\n`)
    // Round-trips through our own parser.
    expect(verifyAgainstKnownHosts(line, 'example.com', 22, KEY)).toBe('match')
  })

  it('uses the bracket form for a non-default port', () => {
    expect(formatKnownHostsLine('example.com', 2222, 'ssh-rsa', KEY))
      .toBe(`[example.com]:2222 ssh-rsa ${B64}\n`)
  })
})
