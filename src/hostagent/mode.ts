// Whether this process is a host agent, and which stack it is.
//
// Set once, by `clawops mcp serve --host-agent`, before any tool is registered. Below the tools,
// three things read it: the context builder (no ~/.clawops config, no Pulumi), connection
// resolution (the gateway is local, so there is nothing to resolve) and the connection pool
// (no SSH at all). Keeping the switch in one module means none of those can disagree.

import { UsageError } from '../errors/index.js'
import type { HostAgentConfig } from './config.js'

let active: HostAgentConfig | undefined

export function enterHostAgentMode(config: HostAgentConfig): void {
  active = config
}

/** The host agent's configuration, or undefined when this is an ordinary clawops process. */
export function hostAgent(): HostAgentConfig | undefined {
  return active
}

/** For tests only: leave host-agent mode so the next test starts as an ordinary process. */
export function exitHostAgentModeForTests(): void {
  active = undefined
}

/**
 * The stack a host-agent call is about, or a refusal.
 *
 * A host agent manages only the host it runs on (ADR 0014, revised 2026-10-16). Omitting the
 * stack means that one. Naming another is refused rather than ignored: a call that named `prod`
 * and silently ran against `staging` would answer a question nobody asked.
 */
export function hostAgentStack(config: HostAgentConfig, requested: unknown): string {
  if (typeof requested !== 'string' || requested === '' || requested === config.stack) {
    return config.stack
  }
  throw new UsageError(
    `This host agent manages only stack "${config.stack}", the host it runs on. ` +
      `"${requested}" is managed from the operator's machine.`,
  )
}

/** Said wherever a host agent is asked for something only the operator's machine has. */
export function operatorOnlyMessage(what: string): string {
  return (
    `${what} needs the operator's machine: a host agent holds no Pulumi state, no cloud ` +
    'credentials and no clawops config. Ask the operator to run it there.'
  )
}
