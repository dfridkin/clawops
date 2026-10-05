// Where to SSH for a stack: local state for the local provider, Pulumi outputs otherwise.
// Shared by the CLI, the MCP tools and the flows both call, so it lives below all of them.

import type { ClawopsContext } from '../cli/context.js'
import { StateError } from '../errors/index.js'
import { pulumiCause } from '../errors/pulumi.js'

export interface ConnInfo {
  host: string
  port: number
  user: string
  privateKeyPath: string
  knownHostsPath: string
}

export async function resolveConn(ctx: ClawopsContext): Promise<ConnInfo> {
  if (ctx.adapter.name === 'local') {
    const state = ctx.localState
    if (!state) throw new StateError('Stack has no local state — run `clawops up` first.')
    return {
      host: state.sshHost,
      port: state.sshPort,
      user: state.sshUser,
      privateKeyPath: state.privateKeyPath,
      knownHostsPath: state.knownHostsPath,
    }
  }

  const { extractBaseOutputs } = await import('../pulumi/outputs.js')
  let outputs: Record<string, unknown>
  try {
    const stack = await ctx.getStack()
    const outputMap = await stack.outputs()
    outputs = Object.fromEntries(Object.entries(outputMap).map(([k, v]) => [k, v.value]))
  } catch (err) {
    // Pulumi reports a backend it cannot read as `code: -2` and a subprocess dump. Every tool
    // and command that connects to a stack comes through here, so this is where it is said
    // plainly. The usual cause is credentials missing from THIS process's environment — for
    // an MCP server, its client config's env block, which does not inherit the shell's.
    throw new StateError(
      `Could not read the state of stack "${ctx.stackName}": ${pulumiCause(err)}. ` +
        'Check that the credentials for its state backend are in this process\'s environment ' +
        '(for an MCP server, the env block of its client config).',
    )
  }
  if (!outputs['publicIp']) {
    throw new StateError('Stack has no outputs — run `clawops up` first.')
  }
  const base = extractBaseOutputs(outputs)
  return ctx.adapter.getConnectionInfo({
    ...base,
    privateKeyPath: ctx.config.ssh.keyPath,
    knownHostsPath: ctx.config.ssh.knownHostsPath,
  })
}
