// Running privileged commands on a remote host — chiefly Docker.
//
// clawops connects to AWS as `ubuntu`, but provisioning only puts `clawops` in the docker
// group, so every Docker command fails with "permission denied while trying to connect to
// the Docker daemon socket". GCP and Azure connect as `clawops`, which is in the group —
// which is why this only ever broke on AWS, and why it survived so long.
//
// `plan/remote-config.ts` carried a private version of this fix, with a comment naming the
// AWS case exactly. It was applied where the bug was reported rather than across the
// surface: nine other files kept calling Docker directly. This module is that fix, made
// general. See docs/spikes/SP-11-wo-39-state-audit.md.

import type { SshSession, SshExecResult } from './ssh.js'

/**
 * POSIX single-quote escaping.
 *
 * Load-bearing, not cosmetic. The previous fallback wrapped the command in DOUBLE quotes:
 *
 *     sudo -n bash -c "docker run … $([ -s /home/clawops/openclaw.env ] && echo --env-file …)"
 *
 * The outer shell — running as the unprivileged SSH user — performs that command
 * substitution *before* sudo is invoked. `/home/clawops` is mode 750, so the test is false
 * for `ubuntu`, the token is never attached, and the gateway exits 78 with "Refusing to
 * bind gateway to auto without auth". Escalating privilege after the substitution has
 * already happened is too late.
 *
 * Single-quoting defers every expansion to the privileged shell, where it belongs.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Wrap a command so it runs under non-interactive sudo with expansions deferred. */
export function sudoWrap(cmd: string): string {
  return `sudo -n bash -c ${shellQuote(cmd)}`
}

/**
 * Does this failure look like the SSH user lacking Docker access, rather than the command
 * legitimately failing?
 *
 * Narrow on purpose. Retrying every non-zero exit under sudo would double the round trips
 * for ordinary failures — `docker inspect` on an absent container is a non-zero exit that
 * means "not there", not "not allowed" — and would blur the two.
 */
function looksLikePermissionDenied(result: SshExecResult): boolean {
  if (result.code === 0) return false
  const text = `${result.stderr} ${result.stdout}`.toLowerCase()
  return (
    text.includes('permission denied') ||
    text.includes('docker.sock') ||
    text.includes('operation not permitted')
  )
}

/**
 * Per-session memory of whether sudo was needed, so the cost is one extra round trip per
 * connection rather than per command. Keyed on the session object; a WeakMap means a
 * closed session is not retained.
 */
const sudoNeeded = new WeakMap<object, boolean>()

/** For tests: forget what we learned about a session. */
export function resetPrivilegeCache(session: SshSession): void {
  sudoNeeded.delete(session as unknown as object)
}

/**
 * Run a command that needs Docker access, escalating only if the host requires it.
 *
 * On GCP/Azure (SSH user is `clawops`, already in the docker group) this never escalates.
 * On AWS it escalates once, remembers, and goes straight to sudo thereafter.
 */
export async function execPrivileged(
  session: SshSession,
  cmd: string,
  signal?: AbortSignal,
): Promise<SshExecResult> {
  const key = session as unknown as object

  if (sudoNeeded.get(key) === true) return session.exec(sudoWrap(cmd), signal)

  const direct = await session.exec(cmd, signal)
  if (!looksLikePermissionDenied(direct)) {
    if (direct.code === 0) sudoNeeded.set(key, false)
    return direct
  }

  const escalated = await session.exec(sudoWrap(cmd), signal)
  if (escalated.code === 0) sudoNeeded.set(key, true)
  return escalated
}

/**
 * Stream variant, for `logs --follow` and similar.
 *
 * A stream cannot be retried once it has started emitting, so the privilege question is
 * settled with a cheap probe first when this session has not answered it yet.
 */
export async function streamPrivileged(
  session: SshSession,
  cmd: string,
  signal?: AbortSignal,
): ReturnType<SshSession['stream']> {
  const key = session as unknown as object

  if (sudoNeeded.get(key) === undefined) {
    // `docker version` touches the socket and nothing else — the cheapest possible probe.
    const probe = await session.exec('docker version --format "{{.Server.Version}}"', signal)
    sudoNeeded.set(key, looksLikePermissionDenied(probe))
  }

  return session.stream(sudoNeeded.get(key) ? sudoWrap(cmd) : cmd, signal)
}
