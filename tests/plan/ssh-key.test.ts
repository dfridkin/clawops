import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolvePublicKey } from '../../src/plan/ssh-key.js'

let dir: string
let keyPath: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'clawops-key-'))
  keyPath = path.join(dir, 'id_ed25519')
  // A real key pair: the point of this module is what ssh2 makes of real key material.
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'clawops', '-q'])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('resolvePublicKey', () => {
  it('reads the .pub beside the private key', () => {
    expect(resolvePublicKey(keyPath)).toMatch(/^ssh-ed25519 AAAA\S+ clawops$/)
  })

  it('derives the same key when the .pub is missing', () => {
    const fromFile = resolvePublicKey(keyPath)!
    rmSync(`${keyPath}.pub`)
    const derived = resolvePublicKey(keyPath)!
    // Same algorithm and same key material — only the trailing comment is ours.
    expect(derived.split(' ').slice(0, 2)).toEqual(fromFile.split(' ').slice(0, 2))
  })

  it('ignores an empty .pub and derives instead', () => {
    writeFileSync(`${keyPath}.pub`, '\n')
    expect(resolvePublicKey(keyPath)).toMatch(/^ssh-ed25519 AAAA/)
  })

  it('is undefined when there is no key at all', () => {
    expect(resolvePublicKey(path.join(dir, 'nothing'))).toBeUndefined()
  })

  it('is undefined for a key ssh2 cannot parse', () => {
    // A PKCS#8 PEM is a valid key file that ssh2 cannot use. Deriving a public key from it
    // some other way would install a key clawops is then unable to present.
    const pkcs8 = path.join(dir, 'pkcs8')
    writeFileSync(
      pkcs8,
      '-----BEGIN PRIVATE KEY-----\n' +
        'MC4CAQAwBQYDK2VwBCIEIPPf60xCO0DaINAtOfOAMqn1MD4023YeF98CSxEQy2lG\n' +
        '-----END PRIVATE KEY-----\n',
    )
    expect(resolvePublicKey(pkcs8)).toBeUndefined()
  })

  it('is undefined, not an error, for a file that is not a key', () => {
    const junk = path.join(dir, 'junk')
    writeFileSync(junk, 'not a key\n')
    expect(() => resolvePublicKey(junk)).not.toThrow()
    expect(resolvePublicKey(junk)).toBeUndefined()
  })
})
