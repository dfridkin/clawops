import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { GATEWAY_PORT } from '../../src/openclaw/run-flags.js'

/**
 * The gateway port had eleven definitions.
 *
 * `const GATEWAY_PORT = 18789` was redeclared in six TypeScript files, written literally
 * into two shell templates and two default-config JSON strings, and named in a firewall
 * module and an SG audit list. Changing the port meant finding all of them, and missing one
 * produced a deployment that half-worked: a container publishing one port, a gateway
 * listening on another, a firewall opening a third.
 *
 * This asserts there is one definition and the rest derive from it.
 */
const SRC = path.join(process.cwd(), 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tmpl|sh)$/.test(entry) ? [full] : []
  })
}

/** Comments explain the port; they do not define it. Only code counts. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|#).*$/gm, '')
}

describe('the gateway port has one definition', () => {
  const offenders = sourceFiles(SRC)
    .map((file) => ({ file: path.relative(process.cwd(), file), text: stripComments(readFileSync(file, 'utf-8')) }))
    .filter(({ file }) => file !== path.join('src', 'openclaw', 'run-flags.ts'))
    .filter(({ text }) => text.includes(String(GATEWAY_PORT)))

  it('is declared only in run-flags.ts', () => {
    expect(offenders.map((o) => o.file)).toEqual([])
  })

  it('is the value the rest of the codebase imports', () => {
    const runFlags = readFileSync(path.join(SRC, 'openclaw', 'run-flags.ts'), 'utf-8')
    expect(runFlags).toContain(`export const GATEWAY_PORT = ${GATEWAY_PORT}`)
  })

  it('is what the plan schema documents as the default', async () => {
    const schema = JSON.parse(
      readFileSync(path.join(process.cwd(), 'spec/deploy-plan.schema.json'), 'utf-8'),
    ) as { properties: Record<string, never> }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const network = (schema as any).properties.spec.properties.network.properties
    expect(network.gatewayPort.default).toBe(GATEWAY_PORT)
  })

  it('is what the version spec records for the runtime', () => {
    const yamlText = readFileSync(path.join(process.cwd(), 'spec/openclaw-versions.yaml'), 'utf-8')
    expect(yamlText).toContain(`gatewayPort: ${GATEWAY_PORT}`)
  })
})
