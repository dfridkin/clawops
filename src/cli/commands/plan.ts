import { defineCommand } from 'citty'
import process from 'node:process'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { success, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'plan',
    description: 'Generate a Maker deploy plan without applying it',
  },
  args: {
    provider:          { type: 'string', description: 'Cloud provider (aws|gcp|azure)' },
    stack:             { type: 'string', description: 'Target stack name' },
    region:            { type: 'string', description: 'Cloud region' },
    'instance-type':   { type: 'string', description: 'Instance size alias (micro|small|medium|large|gpu)' },
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
      const { create, update, delete: del, totalChanges } = plan.diff
      process.stderr.write(
        `\nChanges: ${create.length} to create, ${update.length} to update, ${del.length} to delete (${totalChanges} total)\n`,
      )
      const rows: string[][] = [
        ...create.map((r) => ['+', r.type, r.name ?? '']),
        ...update.map((r) => ['~', r.resource.type, r.resource.name ?? '']),
        ...del.map((r) => ['-', r.type, r.name ?? '']),
      ]
      if (rows.length > 0) {
        process.stderr.write(renderTable(['Op', 'Resource Type', 'Name'], rows) + '\n')
      }
    } else {
      process.stderr.write('\n(diff unavailable — preview could not run against this stack)\n')
    }
  },
})

/** citty hands through unparsed values; only a real string is an answer. */
function strArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
