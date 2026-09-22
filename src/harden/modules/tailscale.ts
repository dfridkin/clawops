// Tailscale membership (WO-34, first slice: install, join, report the address).
//
// This module gets the host onto a Tailscale network and stops there. It does not rewrite
// clawops config to use the new address, and it does not remove public access, which are the
// two steps of WO-34 that can leave an operator unable to reach their own machine. Those follow
// separately, behind the verification this module's output makes possible.
//
// Off by default. Every other module here hardens a host that is already reachable; this one
// joins it to a network the operator has to own an account on, and doing that unasked as part
// of a `clawops harden` with no arguments would be a surprise.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { resolveSecretRef } from '../../config/secrets.js'

/** The secret `clawops secret set` writes, and the only place this module takes a key from. */
export const AUTH_KEY_SECRET = 'TAILSCALE_AUTH_KEY'

/**
 * Where the key is staged on the host.
 *
 * Two separate exposures, and both have to be closed. `tailscale up --auth-key=<value>` puts the
 * key in argv, so it is read from a file instead. But sshd runs whatever command string it is
 * given as `$SHELL -c '<string>'`, so a key embedded in that string — in a heredoc, say — lands
 * in the outer shell's argv just the same. Measured: a process snapshot taken while the command
 * ran showed the key in `sh -c …`. It travels over the SSH data channel to the command's stdin
 * instead, which never becomes an argument to anything.
 */
const KEY_PATH = '/run/clawops-tailscale.key'

export type BackendState = 'Running' | 'NeedsLogin' | 'Stopped' | 'NoState' | 'Starting' | 'unknown'

export interface TailscaleStatus {
  state: BackendState
  /** The 100.x address Tailscale assigned, when it has one. */
  ipv4?: string
  hostname?: string
  /**
   * The daemon is not running, which is a different problem from not being joined.
   *
   * `tailscale status --json` against a dead daemon prints nothing parseable, so without this
   * the module reported "did not report a status that could be parsed" — true, useless, and it
   * sends the operator looking at output when the answer is a stopped service. Measured against
   * a real host: the installer leaves tailscaled enabled under systemd, so this shows up when
   * the service is masked, crashed, or there is no init to start it.
   */
  daemonDown?: boolean
}

/**
 * Tailscale's own machine-readable status.
 *
 * Parsed rather than grepped because the human output is a table whose columns move. An
 * unparseable body is reported as unknown rather than guessed at: "not on the network" and
 * "could not tell" lead to different actions.
 */
export function parseStatus(json: string): TailscaleStatus {
  let body: unknown
  try {
    body = JSON.parse(json)
  } catch {
    return { state: 'unknown' }
  }
  const b = body as { BackendState?: unknown; Self?: { TailscaleIPs?: unknown; HostName?: unknown } }
  const state = typeof b.BackendState === 'string' ? (b.BackendState as BackendState) : 'unknown'
  const ips = Array.isArray(b.Self?.TailscaleIPs) ? (b.Self?.TailscaleIPs as unknown[]) : []
  const ipv4 = ips.find((i): i is string => typeof i === 'string' && isTailscaleIpv4(i))
  const hostname = typeof b.Self?.HostName === 'string' ? b.Self.HostName : undefined
  return { state, ...(ipv4 ? { ipv4 } : {}), ...(hostname ? { hostname } : {}) }
}

/**
 * Whether an address is one Tailscale hands out: 100.64.0.0/10, the CGNAT range.
 *
 * Checked rather than assumed, because `tailscale ip -4` on a host that is not up prints
 * nothing, and an empty string that reaches a config rewrite as "the new SSH host" is a lockout.
 */
export function isTailscaleIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((o) => o > 255)) return false
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

/** The hostname the machine joins under, derived from the stack so the tailnet reads sensibly. */
export function tailnetHostname(stack: string): string {
  const slug = stack.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `clawops-${slug || 'stack'}`.slice(0, 63)
}

async function installed(exec: RemoteExec): Promise<boolean> {
  const r = await exec('command -v tailscale >/dev/null 2>&1 && echo yes || echo no')
  return r.stdout.trim() === 'yes'
}

/** Tailscale's own words for a daemon that is not up; it says this on stderr and exits non-zero. */
const DAEMON_DOWN = /failed to connect to local tailscaled|is tailscaled running|connection refused/i

async function status(exec: RemoteExec): Promise<TailscaleStatus> {
  const r = await exec('tailscale status --json 2>&1 || true')
  if (DAEMON_DOWN.test(r.stdout)) return { state: 'unknown', daemonDown: true }
  return parseStatus(r.stdout)
}

/**
 * Start the daemon if it is not already up.
 *
 * The installer enables it under systemd, so this is for the host where that did not take. It
 * reports rather than insists: a box with no systemd cannot be fixed from here, and saying so
 * beats a confusing failure from `tailscale up` three lines later.
 */
async function ensureDaemon(exec: RemoteExec, sudo: string): Promise<boolean> {
  const r = await exec(
    `command -v systemctl >/dev/null 2>&1 && ${sudo}systemctl start tailscaled >/dev/null 2>&1 && echo started || echo no`,
  )
  return r.stdout.trim() === 'started'
}

/**
 * `sudo -n ` unless the session is already root, and `-n` rather than plain `sudo`.
 *
 * The AWS image logs in as `ubuntu`, and `tailscale up` refuses anyone but root: "Access denied:
 * checkprefs access denied". Every earlier test ran as root and never saw it. `-n` because the
 * key is on stdin: a sudo that wanted a password would read it from there, and the auth key
 * would be spent as a failed sudo password. With -n it fails at once instead.
 */
async function rootPrefix(exec: RemoteExec): Promise<string> {
  return (await exec('id -u')).stdout.trim() === '0' ? '' : 'sudo -n '
}

/** Single-quote for `sh -c`. The script it quotes carries a path, never the key. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * `stack` names the machine on the tailnet. It is a factory rather than a constant because the
 * module contract hands a module an exec and nothing else, so the stack name cannot reach it any
 * other way; the same reason makeUfwModule exists. Without one the host's own hostname is used,
 * which is what an operator running `clawops harden` against a single box would expect to see.
 */
export function makeTailscaleModule(stack?: string): HardeningModule {
  return {
  id: 'tailscale',
  label: 'Tailscale membership (joins the host to your tailnet)',
  defaultOn: false,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    if (!(await installed(exec))) {
      return { status: 'missing', detail: 'Tailscale is not installed on this host.' }
    }
    const s = await status(exec)
    if (s.state === 'Running' && s.ipv4) {
      return { status: 'applied', detail: `Joined as ${s.hostname ?? 'this host'} on ${s.ipv4}.` }
    }
    if (s.daemonDown) {
      return {
        status: 'drifted',
        detail:
          'Tailscale is installed but the tailscaled daemon is not running, so this host is on ' +
          'no tailnet whatever it was joined to before. Start it with `systemctl start ' +
          'tailscaled`, or check `systemctl status tailscaled` for why it stopped.',
      }
    }
    if (s.state === 'unknown') {
      return {
        status: 'drifted',
        detail: 'Tailscale is installed but did not report a status that could be parsed.',
      }
    }
    return {
      status: 'missing',
      detail: `Tailscale is installed but not on a tailnet (state: ${s.state}).`,
    }
  },

  async apply(exec: RemoteExec): Promise<ApplyResult> {
    const key = resolveSecretRef(AUTH_KEY_SECRET)
    if (!key) {
      throw new Error(
        `No auth key. Create one in the Tailscale admin console and store it with ` +
          `\`clawops secret set ${AUTH_KEY_SECRET}\`. clawops does not prompt for it here, so a ` +
          'key never reaches a terminal scrollback or a CI log.',
      )
    }

    if (!(await installed(exec))) {
      // Tailscale's own install script, over HTTPS from their domain, which is the method they
      // document and support. Pinning a package version here would mean tracking their repo
      // layout across five distributions.
      const r = await exec('curl -fsSL https://tailscale.com/install.sh | sh')
      if (!(await installed(exec))) {
        throw new Error(`Tailscale install failed: ${(r.stderr || r.stdout).slice(0, 300)}`)
      }
    }

    const sudo = await rootPrefix(exec)

    // Bring the daemon up first: `tailscale up` against a dead one fails with an error about
    // sockets rather than about the network, which is not what the operator needs to read.
    if ((await status(exec)).daemonDown && !(await ensureDaemon(exec, sudo))) {
      throw new Error(
        'Tailscale is installed but tailscaled is not running and could not be started. On a ' +
          'systemd host, `systemctl status tailscaled` says why; on a host without an init ' +
          'manager, tailscaled has to be supervised by whatever does run there.',
      )
    }

    const hostname = tailnetHostname(stack ?? (await exec('hostname')).stdout)
    /*
     * The key is written, used and removed inside one command, with a trap so an interrupt still
     * removes it. umask 077 rather than a chmod afterwards: between create and chmod the file is
     * briefly world-readable, and on a host whose whole point is that others may reach it that
     * window is not worth leaving open.
     */
    const join = [
      `umask 077`,
      `trap 'rm -f ${KEY_PATH}' EXIT INT TERM`,
      `cat > ${KEY_PATH}`,
      `tailscale up --auth-key=file:${KEY_PATH} --hostname=${hostname} --accept-routes 2>&1`,
    ].join('\n')
    /*
     * The whole script runs as root, not each command in it: umask is set inside the root shell,
     * so the key file is created 0600 by the process that creates it. `sudo tee` would have run
     * tee under sudo's own default umask and could have left it 0644. The script names only the
     * key's path; the key itself still arrives on stdin, which sudo passes through.
     */
    const r = await exec(`${sudo}sh -c ${shellQuote(join)}`, { stdin: key })

    const s = await status(exec)
    if (s.state === 'Running' && s.ipv4) {
      return {
        changed: true,
        detail:
          `Joined the tailnet as ${s.hostname ?? hostname} on ${s.ipv4}. clawops still reaches ` +
          'this host on its public address; nothing has been pointed at the new one yet.',
      }
    }
    /*
     * A join that did not join is a failure, whatever else this call managed.
     *
     * It used to return `changed: true` here whenever the install had run, and the runner reads
     * `changed` as success: on a real AWS host a join that failed on permissions printed a green
     * tick, "0 errors" and "Hardening complete". An operator would have believed the host was on
     * the tailnet.
     */
    throw new Error(
      `tailscale up did not bring the host onto the network (state: ${s.state}). ` +
        // The key is never interpolated into a message. An expired or single-use key is the
        // usual cause and Tailscale says so in output that does not contain the key itself.
        redactKey(r.stdout || r.stderr, key).slice(0, 300),
    )
  },
  }
}

export const tailscaleModule: HardeningModule = makeTailscaleModule()


/**
 * Remove the key from anything about to be shown.
 *
 * Belt and braces: the key is passed by file and should never come back in output. It costs
 * nothing to be sure, and a leaked auth key is a machine someone else can add to the tailnet.
 */
export function redactKey(text: string, key: string): string {
  if (!key) return text
  return text.split(key).join('[redacted]')
}
