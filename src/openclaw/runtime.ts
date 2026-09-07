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

/** Container-side path clawops mounts its config to. */
export const CONFIG_MOUNT_PATH = '/app/config.json'

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

/** Makes `host.docker.internal` resolvable for host-local model runtimes (Ollama, LM Studio). */
export const ADD_HOST_FLAG = '--add-host=host.docker.internal:host-gateway'

export type Supervisor = 'docker' | 'systemd'
export type PublishScope = 'loopback' | 'all'

export interface GatewayRunSpec {
  /** Full image reference including tag, e.g. `ghcr.io/openclaw/openclaw:2026.7.1`. */
  image: string
  /** Host path to the config. */
  configPath: string
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
    configPath,
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
    `-e OPENCLAW_CONFIG_PATH=${CONFIG_MOUNT_PATH}`,
    ADD_HOST_FLAG,
    envFileArg,
    `-v ${configPath}:${CONFIG_MOUNT_PATH}:ro`,
    spec.extraArgs?.trim() ?? '',
    image,
    `node openclaw.mjs gateway run --allow-unconfigured --port ${port}`,
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
