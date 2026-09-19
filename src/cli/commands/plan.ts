import { defineCommand } from 'citty'
import process from 'node:process'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { success, spinner, warn } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'
import type { DeployPlan } from '../../plan/generate.js'

/**
 * Say what applying this plan does to a deployment that already exists.
 *
 * A plan against a fresh stack only creates, and needs no warning. A plan against a running one
 * can interrupt it or destroy it, and the summary above says neither: "1 to update" does not
 * convey that the gateway stops, and "1 to replace" does not convey that the boot disk, and
 * every session and transcript on it, goes with the instance.
 */
export function disruptionWarnings(diff: NonNullable<DeployPlan['diff']>): string[] {
  const out: string[] = []
  const isInstance = (type: string) => /:(Instance|instance)/.test(type)

  const replaced = (diff.replace ?? [])
  if (replaced.length > 0) {
    const instance = replaced.some((r) => isInstance(r.type))
    out.push(
      `This plan REPLACES ${replaced.length} existing resource${replaced.length === 1 ? '' : 's'}: ` +
      replaced.map((r) => r.name ?? r.type).join(', ') + '.' +
      (instance
        ? ' Replacing the instance destroys its boot disk, and with it the OpenClaw config, ' +
          'database, sessions and transcripts on the host. Take a backup first: `clawops backup create`.'
        : ''),
    )
  }

  if (diff.update.length > 0) {
    const instance = diff.update.some((u) => isInstance(u.resource.type))
    out.push(
      `This plan modifies ${diff.update.length} existing resource${diff.update.length === 1 ? '' : 's'}.` +
      (instance
        ? ' Some instance changes require the machine to be stopped and started, so the gateway ' +
          'goes down for the duration and in-flight work is lost. State on disk is kept.'
        : ''),
    )
  }

  if (diff.delete.length > 0) {
    out.push(`This plan DELETES ${diff.delete.length} existing resource${diff.delete.length === 1 ? '' : 's'}.`)
  }
  return out
}

function warnAboutDisruption(diff: NonNullable<DeployPlan['diff']>): void {
  for (const line of disruptionWarnings(diff)) warn(line)
}

export default defineCommand({
  meta: {
    name: 'plan',
    description: 'Generate a Maker deploy plan without applying it',
  },
  args: {
    provider:          { type: 'string', description: 'Cloud provider (aws|gcp|azure)' },
    stack:             { type: 'string', description: 'Target stack name' },
    region:            { type: 'string', description: 'Cloud region' },
    'instance-type':   { type: 'string', description: 'Instance size: a clawops alias (micro|small|medium|large|gpu) or a type your cloud names itself, e.g. t3.small' },
    'openclaw-version':{ type: 'string', description: "semver or 'stable'/'dev'" },
    'ssh-cidr':        { type: 'string', description: "CIDR(s) allowed to reach SSH, comma-separated, or 'auto' for this machine's IP. Omitted = none, and nothing will be able to connect" },
    'gateway-cidr':    { type: 'string', description: "CIDR(s) allowed to reach the gateway port, comma-separated, or 'auto'. Requires --publish-gateway all" },
    'publish-gateway': { type: 'string', description: 'loopback (default) or all. "all" serves plaintext HTTP — put TLS in front of it' },
    out:               { type: 'string', description: 'Write plan JSON to this absolute path (default: stdout)' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { generatePlan } = await import('../../plan/generate.js')
    const { resolveNetworkFlags } = await import('../../plan/network-args.js')
    const { detectEgressIp } = await import('../../providers/firewall.js')

    const ctx = buildContext(args)

    if (ctx.adapter.name === 'local') {
      throw new UsageError(
        'plan/apply is not supported for the local provider. Use `clawops up` directly.',
      )
    }

    const provider = ctx.adapter.name as 'aws' | 'gcp' | 'azure'
    const outPath = typeof args.out === 'string' ? args.out : undefined

    if (outPath && !isAbsolute(outPath)) {
      throw new UsageError('--out path must be absolute (R7). Use an absolute path like /tmp/plan.json.')
    }

    // Before the spinner: a bad CIDR should be an immediate usage error, not something that
    // surfaces after a preview has run against the cloud.
    const network = await resolveNetworkFlags(
      {
        sshCidr: strArg(args['ssh-cidr']),
        gatewayCidr: strArg(args['gateway-cidr']),
        publishGateway: strArg(args['publish-gateway']),
      },
      { detectEgressIp: () => detectEgressIp('https://ifconfig.me/ip') },
    )

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    const spin = spinner('Generating plan…')
    let plan: Awaited<ReturnType<typeof generatePlan>>
    try {
      plan = await generatePlan(
        {
          stackName: ctx.stackName,
          provider,
          region: typeof args.region === 'string' ? args.region : undefined,
          instanceType: typeof args['instance-type'] === 'string' ? args['instance-type'] : undefined,
          openclawVersion: typeof args['openclaw-version'] === 'string' ? args['openclaw-version'] : undefined,
          network,
        },
        { signal: abortController.signal },
      )
      spin.succeed('Plan generated')
    } catch (err) {
      spin.fail('Plan generation failed')
      throw err
    }

    const planJson = JSON.stringify(plan, null, 2)

    if (outPath) {
      writeFileSync(outPath, planJson + '\n', 'utf-8')
      success(`Plan written to ${outPath}`)
    } else {
      process.stdout.write(planJson + '\n')
    }

    // Plan summary — always to stderr so it doesn't pollute stdout JSON
    const { spec, metadata } = plan
    const sshCidrs = spec.network.allowedSshCidrs.join(', ') || '(none)'
    const gatewayCidrs = spec.network.allowedGatewayCidrs.join(', ') || '(none)'
    const publish = spec.network.publishGateway ?? 'loopback'
    process.stderr.write(
      `\nPlan: ${metadata.name}  (${spec.provider}${spec.region ? ` / ${spec.region}` : ''})\n` +
      `  Instance:  ${spec.instanceType}\n` +
      `  OpenClaw:  ${spec.openclaw.version}\n` +
      `  SSH CIDRs: ${sshCidrs}\n` +
      `  Gateway:   ${gatewayCidrs}\n` +
      `  Published: ${publish === 'all'
        ? '0.0.0.0 — reachable from the network; plaintext HTTP unless you add TLS'
        : '127.0.0.1 only — use `clawops tunnel` or a proxy on the host'}\n`,
    )

    if (plan.diff) {
      const { create, update, delete: del, replace = [], totalChanges } = plan.diff
      process.stderr.write(
        `\nChanges: ${create.length} to create, ${update.length} to update, ` +
        `${replace.length} to replace, ${del.length} to delete (${totalChanges} total)\n`,
      )
      const rows: string[][] = [
        ...create.map((r) => ['+', r.type, r.name ?? '']),
        ...update.map((r) => ['~', r.resource.type, r.resource.name ?? '']),
        ...replace.map((r) => ['+-', r.type, r.name ?? '']),
        ...del.map((r) => ['-', r.type, r.name ?? '']),
      ]
      if (rows.length > 0) {
        process.stderr.write(renderTable(['Op', 'Resource Type', 'Name'], rows) + '\n')
      }
      warnAboutDisruption(plan.diff)
    } else {
      process.stderr.write('\n(diff unavailable — preview could not run against this stack)\n')
    }
  },
})

/** citty hands through unparsed values; only a real string is an answer. */
function strArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
