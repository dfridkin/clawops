// The host agent's own configuration — ADR 0014.
//
// A host agent runs on the gateway host and manages only that host. What it manages is fixed
// when the operator installs it, from their own machine, and written here. Nothing an agent
// sends can change it: tool arguments are checked against this file, not the other way round.
//
// This is not ~/.clawops/config.json. That file names state backends and SSH keys, and a host
// agent has neither: it reaches its gateway directly and holds no cloud or state credentials
// (ADR 0014 §5, preconditions 3 and 4).

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { z } from 'zod'
import { UsageError } from '../errors/index.js'

/** Where `clawops agent install` writes the configuration on the host. */
export const HOST_AGENT_CONFIG_PATH = '/etc/clawops-agent/agent.json'

/** The host agent's state directory: audit log and handoffs. The unit sets CLAWOPS_HOME to it. */
export const HOST_AGENT_STATE_DIR = '/var/lib/clawops-agent'

const HostAgentConfigSchema = z.object({
  version: z.literal(1),
  /** The stack this host is. The only stack a host agent will name. */
  stack: z.string().min(1),
  /** The stack's provider, for messages and provider-specific checks. Never used to reach a cloud. */
  provider: z.string().min(1),
  /** The OpenClaw agent that receives the clawops tools. */
  agentId: z.string().min(1),
  /** Who may reach that agent, as `<channel>:<peer-id>`. */
  operators: z.array(z.string().min(1)).min(1),
  /** Destructive tools the operator allowed. Each one hands off rather than running. */
  allow: z.array(z.string()),
  /** `--strict`: refuse while another agent can act inside the gateway container (condition 6). */
  strict: z.boolean().default(false),
  /**
   * Where the server listens: the Docker bridge's gateway address, which the gateway container
   * reaches as host.docker.internal. Recorded so `harden`'s firewall reset keeps the rule that
   * lets the container in, and so uninstall can remove it.
   */
  listen: z.object({ address: z.string().min(1), port: z.number().int().min(1).max(65535) }).optional(),
  /**
   * Fleet membership (ADR 0015), present only when install was given `--serve-peers` or `--peer`.
   * `peerUid` is the uid the firewall table lets reach peers, so the host agent can check the
   * table it finds is the one install loaded.
   */
  fleet: z.object({
    /** `--serve-peers`: the tag a caller must carry. Absent on a host that only queries peers. */
    serves: z.string().min(1).optional(),
    /** `--peer`: the only hosts this one may query, by stack and tailnet name. */
    peers: z.array(z.object({ stack: z.string().min(1), node: z.string().min(1) })),
    peerUid: z.number().int().positive(),
  }).optional(),
  installedAt: z.string(),
})

export type HostAgentConfig = z.infer<typeof HostAgentConfigSchema>

/** The config path, overridable for tests and for a non-default install. */
export function hostAgentConfigPath(): string {
  return process.env['CLAWOPS_AGENT_CONFIG'] ?? HOST_AGENT_CONFIG_PATH
}

/**
 * Read and validate the host agent's configuration.
 *
 * Throws rather than starting with a guess. A host agent that served without knowing which
 * stack it is could not refuse a call aimed at another one.
 */
export function loadHostAgentConfig(file = hostAgentConfigPath()): HostAgentConfig {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    throw new UsageError(
      `No host-agent configuration at ${file}. A host agent is installed from the operator's ` +
        'machine with `clawops agent install`, which writes it.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UsageError(`The host-agent configuration at ${file} is not valid JSON.`)
  }
  const result = HostAgentConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new UsageError(`The host-agent configuration at ${file} is invalid: ${issues.join('; ')}`)
  }
  return result.data
}
