import { type Result, ok, err } from '../types/result.js'

// Shared fragments for the `docker run` invocations that start OpenClaw.
//
// These are constants, not a command builder. Consolidating the seven hand-written
// run commands into one builder is WO-38 on the clawops 2.x line; doing it inside a
// patch release is how a patch release breaks things. Sharing the *values* is enough
// to stop the seven sites drifting from each other.

/** Container-side path clawops mounts its config to. */
export const CONFIG_MOUNT_PATH = '/app/config.json'

/** Host-published gateway port. */
export const GATEWAY_PORT = 18789

/**
 * Tells OpenClaw where its config actually is.
 *
 * Without this the mounted file is read by nothing: `OPENCLAW_CONFIG_PATH` is unset,
 * `~/.openclaw/openclaw.json` does not exist, and the gateway runs entirely on
 * defaults. Verified on 2026.7.1 and 2026.8.1 — a config declaring
 * `gateway.port: 19999` was ignored by both; both bound 18789.
 * See docs/spikes/SP-01-container-profile.md.
 */
export const CONFIG_PATH_ENV = `-e OPENCLAW_CONFIG_PATH=${CONFIG_MOUNT_PATH}`

/**
 * Makes `host.docker.internal` resolvable inside the container.
 *
 * Required for host-local model runtimes (Ollama, LM Studio): `localhost` inside the
 * container is the container. Verified: the alias resolves to the bridge gateway with
 * this flag and does not exist without it.
 */
export const ADD_HOST_FLAG = '--add-host=host.docker.internal:host-gateway'

/**
 * Pins the listener to the published port.
 *
 * Enabling config delivery means a stored `gateway.port` takes effect for the first
 * time; if it disagrees with the `-p` mapping the gateway becomes unreachable. argv
 * beats config on both 2026.7.1 and 2026.8.1, so this makes that class of breakage
 * impossible rather than merely unlikely.
 */
export const PORT_PIN = `--port ${GATEWAY_PORT}`

/** Flags common to every run site that mounts a config. */
export const COMMON_RUN_FLAGS = `${CONFIG_PATH_ENV} ${ADD_HOST_FLAG}`

/** Host path to the env file holding OPENCLAW_GATEWAY_TOKEN. */
export const ENV_FILE_PATH = '/home/clawops/openclaw.env'

export interface GatewayRunOpts {
  /** Full image reference, e.g. `ghcr.io/openclaw/openclaw:2026.7.1`. */
  image: string
  /** Host path to openclaw.json. */
  configPath: string
  /** Host path to the token env file. */
  envFilePath?: string
  /** Prefix for hosts where docker is not on a non-interactive PATH (macOS). */
  pathPrefix?: string
}

/** Reads the image tag off the running container. Deliberately has no `|| echo` fallback. */
export const IMAGE_INSPECT_CMD = `docker inspect openclaw --format '{{.Config.Image}}'`

/**
 * Resolve the image a restart should reuse.
 *
 * Restart paths reuse whatever the host already runs rather than a version from
 * config, which is right — a restart should not change the deployed version. But
 * every one of them used to fall back to `:stable` or `:latest` when `docker inspect`
 * found no container, and both tags now resolve to OpenClaw 2.0, which this release
 * line refuses to deploy and cannot run. That fallback ran *after* the version guard,
 * so it pushed an unsupported version past the exact check meant to stop it.
 *
 * When there is no container there is nothing to reuse. Say so instead of guessing.
 */
export function imageForRestart(inspectStdout: string): Result<string, string> {
  const image = inspectStdout.trim()
  if (!image || image.includes('Error') || !image.includes(':')) {
    return err(
      'No running OpenClaw container found, so there is no image version to reuse. ' +
        'Deploy one with `clawops up --openclaw-version <version>`. ' +
        'clawops does not fall back to `latest` or `stable` here: both now point at ' +
        'OpenClaw 2.0, which this release line does not support.',
    )
  }
  return ok(image)
}

/** The version segment of an image reference, for display. */
export function versionOf(image: string): string {
  return image.split(':')[1] ?? 'unknown'
}

/**
 * The one place a gateway container is started, across the CLI and the MCP server.
 *
 * (`src/pulumi/components/gateway.ts` also hand-writes a run command, but nothing
 * constructs it — only its own test does — so it starts no real container. It is
 * fixed or removed under WO-38; leaving it as a working-looking trap is the risk
 * there, not a live defect.)
 *
 * Every restart path previously built this string by hand, and they had drifted:
 * `gateway restart`, `gateway update` and `config set` passed no command at all, so
 * the container fell back to the image's bare CMD — losing `--allow-unconfigured`,
 * the port pin and the token, and dying with "existing config is missing
 * gateway.mode". Verified on 2026.7.1.
 *
 * The env file is attached through a shell test rather than unconditionally, so a
 * deployment created before v1.7.2 — which has no env file — still starts instead of
 * failing on a missing `--env-file` target.
 */
export function gatewayRunCommand(opts: GatewayRunOpts): string {
  const { image, configPath, envFilePath = ENV_FILE_PATH, pathPrefix = '' } = opts
  const envFileArg = `$([ -s ${envFilePath} ] && echo --env-file ${envFilePath})`
  return (
    pathPrefix +
    [
      'docker stop openclaw 2>/dev/null || true',
      'docker rm   openclaw 2>/dev/null || true',
      `docker run -d --name openclaw --restart unless-stopped ` +
        `-p ${GATEWAY_PORT}:${GATEWAY_PORT} ${COMMON_RUN_FLAGS} ${envFileArg} ` +
        `-v ${configPath}:${CONFIG_MOUNT_PATH}:ro ${image} ` +
        `node openclaw.mjs gateway run --allow-unconfigured ${PORT_PIN}`,
    ].join(' && ')
  )
}
