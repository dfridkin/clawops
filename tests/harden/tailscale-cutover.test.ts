// Steps 4 and 5 of WO-34: moving clawops onto a stack's tailnet address, and only once proven.
// Real key blobs throughout, because keyTypeFromBlob decodes them rather than trusting labels.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RemoteExec } from '../../src/harden/types.js'
import { parseHostKeys, pinKeys, verifyTailnetAddress } from '../../src/harden/tailscale-cutover.js'
import { verifyAgainstKnownHosts } from '../../src/transport/known-hosts.js'

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKHon6esf+cbdgZSiEVPGG+4GBu+Vr5KjXE3FqbgHIhm host'
const EC =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBJUuSZquzghoPWEwZQ/hN/CWYRMFpPdWXLm865aT/opdVxo+DuOwLLgketTGKB4hFnWziGjFgIq3q8uzfZlx2YQ= host'
const RSA =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDIlgKtpD+DVEWIJbVi8x73QxBBDhLkOhD/I6pKEcmVHfGey6ga4GEs4YaSYkHLS0DBOjSS3Q8bruF9TWYmPq7y2qV0Jpbq3ITsVlBufdB42ADiANHGl5odMLc0HIHMsSVs7nxgn3wLrQKTzsXWWMfFV7H84qGpKkun4txP7Wfk7ptjIYEVeRNzutgq0UE4aaWM07KblSWnaSxT+glPvwv2JfpM+zY76Le4+Fgv3/l6Zdi7bunsEzH4UGpZxGzPSAjzP8DAsynGd28FjsjGn/GQEMS6jsanyJr9xANCvIUy5puXfsYL4MeSAuFrl1FYoJ9H5abEpgsRaWaA6Vnx6lu7 host'

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { TailscaleIPs: ['100.109.106.2'], HostName: 'clawops-prod' },
})

let dir: string
let known: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cutover-'))
  known = path.join(dir, 'known_hosts')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const conn = () => ({ host: '203.0.113.10', port: 22, user: 'ubuntu', privateKeyPath: '/k', knownHostsPath: known })

function execWith(status: string, keys: string): RemoteExec {
  return (async (cmd: string) => {
    if (cmd.includes('tailscale status')) return { stdout: status, stderr: '', code: 0 }
    if (cmd.includes('ssh_host_')) return { stdout: keys, stderr: '', code: 0 }
    return { stdout: '', stderr: '', code: 0 }
  }) as RemoteExec
}

describe('parseHostKeys', () => {
  it('reads every key type the host serves, not just one', () => {
    expect(parseHostKeys([ED, EC, RSA].join('\n')).map((k) => k.type)).toEqual([
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ssh-rsa',
    ])
  })

  it('rejects a line whose label disagrees with the key inside it', () => {
    // A mislabelled file must not be able to pin the wrong thing.
    const lying = ED.replace('ssh-ed25519', 'ssh-rsa')
    expect(parseHostKeys(lying)).toEqual([])
  })

  it('ignores blank lines and garbage', () => {
    expect(parseHostKeys(`\n  \nnot a key\n${ED}\n`)).toHaveLength(1)
  })
})

describe('pinKeys', () => {
  it('pins every key for the tailnet address, in a form the verifier then matches', () => {
    const keys = parseHostKeys([ED, EC, RSA].join('\n'))
    expect(pinKeys(known, '100.109.106.2', 22, keys)).toBe(3)
    const content = readFileSync(known, 'utf-8')
    for (const k of keys) {
      expect(verifyAgainstKnownHosts(content, '100.109.106.2', 22, k.blob)).toBe('match')
    }
  })

  it('makes a different key for that address a mismatch, not a first use', () => {
    // The identity half of verification: once pinned, an impostor on 100.x is refused.
    pinKeys(known, '100.109.106.2', 22, parseHostKeys(ED))
    const impostor = parseHostKeys(EC)[0]!
    expect(verifyAgainstKnownHosts(readFileSync(known, 'utf-8'), '100.109.106.2', 22, impostor.blob)).toBe('mismatch')
  })

  it('does not duplicate entries on a re-run', () => {
    const keys = parseHostKeys([ED, EC].join('\n'))
    pinKeys(known, '100.109.106.2', 22, keys)
    expect(pinKeys(known, '100.109.106.2', 22, keys)).toBe(0)
  })

  it('leaves the operator’s other entries alone', () => {
    writeFileSync(known, 'example.com ssh-ed25519 AAAAexisting\n')
    pinKeys(known, '100.109.106.2', 22, parseHostKeys(ED))
    expect(readFileSync(known, 'utf-8')).toContain('example.com ssh-ed25519 AAAAexisting')
  })
})

describe('verifyTailnetAddress', () => {
  it('refuses when the host is not on a tailnet, and pins nothing', async () => {
    const r = await verifyTailnetAddress(conn(), {
      exec: execWith(JSON.stringify({ BackendState: 'NeedsLogin' }), ED),
      probe: async () => true,
    })
    expect(r.ok).toBe(false)
    expect(() => readFileSync(known, 'utf-8')).toThrow()
  })

  it('refuses when the host keys cannot be read', async () => {
    const r = await verifyTailnetAddress(conn(), { exec: execWith(RUNNING, ''), probe: async () => true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('cannot')
  })

  // The property the whole of steps 4-6 rests on.
  it('refuses when this machine cannot reach the tailnet address, and says why', async () => {
    const r = await verifyTailnetAddress(conn(), { exec: execWith(RUNNING, ED), probe: async () => false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('this machine is not on the same tailnet')
      expect(r.reason).toContain('nothing else was changed')
    }
  })

  it('probes the tailnet address, not the public one', async () => {
    let probed = ''
    await verifyTailnetAddress(conn(), {
      exec: execWith(RUNNING, ED),
      probe: async (c) => {
        probed = c.host
        return true
      },
    })
    expect(probed).toBe('100.109.106.2')
  })

  it('pins before probing, so the probe cannot fall back to trusting on first use', async () => {
    let pinnedAtProbe = false
    await verifyTailnetAddress(conn(), {
      exec: execWith(RUNNING, ED),
      probe: async () => {
        pinnedAtProbe = readFileSync(known, 'utf-8').includes('100.109.106.2')
        return true
      },
    })
    expect(pinnedAtProbe).toBe(true)
  })

  it('succeeds with the address, hostname and pin count', async () => {
    const r = await verifyTailnetAddress(conn(), { exec: execWith(RUNNING, [ED, EC].join('\n')), probe: async () => true })
    expect(r).toEqual({ ok: true, ip: '100.109.106.2', hostname: 'clawops-prod', pinned: 2 })
  })
})
