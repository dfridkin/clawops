// The one place the OpenClaw runtime contract lives: image, paths, ports, env names,
// hardening, and the single command builder every caller goes through.
//
// Before this module there were six hand-written `docker run` strings — three restart
// paths, two provisioning templates and a Pulumi component. They drifted, repeatedly and
// expensively: the restart paths lost the gateway command entirely (v1.7.5), the MCP tool
// missed that fix because it wrote its own (v1.7.6), and the macOS branch of the local
// template still carries a duplicated `--env-file`. Each was a separate incident with the
// same cause. Sharing constants was not enough; the *command* has to be built in one place.
//
// Shell-var friendly: every path and port is a string, so a caller emitting a shell
// template can pass `${OPENCLAW_PORT}` where a TypeScript caller passes `18789`.

import { GATEWAY_PORT } from './run-flags.js'

export { GATEWAY_PORT }

/**
 * The container-side state directory — config, SQLite, and installed plugins, all in one.
 *
 * This is OpenClaw's own default (`openclaw config file` resolves to
 * `<here>/openclaw.json` with no env set), which is why clawops no longer passes
 * `OPENCLAW_CONFIG_PATH`: mounting the standard path *is* the configuration.
 *
 * Measured on 2026.9.2 — one mount covers everything that must survive a container
 * replacement: `state/openclaw.sqlite` (+ `-wal`, `-shm`), `extensions/` for plugins
 * installed at provisioning, `openclaw.json`, and the config journal fingerprint.
 * See docs/spikes/SP-11-wo-39-state-audit.md.
 */
export const STATE_DIR_CONTAINER = '/home/node/.openclaw'

/** Host directory bind-mounted at STATE_DIR_CONTAINER on Linux. */
export const STATE_DIR_HOST_LINUX = '/var/lib/clawops/openclaw'

/** Host directory on macOS hosts, which have no /var/lib convention for this. */
export const STATE_DIR_HOST_MACOS = '${HOME}/.clawops/openclaw'

/** The config file, inside the state directory. */
export const CONFIG_FILENAME = 'openclaw.json'

/**
 * The uid the OpenClaw container runs as — `User=node`, uid/gid 1000, no root entrypoint.
 *
 * Ownership of the host state directory MUST be set numerically to this. `chown
 * clawops:clawops` is wrong: on Ubuntu 24.04 the `ubuntu` user already holds 1000, so
 * `useradd clawops` gets **1001**, and the gateway then exits 1 with
 * `EACCES … stat '<state>/state/openclaw.sqlite-wal'` — verified on a native Linux bind
 * mount. Under `--restart unless-stopped` that is a permanent crash-loop, so there is no
 * degraded mode to fall back on. (G25)
 */
export const CONTAINER_UID = 1000

/** Config path inside the container. */
export const CONFIG_MOUNT_PATH = `${STATE_DIR_CONTAINER}/${CONFIG_FILENAME}`

/** Host config path for an OS, for the SSH-side readers and writers. */
export function stateDirForOS(os: 'Linux' | 'Darwin'): string {
  return os === 'Darwin' ? STATE_DIR_HOST_MACOS : STATE_DIR_HOST_LINUX
}

export function configPathForOS(os: 'Linux' | 'Darwin'): string {
  return `${stateDirForOS(os)}/${CONFIG_FILENAME}`
}

/** Host path to the env file holding OPENCLAW_GATEWAY_TOKEN. */
export const ENV_FILE_PATH = '/home/clawops/openclaw.env'

/**
 * Security controls, taken from the profile SP-06 observed on a live `openclaw fleet`
 * cell — so this is a configuration upstream already runs OpenClaw under, not one we
 * invented and hope works.
 *
 * Capacity limits (`--memory`, `--cpus`) are deliberately NOT here. Fleet sets them to
 * divide one host between tenants; clawops deploys single-tenant, where capping a 16 GB
 * box at Fleet's 2 GB would be a regression rather than a control. They are opt-in via
 * `limits`.
 */
export const SECURITY_FLAGS = [
  '--cap-drop=ALL',
  '--security-opt no-new-privileges',
  '--init',
  '--pids-limit 512',
].join(' ')

/**
 * Tells OpenClaw that something else owns its lifecycle.
 *
 * clawops starts, stops and replaces the container, so OpenClaw must not also try to
 * manage the service or update itself. Verified in the image's own
 * `gateway-supervision` module: with this set it reports "OpenClaw self-update is disabled
 * while gateway lifecycle is managed by an external supervisor" and redirects lifecycle
 * actions to the supervisor.
 *
 * Without it, a self-update would drift the running version away from the one the plan
 * pinned — defeating the version guard from the inside.
 */
export const SUPERVISOR_ENV = '-e OPENCLAW_SUPERVISOR_MODE=external'

/** Makes `host.docker.internal` resolvable for host-local model runtimes (Ollama, LM Studio). */
export const ADD_HOST_FLAG = '--add-host=host.docker.internal:host-gateway'

export type Supervisor = 'docker' | 'systemd'
export type PublishScope = 'loopback' | 'all'

export interface GatewayRunSpec {
  /** Full image reference including tag, e.g. `ghcr.io/openclaw/openclaw:2026.7.1`. */
  image: string
  /**
   * Host path to the STATE DIRECTORY — not the config file.
   *
   * OpenClaw writes its config by atomic rename, and renaming over a bind-mounted *file*
   * fails EBUSY whether the mount is :ro or rw, which blocks `plugins install` outright.
   * Mounting the parent directory is the fix, and it is also what makes SQLite state and
   * installed plugins survive a container replacement. SP-10b §4, SP-11 §B.
   */
  stateDir: string
  /** Port to publish and pin. String so shell templates can pass a variable. */
  port?: string | number
  /** Host path to the token env file. Attached only if non-empty at runtime. */
  envFilePath?: string
  /**
   * `docker` emits stop → rm → `docker run -d --restart unless-stopped`.
   * `systemd` emits a bare foreground `docker run --rm` for an ExecStart line, because
   * systemd owns restarts and a detached container would exit the unit immediately.
   */
  supervisor?: Supervisor
  /**
   * `loopback` publishes on 127.0.0.1 only — the gateway is reached over `clawops tunnel`
   * or a reverse proxy, per docs/limitations.md. `all` restores 0.0.0.0 for a deployment
   * that has deliberately opened the gateway CIDR.
   */
  publish?: PublishScope
  /** Prefix for hosts where docker is not on a non-interactive PATH (macOS). */
  pathPrefix?: string
  /** Opt-in capacity limits. */
  limits?: { memory?: string; cpus?: string }
  /**
   * Extra `docker run` arguments inserted immediately before the image.
   *
   * The seam exists for the AWS path, which resolves AWS_DEFAULT_REGION from IMDSv2 at
   * container start and injects `-e` flags for it. Keep it to flags — anything that
   * belongs to every deployment belongs in this module instead.
   */
  extraArgs?: string
}

function publishFlag(port: string | number, scope: PublishScope): string {
  return scope === 'loopback' ? `-p 127.0.0.1:${port}:${port}` : `-p ${port}:${port}`
}

/**
 * The `docker run …` invocation, without any stop/rm preamble.
 *
 * Exported so a systemd ExecStart line and the detached path are provably the same
 * command with different supervision, rather than two strings that look similar.
 */
export function gatewayRunArgs(spec: GatewayRunSpec): string {
  const {
    image,
    stateDir,
    port = GATEWAY_PORT,
    envFilePath = ENV_FILE_PATH,
    supervisor = 'docker',
    publish = 'loopback',
    limits,
  } = spec

  // Attached through a shell test rather than unconditionally: a deployment created
  // before v1.7.2 has no env file, and `--env-file` on a missing target is fatal.
  const envFileArg = `$([ -s ${envFilePath} ] && echo --env-file ${envFilePath})`

  const lifecycle =
    supervisor === 'systemd'
      ? '--rm'                       // foreground; systemd restarts it
      : '-d --restart unless-stopped'

  const capacity = [
    limits?.memory ? `--memory ${limits.memory}` : '',
    limits?.cpus ? `--cpus ${limits.cpus}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return [
    `docker run ${lifecycle} --name openclaw`,
    publishFlag(port, publish),
    SECURITY_FLAGS,
    capacity,
    // No OPENCLAW_CONFIG_PATH: STATE_DIR_CONTAINER is OpenClaw's own default, so mounting
    // it there *is* the configuration. One fewer thing to keep in sync.
    ADD_HOST_FLAG,
    SUPERVISOR_ENV,
    envFileArg,
    // The directory, writable. Never the file, and never :ro — see GatewayRunSpec.stateDir.
    `-v ${stateDir}:${STATE_DIR_CONTAINER}`,
    spec.extraArgs?.trim() ?? '',
    image,
    // No --allow-unconfigured. That flag bypasses a check upstream describes as detecting
    // "suspicious or clobbered config", and clawops passed it permanently — meaning a
    // clobbered config would have started silently on defaults instead of failing.
    // Provisioning writes `gateway.mode: "local"`, which is what the check actually wants.
    // Measured on 2026.9.2: with the mode present the gateway starts without the flag; a
    // config lacking it exits 78, which is the signal we want rather than one we suppress.
    `node openclaw.mjs gateway run --port ${port}`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The full stop → rm → run chain used by every restart and bootstrap path.
 *
 * Meaningless for `supervisor: 'systemd'`, which supplies its own ExecStartPre lines;
 * that caller wants `gatewayRunArgs` instead.
 */
export function gatewayRunCommand(spec: GatewayRunSpec): string {
  const { pathPrefix = '' } = spec
  return (
    pathPrefix +
    [
      'docker stop openclaw 2>/dev/null || true',
      'docker rm   openclaw 2>/dev/null || true',
      gatewayRunArgs(spec),
    ].join(' && ')
  )
}

/** Reads the host port bindings off the running container. */
export const PUBLISH_INSPECT_CMD =
  `docker inspect openclaw --format '{{json .HostConfig.PortBindings}}'`

/**
 * Work out which publish scope a restart should reuse.
 *
 * A restart must not change reachability, for the same reason it must not change the
 * deployed version: the operator asked for a restart, not a reconfiguration. v1.7.6 fixed
 * the version half of this — a fallback that silently *widened* the version. This is the
 * mirror case: without it, restarting a deliberately exposed deployment would silently
 * narrow it to loopback and look like an outage.
 *
 * Unparseable or absent output falls back to the safe default rather than guessing wide.
 */
export function publishForRestart(inspectStdout: string): PublishScope {
  try {
    const bindings = JSON.parse(inspectStdout.trim()) as Record<
      string,
      { HostIp?: string }[] | null
    > | null
    if (!bindings) return 'loopback'
    for (const hostPorts of Object.values(bindings)) {
      for (const binding of hostPorts ?? []) {
        const ip = binding.HostIp ?? ''
        // '' and 0.0.0.0 both mean every interface.
        if (ip === '' || ip === '0.0.0.0' || ip === '::') return 'all'
      }
    }
  } catch {
    // fall through
  }
  return 'loopback'
}
