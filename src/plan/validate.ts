// Maker plan validation via ajv against spec/deploy-plan.schema.json.

import Ajv from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeployPlan } from './generate'
import { resolveSpecDir } from '../spec-path.js'

let _validate: ReturnType<Ajv['compile']> | undefined

function getValidator(): ReturnType<Ajv['compile']> {
  if (_validate) return _validate
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  const schema = JSON.parse(
    readFileSync(join(resolveSpecDir(), 'deploy-plan.schema.json'), 'utf-8'),
  ) as object
  _validate = ajv.compile(schema)
  return _validate
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

export function validatePlan(plan: unknown): ValidationResult {
  const validate = getValidator()
  const ok = validate(plan) as boolean
  if (ok) return { ok: true, errors: [] }
  const errors = (validate.errors ?? []).map(
    e => `${e.instancePath} ${e.message ?? ''}`.trim(),
  )
  return { ok: false, errors }
}

export function assertValidPlan(plan: unknown): asserts plan is DeployPlan {
  const result = validatePlan(plan)
  if (!result.ok) {
    throw new Error(`Invalid deploy plan:\n${result.errors.join('\n')}`)
  }
}

/**
 * Validate the OpenClaw config a plan carries, against OpenClaw's own schema.
 *
 * `spec.openclaw.config` is a free-form object in the plan schema — deliberately, since it
 * mirrors whatever OpenClaw accepts. The consequence was that a plan containing an invalid
 * config passed plan validation completely and failed only at write time, on the host,
 * after provisioning.
 *
 * That defeats the point of the Maker flow. The plan is the artifact a human reviews before
 * anything reaches their cloud account (R-meta / F5-F6); a config error it cannot express
 * is one review cannot catch. Checking here moves the failure from "after the VM exists"
 * to "before you approve it".
 *
 * Separate from `validatePlan` because it is async — the OpenClaw schema is ~1 MB and
 * compiled lazily.
 */
export async function validatePlanConfig(plan: {
  spec?: { openclaw?: { version?: string; config?: unknown; channels?: unknown } }
}): Promise<ValidationResult & { warnings: string[] }> {
  const overlay = plan.spec?.openclaw?.config
  if (overlay === undefined || overlay === null) return { ok: true, errors: [], warnings: [] }

  const [{ validateConfig }, yaml] = await Promise.all([
    import('../openclaw/config-validate.js'),
    import('js-yaml'),
  ])
  const { loadVersionSpec } = await import('../openclaw/versions.js')
  const spec = loadVersionSpec(yaml)

  // A plan's overlay is merged ONTO the provisioned config, which already carries
  // gateway.mode. Judging the fragment on its own would demand a field the operator has no
  // reason to repeat, so the deployment-contract rule is satisfied here and the schema does
  // the rest.
  //
  // DEEP merge, not a spread: an overlay setting `gateway.port` would otherwise replace the
  // whole gateway object and take `mode` with it — reporting an error the operator did not
  // make. The same merge apply.ts performs against the live config.
  const { deepMerge } = await import('./remote-config.js')
  const merged = deepMerge(
    { gateway: { mode: 'local' } },
    overlay as Record<string, unknown>,
  ) as Record<string, unknown>

  const { errors, warnings } = await validateConfig(merged, {
    openclawVersion: plan.spec?.openclaw?.version,
    schemaCapturedFrom: spec.runtime?.configSchemaCapturedFrom,
  })
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Network rules the JSON Schema cannot express usefully.
 *
 * These are contract errors, not schema errors: each shape below is valid JSON that
 * describes a deployment which will not behave the way it reads.
 */
export function validatePlanNetwork(plan: {
  spec?: {
    network?: {
      allowedGatewayCidrs?: string[]
      allowedSshCidrs?: string[]
      publishGateway?: string
      gatewayPort?: number
    }
    openclaw?: { config?: unknown }
  }
}): ValidationResult & { warnings: string[] } {
  const net = plan.spec?.network
  if (!net) return { ok: true, errors: [], warnings: [] }

  const errors: string[] = []
  const warnings: string[] = []
  const publish = net.publishGateway ?? 'loopback'
  const gatewayCidrs = net.allowedGatewayCidrs ?? []

  // Rules for a port nothing routable is listening on. They grant no access, and to anyone
  // auditing the security group they read as an exposed gateway. Silently dropping them
  // would leave the plan saying one thing and the infrastructure doing another, so the plan
  // is refused while it is still a file the operator can edit.
  if (publish === 'loopback' && gatewayCidrs.length > 0) {
    errors.push(
      `network.allowedGatewayCidrs lists ${gatewayCidrs.length} CIDR(s) but ` +
        `network.publishGateway is "loopback", so the gateway binds 127.0.0.1 on the host ` +
        `and nothing is listening on a routable interface. Those rules would admit traffic ` +
        `to a closed port. Either drop them and reach the gateway with \`clawops tunnel\`, ` +
        `or set publishGateway to "all" — which serves plaintext HTTP, so put TLS in front ` +
        `of it.`,
    )
  }

  // N10. clawops never defaults to this; a plan can still ask for it.
  for (const [field, cidrs] of [
    ['allowedSshCidrs', net.allowedSshCidrs ?? []],
    ['allowedGatewayCidrs', gatewayCidrs],
  ] as const) {
    if (cidrs.some((c) => c === '0.0.0.0/0' || c === '::/0')) {
      warnings.push(
        `network.${field} admits the whole internet. clawops will create the rule you asked ` +
          `for, but \`clawops harden\` reports it as a finding.`,
      )
    }
  }

  // The published port and the port the gateway listens on are set separately and must
  // agree: a container publishing one while the gateway binds another starts, satisfies a
  // container-level check, and answers nothing.
  const configured = gatewayPortFromConfig(plan.spec?.openclaw?.config)
  if (net.gatewayPort !== undefined && configured !== undefined && configured !== net.gatewayPort) {
    errors.push(
      `network.gatewayPort is ${net.gatewayPort} but the config overlay sets ` +
        `gateway.port to ${configured}. The container would publish one port while the ` +
        `gateway listened on the other. Set one of them, not both.`,
    )
  }

  return { ok: errors.length === 0, errors, warnings }
}

function gatewayPortFromConfig(config: unknown): number | undefined {
  if (config === null || typeof config !== 'object') return undefined
  const gateway = (config as Record<string, unknown>)['gateway']
  if (gateway === null || typeof gateway !== 'object') return undefined
  const port = (gateway as Record<string, unknown>)['port']
  return typeof port === 'number' ? port : undefined
}
