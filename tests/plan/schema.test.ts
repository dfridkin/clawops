import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'

const __dirname = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(__dirname, '../../spec/deploy-plan.schema.json')

function makeAjv() {
  const ajv = new Ajv2020({ strict: false })
  addFormats(ajv)
  return ajv
}

function loadSchema() {
  return JSON.parse(readFileSync(schemaPath, 'utf-8')) as object
}

describe('deploy-plan.schema.json', () => {
  it('compiles without error', () => {
    const ajv = makeAjv()
    const schema = loadSchema()
    const validate = ajv.compile(schema)
    expect(typeof validate).toBe('function')
  })

  it('validates a minimal valid plan', () => {
    const ajv = makeAjv()
    const validate = ajv.compile(loadSchema())

    const plan = {
      apiVersion: 'clawops.dev/v1',
      kind: 'DeployPlan',
      metadata: {
        name: 'test-stack',
        generatedAt: new Date().toISOString(),
      },
      spec: {
        provider: 'aws',
        stackName: 'test-stack',
        instanceType: 't3.small',
        openclaw: { version: 'stable' },
        network: {
          allowedSshCidrs: [],
          allowedGatewayCidrs: [],
        },
      },
    }

    const valid = validate(plan)
    expect(valid).toBe(true)
    expect(validate.errors).toBeNull()
  })

  it('rejects a plan with wrong apiVersion', () => {
    const ajv = makeAjv()
    const validate = ajv.compile(loadSchema())

    const plan = {
      apiVersion: 'wrong/v1',
      kind: 'DeployPlan',
      metadata: { name: 'test', generatedAt: new Date().toISOString() },
      spec: {
        provider: 'aws',
        stackName: 'test',
        instanceType: 't3.small',
        openclaw: { version: 'stable' },
        network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
      },
    }

    const valid = validate(plan)
    expect(valid).toBe(false)
    expect(validate.errors).not.toBeNull()
  })

  it('rejects a plan with an invalid provider', () => {
    const ajv = makeAjv()
    const validate = ajv.compile(loadSchema())

    const plan = {
      apiVersion: 'clawops.dev/v1',
      kind: 'DeployPlan',
      metadata: { name: 'test', generatedAt: new Date().toISOString() },
      spec: {
        provider: 'digitalocean', // not in enum
        stackName: 'test',
        instanceType: 's-1vcpu-1gb',
        openclaw: { version: 'stable' },
        network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
      },
    }

    const valid = validate(plan)
    expect(valid).toBe(false)
  })
})
