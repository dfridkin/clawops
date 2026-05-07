// Maker plan generation — per SPEC.md §12.6 and spec/deploy-plan.schema.json.

import { randomUUID } from 'node:crypto'
import { buildContext } from '../cli/context.js'
import { getConfig } from '../config/store.js'
import { UsageError } from '../errors/index.js'
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
  }
  spec: {
    provider: 'aws' | 'gcp' | 'azure' | 'local'
    region?: string
    stackName: string
    instanceType: string
    openclaw: {
      version: string
      config?: Record<string, unknown>
      channels?: string[]
    }
    secrets?: Array<{
      name: string
      source: 'env' | 'aws-sm' | 'aws-ssm' | 'gcp-sm' | 'azure-kv' | 'file'
      ref?: string
    }>
    network: {
      allowedSshCidrs: string[]
      allowedGatewayCidrs: string[]
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
  network?: { allowedSshCidrs: string[]; allowedGatewayCidrs: string[] }
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

  for (const line of lines) {
    const m = PREVIEW_LINE_RE.exec(line.trimStart())
    if (!m) continue
    const [, op, resourceType, name] = m as unknown as [string, string, string, string | undefined]
    const ref: ResourceRef = {
      urn: `urn:pulumi:::clawops::${resourceType}::${name ?? ''}`,
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
  const instanceType = intent.instanceType ?? 'small'
  const openclawVersion = intent.openclawVersion ?? 'latest'
  const network = intent.network ?? {
    allowedSshCidrs: [],
    allowedGatewayCidrs: [],
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
      ...(intent.tags ? { tags: intent.tags } : {}),
    },
  }

  // Run preview to populate diff
  try {
    const ctx = buildContext({ stack: stackName, provider: intent.provider })
    const stack = await ctx.getStack()

    await stack.setConfig('instanceType', { value: instanceType })
    if (region) await stack.setConfig('region', { value: region })
    await stack.setConfig('openclawVersion', { value: openclawVersion })

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
  } catch (err) {
    // Preview failure is non-fatal — return the structural plan without diff
    process.stderr.write(
      `[clawops] Warning: preview failed, diff section omitted: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  const validation = validatePlan(plan)
  if (!validation.ok) {
    throw new Error(`Generated plan failed schema validation:\n${validation.errors.join('\n')}`)
  }

  return plan
}

/** Short ID for use in plan metadata.name when no stack name is given. */
export function planId(): string {
  return randomUUID().slice(0, 8)
}
