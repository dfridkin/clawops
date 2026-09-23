// clawops_up handler

import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { UpInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { UsageError } from '../../../errors/index.js'
import { makeProgressEmitter, startTask, updateTask } from '../../progress.js'
import { okText, errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { confirmDestructive } from '../_confirm.js'

export async function handleUp(input: UpInput, server: McpServer): Promise<CallToolResult> {
  // R19: elicit unless dryRun
  if (!input.dryRun) {
    const confirmation = await confirmDestructive(server, {
      message: `Deploy stack "${input.stackName ?? 'default'}" (provider: ${input.provider ?? 'from config'}, instance: ${input.instanceType})? This will provision cloud resources.`,
      title: 'Confirm deployment',
      what: 'provisioning cloud resources',
    })
    if (!confirmation.confirmed) {
      return okText(confirmation.reason)
    }
  }

  const ctx = buildContext({ stack: input.stackName, provider: input.provider })
  const openclawVersion = input.openclawVersion ?? 'stable'

  // ── Local provider path ────────────────────────────────────────────────────
  if (ctx.adapter.name === 'local') {
    const stackConfig = ctx.config.stacks[ctx.stackName]
    if (!stackConfig?.localOpts) {
      throw new UsageError(
        `Stack "${ctx.stackName}" has no localOpts. Run \`clawops init --provider local --host <HOST>\` first.`,
      )
    }
    const { localOpts } = stackConfig
    const { localBootstrap } = await import('../../../providers/local/bootstrap.js')
    const ac = new AbortController()
    const state = await localBootstrap({
      host: localOpts.host,
      port: localOpts.sshPort,
      user: localOpts.sshUser,
      privateKeyPath: localOpts.sshKeyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
      openclawVersion,
      stackName: ctx.stackName,
      noWait: false,
      signal: ac.signal,
    })
    return okText(JSON.stringify({ stack: ctx.stackName, ...state }, null, 2))
  }

  // ── Cloud provider path ────────────────────────────────────────────────────
  //
  // The same plan and apply the CLI uses. This was a third implementation of deploying — after
  // `clawops up` and `clawops apply` — and it wrote the same three pieces of stack config as
  // the first, so it could not deploy either: the programs refuse to run without sshPublicKey,
  // and nothing opened a firewall rule.
  const validation = await ctx.adapter.validateConfig()
  if (!validation.ok) {
    return errText(`Provider config invalid: ${validation.errors.join('; ')}`)
  }

  const taskId = randomUUID()
  const progressToken = undefined // not available in sync context; future: pass from extra._meta
  const emit = makeProgressEmitter(server, progressToken)
  startTask(taskId, `clawops_up stack=${ctx.stackName}`)

  const { generatePlan } = await import('../../../plan/generate.js')
  const { applyPlan } = await import('../../../plan/apply.js')
  const { resolveNetworkFlags } = await import('../../../plan/network-args.js')
  const { detectEgressIp } = await import('../../../providers/firewall.js')

  const network = await resolveNetworkFlags(
    {
      ...(input.sshCidr ? { sshCidr: input.sshCidr } : {}),
      ...(input.gatewayCidr ? { gatewayCidr: input.gatewayCidr } : {}),
      ...(input.publishGateway ? { publishGateway: input.publishGateway } : {}),
    },
    { detectEgressIp: () => detectEgressIp('https://ifconfig.me/ip') },
  )

  try {
    const plan = await generatePlan({
      stackName: ctx.stackName,
      provider: ctx.adapter.name as 'aws' | 'gcp' | 'azure',
      ...(input.region ? { region: input.region } : {}),
      ...(input.instanceType ? { instanceType: input.instanceType } : {}),
      openclawVersion,
      network,
    })

    if (input.dryRun) {
      const summary = JSON.stringify(plan.diff ?? { totalChanges: 0 }, null, 2)
      updateTask(taskId, 'completed', summary)
      const { content } = trimForMcp(summary, ctx.stackName)
      return okText(content)
    }

    const lines: string[] = []
    const result = await applyPlan(plan, {
      onOutput: (o) => { emit(o.trim()); lines.push(o) },
      onProgress: (o) => emit(o),
    })
    const summary = `Stack "${ctx.stackName}" deployed.\n` +
      (result.outputs['publicIp'] ? `Public IP: ${String(result.outputs['publicIp'])}\n` : '') +
      (result.outputs['gatewayUrl'] ? `Gateway URL: ${String(result.outputs['gatewayUrl'])}\n` : '')
    updateTask(taskId, 'completed', summary)
    trimForMcp(lines.join(''), ctx.stackName) // write to disk for resource
    return okText(summary)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateTask(taskId, 'failed', undefined, msg)
    throw err
  }
}
