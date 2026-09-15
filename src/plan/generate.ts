// Maker plan generation — per SPEC.md §12.6 and spec/deploy-plan.schema.json.

import { randomUUID } from 'node:crypto'
import { buildContext, loadAdapterModule } from '../cli/context.js'
import type { ProviderName } from '../providers/types.js'
import { getConfig } from '../config/store.js'
import { UsageError, StateError } from '../errors/index.js'
import { validatePlan } from './validate.js'

export interface DeployPlan {
  apiVersion: 'clawops.dev/v1'
  kind: 'DeployPlan'
  metadata: {
    name: string
    generatedAt: string
    generator?: string
    generatorVersion?: string
    labels?: Record<string, string>
    /** Pulumi stack version at plan generation time. Used for drift detection at apply. */
    stackVersion?: number
  }
  spec: {
    provider: 'aws' | 'gcp' | 'azure' | 'local'
    region?: string
    stackName: string
    instanceType: string
    openclaw: {
      version: string
      config?: Record<string, unknown>
      channels?: Record<string, unknown>
    }
    secrets?: Array<{
      name: string
      source: 'env' | 'aws-sm' | 'aws-ssm' | 'gcp-sm' | 'azure-kv' | 'file'
      ref?: string
    }>
    network: {
      allowedSshCidrs: string[]
      allowedGatewayCidrs: string[]
      /** Interface the gateway publishes on. Defaults to loopback. */
      publishGateway?: 'loopback' | 'all'
      /** Host port the gateway is published on. Defaults to GATEWAY_PORT. */
      gatewayPort?: number
      tailscale?: { enabled: boolean; authKeyRef?: string }
    }
    ssh?: { publicKey?: string; user?: string }
    tags?: Record<string, string>
  }
  diff?: {
    create: Array<{ urn: string; type: string; name?: string }>
    update: Array<{ resource: { urn: string; type: string; name?: string }; before: unknown; after: unknown }>
    delete: Array<{ urn: string; type: string; name?: string }>
    totalChanges: number
  }
}

export interface GeneratePlanIntent {
  stackName: string
  provider: 'aws' | 'gcp' | 'azure'
  region?: string
  instanceType?: string
  openclawVersion?: string
  network?: {
    allowedSshCidrs: string[]
    allowedGatewayCidrs: string[]
    publishGateway?: 'loopback' | 'all'
    gatewayPort?: number
  }
  tags?: Record<string, string>
}

// Regex to parse Pulumi preview output lines:
//   +  aws:ec2/instance:Instance  name  create
//   ~  aws:ec2/eip:Eip            name  update
//   -  aws:iam/role:Role          name  delete
const PREVIEW_LINE_RE = /^([+~-])\s+(\S+)\s+(\S+)?/

type ResourceRef = { urn: string; type: string; name?: string }

function parseDiff(lines: string[]): DeployPlan['diff'] {
  const create: ResourceRef[] = []
  const update: Array<{ resource: ResourceRef; before: unknown; after: unknown }> = []
  const del: ResourceRef[] = []

  // Pulumi prints the stack resource in more than one section of a preview, so the same line
  // arrives repeatedly. Counting it each time inflated "7 to create" for a stack that creates
  // four resources — a number an operator is being asked to approve.
  const seen = new Set<string>()

  for (const line of lines) {
    const m = PREVIEW_LINE_RE.exec(line.trimStart())
    if (!m) continue
    const [, op, resourceType, name] = m as unknown as [string, string, string, string | undefined]
    const urn = `urn:pulumi:::clawops::${resourceType}::${name ?? ''}`
    if (seen.has(`${op}${urn}`)) continue
    seen.add(`${op}${urn}`)
    const ref: ResourceRef = {
      urn,
      type: resourceType,
      ...(name ? { name } : {}),
    }
    if (op === '+') create.push(ref)
    else if (op === '~') update.push({ resource: ref, before: null, after: null })
    else if (op === '-') del.push(ref)
  }

  return {
    create,
    update,
    delete: del,
    totalChanges: create.length + update.length + del.length,
  }
}

/** The sizes clawops names. Each adapter maps them to something its cloud recognises. */
export const INSTANCE_ALIASES = ['micro', 'small', 'medium', 'large', 'gpu'] as const
export type InstanceAliasName = (typeof INSTANCE_ALIASES)[number]

export function isInstanceAlias(value: string): value is InstanceAliasName {
  return (INSTANCE_ALIASES as readonly string[]).includes(value)
}

/**
 * A machine type the cloud will accept.
 *
 * `spec/deploy-plan.schema.json` has always said this field holds a "provider-native instance
 * type. Adapter normalizes from clawops alias before plan emission" — and the plan emitted the
 * alias. Every adapter has had `normalizeInstanceType` from the start and `clawops up` calls
 * it; `generatePlan` never did, so apply handed `small` to the cloud:
 *
 *   Error 400: Invalid value for field 'resource.machineType':
 *   '…/machineTypes/small'. Machine type with name 'small' does not exist in zone …
 *
 * The same on AWS, where the type is `t3.small`, and on Azure, where it is `Standard_B2s`.
 *
 * A value that is not one of our aliases is passed through: an operator who names a real
 * machine type knows what their cloud offers better than this table does. It is announced,
 * because a mistyped alias would otherwise reach the cloud unremarked.
 */
async function resolveInstanceType(intent: GeneratePlanIntent): Promise<string> {
  const requested = intent.instanceType ?? 'small'
  if (!isInstanceAlias(requested)) {
    process.stderr.write(
      `[clawops] note: "${requested}" is not a clawops size ` +
        `(${INSTANCE_ALIASES.join(', ')}), so it is passed to ${intent.provider} as written.\n`,
    )
    return requested
  }
  // The adapter module, not `buildContext().adapter`: the latter is a proxy whose synchronous
  // methods throw until something has loaded the module behind it, and nothing here needs a
  // stack. Reaching through the proxy failed at plan time with "Provider not yet loaded".
  const adapter = await loadAdapterModule(intent.provider as ProviderName)
  return adapter.normalizeInstanceType(requested)
}

/** Exposed for tests: the preview parser is otherwise unreachable without a live stack. */
export const parseDiffForTest = parseDiff

export async function generatePlan(
  intent: GeneratePlanIntent,
  _opts?: { signal?: AbortSignal },
): Promise<DeployPlan> {
  if ((intent.provider as string) === 'local') {
    throw new UsageError(
      'plan/apply is not supported for the local provider. Use `clawops up` directly.',
    )
  }

  const { version } = await import('../../package.json', { assert: { type: 'json' } })
  const config = getConfig()
  const instanceType = await resolveInstanceType(intent)
  const { guardOpenclawVersion, defaultOpenclawVersion } = await import('../cli/version-guard.js')
  const openclawVersion = await guardOpenclawVersion(
    intent.openclawVersion ?? (await defaultOpenclawVersion()),
  )
  const network = intent.network ?? {
    allowedSshCidrs: [],
    allowedGatewayCidrs: [],
  }

  // Every cloud program refuses to run without stack config `sshPublicKey`, and nothing filled
  // it outside the wizard, so a plan generated from the CLI failed at preview. The key goes in
  // the plan rather than being read during apply: "which key can log into this machine" is
  // exactly what a plan review is for.
  const { resolvePublicKey } = await import('./ssh-key.js')
  const publicKey = config ? resolvePublicKey(expandHome(config.ssh.keyPath)) : undefined
  if (!publicKey) {
    process.stderr.write(
      '[clawops] warning: no SSH public key could be resolved' +
        (config ? ` from ${config.ssh.keyPath}` : ' — no config file') +
        '. `clawops apply` will refuse this plan: the instance would have no way to admit ' +
        'anyone. Run `clawops doctor` to see why the key is unusable.\n',
    )
  }

  const stackName = intent.stackName
  const region = intent.region ?? config?.stacks[stackName]?.region

  const plan: DeployPlan = {
    apiVersion: 'clawops.dev/v1',
    kind: 'DeployPlan',
    metadata: {
      name: stackName,
      generatedAt: new Date().toISOString(),
      generator: 'clawops',
      generatorVersion: version as string,
    },
    spec: {
      provider: intent.provider,
      region,
      stackName,
      instanceType,
      openclaw: { version: openclawVersion },
      network,
      ...(publicKey ? { ssh: { publicKey } } : {}),
      ...(intent.tags ? { tags: intent.tags } : {}),
    },
  }

  // Opening the stack and previewing it fail for different reasons and deserve different
  // answers. `createOrSelectStack` reaches the state backend — a bucket that does not exist, a
  // container clawops cannot read, a passphrase it cannot use — and none of that produces a
  // plan worth having. A preview can still fail on a stack that opened fine, and a plan without
  // a diff is worth writing then.
  //
  // Both used to land in one catch that wrote a warning and carried on, so a missing S3 bucket
  // produced "✔ Plan generated" and exit 0:
  //
  //   error: could not list bucket: NoSuchBucket: The specified bucket does not exist
  //   ✔ Plan generated
  //
  // The operator was told the plan was fine three times before apply told them otherwise.
  let stack: Awaited<ReturnType<Awaited<ReturnType<typeof buildContext>>['getStack']>>
  try {
    const ctx = buildContext({ stack: stackName, provider: intent.provider })
    stack = await ctx.getStack()
  } catch (err) {
    if (err instanceof UsageError) throw err
    throw new StateError(
      `Cannot open the state backend for stack "${stackName}": ${messageOf(err)}\n` +
        'A plan is only as good as the state it was computed against, so this is not a plan ' +
        'clawops will write. Check the stateUrl in ~/.clawops/config.json, and that the ' +
        'bucket or container exists and your credentials can read it.',
    )
  }

  // Run preview to populate diff
  try {
    // The same writer apply uses. Previously this set three keys and apply set six, so the
    // preview was of a stack that would never be deployed — and, missing sshPublicKey, of one
    // that could not even be previewed.
    const { writeStackConfig } = await import('./stack-config.js')
    await writeStackConfig(stack, plan)

    const outputLines: string[] = []
    const preview = await stack.preview({
      onOutput: (line) => outputLines.push(line),
    })

    const diff = parseDiff(outputLines)!

    // Fall back to changeSummary counts if line parsing yielded nothing
    if (diff.totalChanges === 0 && preview.changeSummary) {
      const summary = preview.changeSummary as Record<string, number>
      diff.totalChanges =
        (summary['create'] ?? 0) + (summary['update'] ?? 0) + (summary['delete'] ?? 0)
    }

    plan.diff = diff

    // Capture stack version for drift detection at apply time (ADR 0008).
    // info() returns undefined for new stacks with no history — skip silently.
    const info = await stack.info()
    if (info !== undefined) {
      plan.metadata.stackVersion = info.version
    }
  } catch (err) {
    // A UsageError is not a preview failure: the stack is not registered, or the provider
    // cannot be resolved. Swallowing it produced a plan with an empty diff and a warning three
    // screens up, and the real error only surfaced at apply — which is how a plan for an
    // unregistered stack got as far as `clawops apply`.
    if (err instanceof UsageError) throw err
    // Preview failure is non-fatal — return the structural plan without diff
    process.stderr.write(
      `[clawops] Warning: preview failed, diff section omitted: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  const validation = validatePlan(plan)
  if (!validation.ok) {
    throw new Error(`Generated plan failed schema validation:\n${validation.errors.join('\n')}`)
  }

  // The plan schema treats spec.openclaw.config as free-form, so schema validation says
  // nothing about whether the gateway would accept it. Check it here, while the plan is
  // still a file on disk and nothing has been provisioned.
  const { validatePlanConfig, validatePlanNetwork } = await import('./validate.js')
  const cfgCheck = await validatePlanConfig(plan)
  for (const w of cfgCheck.warnings) process.stderr.write(`[clawops] warning: ${w}\n`)
  if (!cfgCheck.ok) {
    throw new Error(
      `The OpenClaw config in this plan would be rejected:\n` +
        cfgCheck.errors.map((e) => `  - ${e}`).join('\n') +
        `\nFix spec.openclaw.config before applying — the gateway reads it verbatim.`,
    )
  }

  // Firewall rules that would not do what they say. Same reasoning as the config check:
  // catch it while the plan is a file, not after a security group exists.
  const netCheck = validatePlanNetwork(plan)
  for (const w of netCheck.warnings) process.stderr.write(`[clawops] warning: ${w}\n`)
  if (!netCheck.ok) {
    throw new Error(
      `This plan's network settings contradict each other:\n` +
        netCheck.errors.map((e) => `  - ${e}`).join('\n'),
    )
  }

  return plan
}

/** Short ID for use in plan metadata.name when no stack name is given. */
export function planId(): string {
  return randomUUID().slice(0, 8)
}

/** `~` in a configured path is the operator's home, not a directory called "~". */
function expandHome(p: string): string {
  return p.replace(/^~/, process.env['HOME'] ?? '~')
}

/**
 * The informative line of whatever was thrown.
 *
 * A Pulumi CommandError's message opens with "code: -2" and buries the cause several lines
 * down, in the captured stderr:
 *
 *   code: -2
 *    stdout:
 *    stderr: … error: could not list bucket: NoSuchBucket: The specified bucket does not exist
 *
 * Reporting the first line would hand the operator an exit code where the answer was available.
 */
function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const explained = lines.find((l) => /(^|\s)error:/i.test(l))
  if (explained) return explained.replace(/^.*?error:\s*/i, '')
  return lines[0] ?? raw
}
