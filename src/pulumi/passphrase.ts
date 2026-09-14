// The passphrase that encrypts a self-managed stack's secrets.
//
// Pulumi's self-managed backends (gs://, s3://, azblob://) have no key service behind them, so
// every stack needs a secrets manager of its own, and the only one available without a cloud
// KMS is a passphrase. Creating a stack without one fails before anything is provisioned:
//
//   error: could not create secrets manager for new stack: passphrase must be set with
//   PULUMI_CONFIG_PASSPHRASE or PULUMI_CONFIG_PASSPHRASE_FILE environment variables
//
// clawops never set one, so `plan` degraded to "diff unavailable" and `apply` could not create
// a stack at all. The CI guide has told people to set PULUMI_CONFIG_PASSPHRASE since the
// beginning; the local path had no story.
//
// Generating one and keeping it beside the other clawops secrets is the only option that
// preserves the promise of the tool — a passphrase prompt on every deploy is not a seamless
// experience, and a fixed one is not a passphrase. An operator who sets
// PULUMI_CONFIG_PASSPHRASE (or _FILE) themselves is left alone.
//
// R6 permits this: R6 forbids clawops storing CLOUD credentials, which are issued elsewhere
// and belong to the operator. This is a local encryption key clawops generates for its own
// state file. See ADR 0011.

import path from 'node:path'
import process from 'node:process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'

export const PASSPHRASE_FILE = 'pulumi-passphrase'

export function passphrasePath(configDir: string): string {
  return path.join(configDir, 'secrets', PASSPHRASE_FILE)
}

/** True when the operator has taken this over — clawops then sets nothing. */
export function passphraseInEnvironment(): boolean {
  return Boolean(
    process.env['PULUMI_CONFIG_PASSPHRASE'] ?? process.env['PULUMI_CONFIG_PASSPHRASE_FILE'],
  )
}

export type PassphraseStatus = 'environment' | 'stored' | 'absent'

/** For `doctor`: which of the three states this machine is in, without creating anything. */
export function passphraseStatus(configDir: string): PassphraseStatus {
  if (passphraseInEnvironment()) return 'environment'
  return existsSync(passphrasePath(configDir)) ? 'stored' : 'absent'
}

/**
 * The passphrase to hand the workspace, generating and storing one the first time.
 *
 * Returns undefined when the environment already carries it: overriding the operator's own
 * passphrase with ours would make their existing stacks undecryptable.
 *
 * The value is written before it is used. A passphrase that encrypted a stack and was then
 * lost takes the stack's secrets with it, so a crash between generating and persisting must
 * not be able to leave one in use but unsaved.
 */
export function ensurePassphrase(configDir: string): string | undefined {
  if (passphraseInEnvironment()) return undefined

  const file = passphrasePath(configDir)
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf-8').trim()
    if (stored !== '') return stored
    // An empty file is not a passphrase. Treat it as absent and write a real one rather than
    // encrypting a stack with the empty string.
  }

  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best effort: an unusual mode on the directory is not worth failing a deploy over.
  }
  const generated = randomBytes(32).toString('base64url')
  writeFileSync(file, generated + '\n', { encoding: 'utf-8', mode: 0o600 })
  return generated
}
