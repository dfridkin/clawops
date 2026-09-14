// The public key a deploy installs on the instance.
//
// Every cloud program requires stack config `sshPublicKey` and refuses to run without it:
//
//   error: Stack config "sshPublicKey" is required for the GCP adapter.
//
// Nothing ever set it. The wizard writes the key into the plan as `spec.ssh.publicKey`, apply
// never read it, and `clawops plan` never filled it — so a plan generated from the CLI failed
// at preview, and the plan→apply path had never produced an instance for any provider.
//
// The key belongs in the plan rather than being read at apply time: the plan is what the
// operator reviews, and "which key can log into this machine" is exactly the kind of question
// a review exists to answer.

import { existsSync, readFileSync } from 'node:fs'
import ssh2 from 'ssh2'

/**
 * The OpenSSH-format public key for a private key path.
 *
 * Prefers the `.pub` beside the private key, and derives it from the private key when there is
 * none — `ssh-keygen` writes both, but a key restored from a password manager or copied from
 * another machine often arrives alone, and refusing to deploy over a missing derived file
 * would be refusing over nothing.
 *
 * Derivation goes through `ssh2`, deliberately, even though node's `crypto` can read more
 * formats. ssh2 is what every clawops SSH operation uses; a key it cannot parse cannot log in,
 * and installing a public key derived some other way would produce an instance that accepts a
 * key clawops is unable to present.
 *
 * Returns undefined rather than throwing: the caller decides whether a missing key is a
 * warning (plan) or an error (apply).
 */
export function resolvePublicKey(privateKeyPath: string): string | undefined {
  const pub = `${privateKeyPath}.pub`
  if (existsSync(pub)) {
    const contents = readFileSync(pub, 'utf-8').trim()
    if (contents !== '') return contents
  }

  if (!existsSync(privateKeyPath)) return undefined
  try {
    const parsed = ssh2.utils.parseKey(readFileSync(privateKeyPath))
    // parseKey returns an Error rather than throwing — an encrypted key with no passphrase
    // lands here, and there is nothing to prompt with this far down.
    if (parsed instanceof Error || !('getPublicSSH' in parsed)) return undefined
    return `${parsed.type} ${parsed.getPublicSSH().toString('base64')} clawops`
  } catch {
    return undefined
  }
}
