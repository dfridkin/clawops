// clawops_up handler

import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/dist/esm/types.js'
import type { UpInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { UsageError } from '../../../errors/index.js'
import { makeProgressEmitter, startTask, updateTask } from '../../progress.js'
import { okText, errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'

const VALID_INSTANCE_TYPES = ['micro', 'small', 'medium', 'large', 'gpu'] as const

export async function handleUp(input: UpInput, server: McpServer): Promise<CallToolResult> {
  // R19: elicit unless dryRun
  if (!input.dryRun) {
    const elicit = await server.server.elicitInput({
      message: `Deploy stack "${input.stackName ?? 'default'}" (provider: ${input.provider ?? 'from config'}, instance: ${input.instanceType})? This will provision cloud resources.`,
      requestedSchema: {
        type: 'object' as const,
        properties: { confirmed: { type: 'boolean' as const, title: 'Confirm deployment' } },
        required: ['confirmed'],
      },
    })
    if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
      return okText('Deployment cancelled.')
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

  // ── Cloud provider path (Pulumi) ───────────────────────────────────────────
  const instanceAlias = input.instanceType ?? 'small'
  if (!VALID_INSTANCE_TYPES.includes(instanceAlias as typeof VALID_INSTANCE_TYPES[number])) {
    throw new UsageError(`Invalid instanceType: ${instanceAlias}`)
  }

  const validation = await ctx.adapter.validateConfig()
  if (!validation.ok) {
    return errText(`Provider config invalid: ${validation.errors.join('; ')}`)
  }

  const taskId = randomUUID()
  const progressToken = undefined // not available in sync context; future: pass from extra._meta
  const emit = makeProgressEmitter(server, progressToken)
  startTask(taskId, `clawops_up stack=${ctx.stackName}`)

  const stack = await ctx.getStack()
  const region = input.region ?? ctx.adapter.defaultRegion()
  const instanceType = ctx.adapter.normalizeInstanceType(instanceAlias as typeof VALID_INSTANCE_TYPES[number])

  await stack.setConfig('region', { value: region })
  await stack.setConfig('instanceType', { value: instanceType })
  await stack.setConfig('openclawVersion', { value: openclawVersion })

  if (input.dryRun) {
    const lines: string[] = []
    await stack.preview({ onOutput: (o) => { emit(o.trim()); lines.push(o) } })
    const output = lines.join('')
    updateTask(taskId, 'completed', output)
    const { content } = trimForMcp(output, ctx.stackName)
    return okText(content)
  }

  try {
    const lines: string[] = []
    const result = await stack.up({
      onOutput: (o) => { emit(o.trim()); lines.push(o) },
    })
    const summary = `Stack "${ctx.stackName}" deployed.\n` +
      (result.outputs['publicIp'] ? `Public IP: ${result.outputs['publicIp'].value}\n` : '') +
      (result.outputs['gatewayUrl'] ? `Gateway URL: ${result.outputs['gatewayUrl'].value}\n` : '')
    updateTask(taskId, 'completed', summary)
    const fullOutput = lines.join('')
    trimForMcp(fullOutput, ctx.stackName) // write to disk for resource
    return okText(summary)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateTask(taskId, 'failed', undefined, msg)
    throw err
  }
}
