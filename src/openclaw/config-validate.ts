// Validating an OpenClaw config against the schema the runtime actually uses.
//
// Replaces five hand-written rules that knew about `version`, `channels`, `meta`,
// `gateway.port` and `gateway.auth.mode` — and nothing else. They would not have caught a
// missing `gateway.mode`, which is the difference between a gateway that starts and one
// that exits 78.
//
// The schema is captured from a pinned OpenClaw release (WO-36). That matters, because
// this line declares no version ceiling: a deployment may legitimately run a newer OpenClaw
// than the schema was captured from, with config keys the schema has never heard of. The
// schema rejects unknown keys in 36 of its 43 sections, so validating naively would make
// clawops refuse to write a config the runtime would happily accept.
//
// So the two failure kinds are separated:
//
//   unknown key   — "my schema may be older than your runtime"  → error, or warning when
//                   the deployed OpenClaw is newer than the captured release
//   everything else — wrong type, bad enum, missing required    → error at any version

import type { ErrorObject, ValidateFunction } from 'ajv'
import { compareVersions } from './versions.js'

export interface ConfigValidation {
  /** Problems that are wrong regardless of which OpenClaw is deployed. */
  errors: string[]
  /**
   * Keys this schema does not recognise, on a runtime newer than the schema's capture.
   * Reported, never fatal — the alternative is blocking a valid config.
   */
  warnings: string[]
}

let cached: ValidateFunction | undefined

/** Compile once. The schema is ~1 MB and takes ~0.9s, so never at import time. */
async function getValidator(): Promise<ValidateFunction> {
  if (cached) return cached
  const [{ default: Ajv }, { default: addFormats }, { readFileSync }, { join }, { resolveSpecDir }] =
    await Promise.all([
      import('ajv'),
      import('ajv-formats'),
      import('node:fs'),
      import('node:path'),
      import('../spec-path.js'),
    ])
  const schema = JSON.parse(
    readFileSync(join(resolveSpecDir(), 'openclaw-2.0.config.schema.json'), 'utf-8'),
  ) as object
  const ajv = new Ajv({ strict: false, allErrors: true })
  addFormats(ajv)
  cached = ajv.compile(schema)
  return cached
}

/** An `additionalProperties` failure is the "I don't know this key" case. */
function isUnknownKey(e: ErrorObject): boolean {
  return e.keyword === 'additionalProperties'
}

/**
 * ajv reports a JSON Pointer (`/gateway/auth/mode`). Users address config with dot paths
 * (`clawops config set gateway.auth.mode`), so report it the way they would type it.
 */
function dotPath(instancePath: string): string {
  if (!instancePath) return '(root)'
  return instancePath
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.')
}

function describe(e: ErrorObject): string {
  const where = dotPath(e.instancePath)
  if (isUnknownKey(e)) {
    const extra = (e.params as { additionalProperty?: string }).additionalProperty
    return `${where}: unknown key "${extra}"`
  }
  return `${where}: ${e.message ?? 'invalid'}`
}

export interface ValidateOpts {
  /**
   * The OpenClaw version this config is destined for. When it is newer than the release
   * the schema was captured from, unknown keys are demoted to warnings.
   */
  openclawVersion?: string
  /** The release the schema was captured from — from spec/openclaw-versions.yaml. */
  schemaCapturedFrom?: string
}

/**
 * Requirements clawops has that OpenClaw's schema does not express.
 *
 * The schema is necessary, not sufficient — SP-10 measured a config that passes both this
 * schema and `openclaw config validate`, then exits 78 on startup. `gateway.mode` is
 * optional in the schema because upstream still accepts `--allow-unconfigured`. clawops
 * stopped passing that flag in WO-40, precisely so a clobbered config fails loudly, which
 * makes the field mandatory for us.
 *
 * Checking it here means the operator learns at write time rather than from a
 * crash-looping container after the restart.
 */
function deploymentContractErrors(cfg: unknown): string[] {
  const errors: string[] = []
  if (cfg === null || typeof cfg !== 'object') return errors
  const gateway = (cfg as Record<string, unknown>)['gateway']
  const mode =
    gateway !== null && typeof gateway === 'object'
      ? (gateway as Record<string, unknown>)['mode']
      : undefined
  if (mode === undefined) {
    errors.push(
      'gateway.mode: required by clawops. OpenClaw treats it as optional only because ' +
        '--allow-unconfigured can bypass the check; clawops does not pass that flag, so a ' +
        'config without gateway.mode exits 78 with "Gateway start blocked". Set it to "local".',
    )
  }
  return errors
}

export async function validateConfig(
  cfg: unknown,
  opts: ValidateOpts = {},
): Promise<ConfigValidation> {
  const validate = await getValidator()
  const contract = deploymentContractErrors(cfg)
  if (validate(cfg)) return { errors: contract, warnings: [] }

  const { openclawVersion, schemaCapturedFrom } = opts
  const runtimeIsNewer =
    openclawVersion !== undefined &&
    schemaCapturedFrom !== undefined &&
    compareVersions(openclawVersion, schemaCapturedFrom) > 0

  const errors: string[] = [...contract]
  const warnings: string[] = []
  for (const e of validate.errors ?? []) {
    const text = describe(e)
    if (isUnknownKey(e) && runtimeIsNewer) {
      warnings.push(
        `${text} — not in the schema captured from OpenClaw ${schemaCapturedFrom}; ` +
          `you are deploying ${openclawVersion}, so this may be a newer setting clawops ` +
          `does not know about yet.`,
      )
    } else {
      errors.push(text)
    }
  }
  return { errors, warnings }
}
