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
