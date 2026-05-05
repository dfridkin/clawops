// Maker plan validation via ajv against spec/deploy-plan.schema.json.

import Ajv from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import type { DeployPlan } from './generate'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _validate: ReturnType<Ajv['compile']> | undefined

function getValidator(): ReturnType<Ajv['compile']> {
  if (_validate) return _validate
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  const schema = JSON.parse(
    readFileSync(join(__dirname, '../../spec/deploy-plan.schema.json'), 'utf-8'),
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
