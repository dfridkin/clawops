// Asking the host about a container, without turning "I was not allowed to look" into an
// answer about the container.
//
// Every probe was written as
//
//   docker inspect openclaw --format '{{.State.Status}}' 2>/dev/null || echo 'not found'
//
// which discards stderr and exits 0 whatever happened. `execPrivileged` escalates to sudo when
// a command looks like it was refused Docker access — and it tests the exit code first, so a
// command that always succeeds never escalates. The permission error was laundered into a
// confident "not found", the session cached "sudo not needed", and clawops then reported a
// healthy deployment as missing for as long as that session lived.
//
// That is not hypothetical. The fourth Azure end-to-end run waited ten minutes for a container
// that was up the whole time:
//
//   CONTAINER ID   STATUS                   PORTS                          NAMES
//   1beb0449dc86   Up 9 minutes (healthy)   127.0.0.1:18789->18789/tcp     openclaw
//
// It is intermittent because the SSH user's membership of the `docker` group is fixed when the
// session opens, and clawops now connects as early as it can — often before the bootstrap has
// run `usermod`. A session opened a second too early is refused for its whole life.

import { execPrivileged } from '../transport/privileged.js'
import type { SshSession } from '../transport/ssh.js'

export type InspectResult =
  | { kind: 'ok'; value: string }
  /** Docker answered, and there is no such container. */
  | { kind: 'missing' }
  /** Docker could not be asked. Never conflated with the container being absent. */
  | { kind: 'error'; detail: string }

/** Docker's own wording for a container that does not exist. */
function saysNoSuchObject(text: string): boolean {
  return /no such (object|container)/i.test(text)
}

/**
 * `docker inspect <name> --format <format>`, interpreted rather than flattened.
 *
 * The command carries no `2>/dev/null` and no `|| echo`: the exit code and stderr are what let
 * `execPrivileged` tell a refusal from an absence, and what let the caller report the
 * difference to the operator.
 */
export async function inspectContainer(
  session: SshSession,
  name: string,
  format: string,
  signal?: AbortSignal,
  dockerCmd = 'docker',
): Promise<InspectResult> {
  const result = await execPrivileged(
    session,
    `${dockerCmd} inspect ${name} --format '${format}'`,
    signal,
  )
  if (result.code === 0) return { kind: 'ok', value: result.stdout.trim() }

  const text = `${result.stderr} ${result.stdout}`.trim()
  if (saysNoSuchObject(text)) return { kind: 'missing' }
  return { kind: 'error', detail: text === '' ? `docker inspect exited ${result.code}` : text }
}

/** The container's state, as a word: its status, `not found`, or why the question failed. */
export async function containerStatus(
  session: SshSession,
  name = 'openclaw',
  signal?: AbortSignal,
): Promise<{ status: string; error?: string }> {
  const result = await inspectContainer(session, name, '{{.State.Status}}', signal)
  if (result.kind === 'ok') return { status: result.value || 'unknown' }
  if (result.kind === 'missing') return { status: 'not found' }
  return { status: 'unknown', error: result.detail }
}
