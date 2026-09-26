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
  withoutHost,
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

describe('withoutHost', () => {
  const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA'
  const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBB'

  it('removes the entry for that host', () => {
    const content = `203.0.113.4 ${KEY_A}\n198.51.100.7 ${KEY_B}\n`
    expect(withoutHost(content, '203.0.113.4', 22)).toBe(`198.51.100.7 ${KEY_B}\n`)
  })

  it('leaves every other host alone', () => {
    const content = `198.51.100.7 ${KEY_B}\n203.0.113.4 ${KEY_A}\n`
    const result = withoutHost(content, '203.0.113.4', 22)
    expect(result).toContain('198.51.100.7')
    expect(result).not.toContain('203.0.113.4')
  })

  it('keeps comments and blank lines — this may be the operator\'s own file', () => {
    const content = `# my hosts\n\n203.0.113.4 ${KEY_A}\n\n# another\n198.51.100.7 ${KEY_B}\n`
    const result = withoutHost(content, '203.0.113.4', 22)
    expect(result).toContain('# my hosts')
    expect(result).toContain('# another')
    expect(result).toContain('198.51.100.7')
    expect(result).not.toContain('203.0.113.4')
  })

  it('matches the bracketed form for a non-default port', () => {
    const content = `[203.0.113.4]:2222 ${KEY_A}\n203.0.113.4 ${KEY_B}\n`
    const result = withoutHost(content, '203.0.113.4', 2222)
    // Port 22 and port 2222 on one address are two different hosts to OpenSSH.
    expect(result).not.toContain('[203.0.113.4]:2222')
    expect(result).toContain(`203.0.113.4 ${KEY_B}`)
  })

  it('removes every entry for the host, not just the first', () => {
    // A host with both an ed25519 and an RSA key has two lines.
    const content = `203.0.113.4 ${KEY_A}\n203.0.113.4 ssh-rsa AAAAB3Nz\n198.51.100.7 ${KEY_B}\n`
    const result = withoutHost(content, '203.0.113.4', 22)
    expect(result).not.toContain('203.0.113.4')
    expect(result).toContain('198.51.100.7')
  })

  it('leaves a file with no entry for that host unchanged', () => {
    const content = `198.51.100.7 ${KEY_B}\n`
    expect(withoutHost(content, '203.0.113.4', 22)).toBe(content)
  })

  it('leaves an unparseable line exactly as it is', () => {
    const content = `garbage-with-no-key\n203.0.113.4 ${KEY_A}\n`
    const result = withoutHost(content, '203.0.113.4', 22)
    expect(result).toContain('garbage-with-no-key')
  })

  it('handles an empty file', () => {
    expect(withoutHost('', '203.0.113.4', 22)).toBe('')
  })
})

describe('describeConnectError', () => {
  const OPTS = { host: '203.0.113.4', port: 22, knownHostsPath: '/home/u/.clawops/known_hosts' }

  it('explains a host-key mismatch and gives the exact command to clear it', async () => {
    const { describeConnectError } = await import('../../src/transport/ssh.js')
    const message = describeConnectError('Host denied (verification failed)', OPTS)
    // ssh2's own wording is accurate and useless: it names no file and no remedy.
    expect(message).toContain('/home/u/.clawops/known_hosts')
    expect(message).toContain('ssh-keygen -R 203.0.113.4 -f /home/u/.clawops/known_hosts')
  })

  it('does not tell the operator to delete a key they should be suspicious of', async () => {
    const { describeConnectError } = await import('../../src/transport/ssh.js')
    const message = describeConnectError('Host denied (verification failed)', OPTS)
    // An address changing hands unexpectedly is the one case where this error is doing its job.
    expect(message).toMatch(/did not expect this address to change hands, do not connect/)
  })

  it('brackets the host for a non-default port, as known_hosts does', async () => {
    const { describeConnectError } = await import('../../src/transport/ssh.js')
    const message = describeConnectError('Host denied (verification failed)', {
      ...OPTS,
      port: 2222,
    })
    expect(message).toContain('ssh-keygen -R [203.0.113.4]:2222')
  })

  it('leaves a failure it has nothing to say about as it was', async () => {
    const { describeConnectError } = await import('../../src/transport/ssh.js')
    expect(describeConnectError('Protocol error: bad packet length 1349676916', OPTS)).toBe(
      'SSH connection failed: Protocol error: bad packet length 1349676916',
    )
  })

  it('says nothing beyond ssh2 while a host is still booting', async () => {
    const { describeConnectError } = await import('../../src/transport/ssh.js')
    // "The instance is up and sshd is not" is advice about a problem that does not exist
    // during the first half-minute of a VM's life. waitForSsh has its own deadline message.
    expect(
      describeConnectError('connect ECONNREFUSED 203.0.113.4:22', { ...OPTS, awaitingBoot: true }),
    ).toBe('SSH connection failed: connect ECONNREFUSED 203.0.113.4:22')
  })

  it('still explains a host-key mismatch while booting, because waiting will not fix it', async () => {
    const { describeConnectError } = await import('../../src/transport/ssh.js')
    const message = describeConnectError('Host denied (verification failed)', {
      ...OPTS,
      awaitingBoot: true,
    })
    expect(message).toContain('ssh-keygen -R 203.0.113.4 -f /home/u/.clawops/known_hosts')
  })

  it('separates a refused connection from one that went nowhere', async () => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    // The distinction is the point: refused means sshd is down on a reachable host, and
    // dropped means the firewall is not admitting this machine. Same-looking, opposite fixes.
    const refused = diagnoseConnectError('connect ECONNREFUSED 203.0.113.4:22', OPTS)
    expect(refused.summary).toContain('refused the connection')
    expect(refused.summary).toContain('nothing is listening on that port')
    expect(refused.remedy).toContain('clawops status --stack <name>')
    expect(refused.remedy).not.toContain('--ssh-cidr')

    const dropped = diagnoseConnectError('connect ETIMEDOUT 203.0.113.4:22', OPTS)
    expect(dropped.summary).toContain('never answered')
    expect(dropped.remedy).toContain('clawops plan --stack <name> --ssh-cidr auto')
    expect(dropped.remedy).toContain('clawops apply <plan>.json')
    expect(dropped.remedy).not.toContain('sshd')
  })

  it('reads a handshake timeout as a dropped packet, not a protocol fault', async () => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    // ssh2's 30s readyTimeout fires before the kernel gives up on the connect, so this is
    // what a dropping firewall usually looks like.
    const d = diagnoseConnectError('Timed out while waiting for handshake', OPTS)
    expect(d.remedy).toContain('--ssh-cidr auto')
  })

  it.each([
    ['connect EHOSTUNREACH 203.0.113.4:22'],
    ['connect ENETUNREACH 203.0.113.4:22'],
  ])('treats %s as the firewall case too', async (raw) => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    expect(diagnoseConnectError(raw, OPTS).remedy).toContain('--ssh-cidr auto')
  })

  it('names the key clawops offered, and does not call it wrong', async () => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    const d = diagnoseConnectError('All configured authentication methods failed', {
      ...OPTS,
      privateKeyPath: '/home/u/.clawops/id_ed25519',
      user: 'ubuntu',
    })
    expect(d.summary).toContain('as ubuntu')
    expect(d.remedy).toContain('ssh-keygen -y -f /home/u/.clawops/id_ed25519')
    // The key being absent from the host is likelier than the key being bad, and saying
    // "wrong key" sends the operator to regenerate the one thing that is fine.
    expect(d.remedy).toContain('may not be installed on the host')
  })

  it('omits the key command when the caller did not say which key', async () => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    const d = diagnoseConnectError('All configured authentication methods failed', OPTS)
    expect(d.summary).not.toContain('as undefined')
    expect(d.remedy).not.toContain('ssh-keygen -y')
    expect(d.remedy).toContain('may not be installed on the host')
  })

  it('blames an old OpenSSH for an algorithm mismatch', async () => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    const d = diagnoseConnectError('Handshake failed: no matching key exchange algorithm', OPTS)
    expect(d.summary).toContain('no algorithm the SSH handshake needs')
    expect(d.remedy).toContain('OpenSSH older than')
  })

  it('points a name that does not resolve at the recorded address', async () => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    const d = diagnoseConnectError('getaddrinfo ENOTFOUND gone.example.com', {
      ...OPTS,
      host: 'gone.example.com',
    })
    expect(d.summary).toContain('gone.example.com does not resolve')
    expect(d.remedy).toContain('clawops stacks list')
  })

  it('keeps ssh2 wording in every diagnosis, for pasting and for isTransient', async () => {
    const { diagnoseConnectError } = await import('../../src/transport/ssh.js')
    const raws = [
      'connect ECONNREFUSED 203.0.113.4:22',
      'connect ETIMEDOUT 203.0.113.4:22',
      'getaddrinfo ENOTFOUND gone.example.com',
      'All configured authentication methods failed',
      'Handshake failed: no matching key exchange algorithm',
    ]
    for (const raw of raws) {
      expect(diagnoseConnectError(raw, { ...OPTS, host: 'gone.example.com' }).summary).toContain(raw)
    }
  })

  it('keeps a refused connection classified as worth retrying', async () => {
    const { describeConnectError } = await import('../../src/transport/ssh.js')
    const { isTransient } = await import('../../src/transport/wait.js')
    // The readiness wait reads these messages; rewording one into something it no longer
    // recognises would turn a booting instance into a hard failure. It reads them on the
    // awaitingBoot path, but the guarantee has to hold either way — the diagnoses keep
    // ssh2's text for exactly this reason.
    for (const awaitingBoot of [true, false]) {
      const opts = { ...OPTS, awaitingBoot }
      expect(isTransient(describeConnectError('connect ECONNREFUSED', opts))).toBe(true)
      expect(isTransient(describeConnectError('connect ETIMEDOUT', opts))).toBe(true)
      expect(isTransient(describeConnectError('connect EHOSTUNREACH', opts))).toBe(true)
      expect(isTransient(describeConnectError('getaddrinfo ENOTFOUND h', opts))).toBe(true)
      expect(
        isTransient(describeConnectError('All configured authentication methods failed', opts)),
      ).toBe(true)
      expect(isTransient(describeConnectError('Host denied (verification failed)', opts))).toBe(
        false,
      )
    }
  })
})
