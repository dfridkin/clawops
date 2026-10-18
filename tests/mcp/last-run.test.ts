import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { lastRunPath, trimForMcp } from '../../src/mcp/tools/_trim.js'
import { registerResources } from '../../src/mcp/resources.js'

// The last-run resource joins the stack name from its URI into a path. Any MCP client writes
// that URI, so a name that is not a stack name must never reach the filesystem.

let home: string
const prev = process.env['CLAWOPS_HOME']

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawops-last-run-'))
  process.env['CLAWOPS_HOME'] = path.join(home, 'clawops')
})
afterEach(() => {
  if (prev === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = prev
  rmSync(home, { recursive: true, force: true })
})

type Handler = (uri: URL, vars: { name: string | string[] }) => Promise<{ contents: { text: string }[] }>

function lastRunHandler(): Handler {
  const handlers: Record<string, Handler> = {}
  const server = {
    registerResource: (name: string, _t: unknown, _m: unknown, h: Handler) => { handlers[name] = h },
  } as unknown as McpServer
  registerResources(server)
  return handlers['stack-last-run']!
}

describe('lastRunPath', () => {
  it('accepts Pulumi stack names', () => {
    for (const n of ['prod', 'my-stack', 'org_stack.2', 'A1']) {
      expect(lastRunPath(n)).toBe(path.join(home, 'clawops', 'state', `${n}.last-run.json`))
    }
  })

  it('refuses anything with a separator or a leading dot', () => {
    for (const n of ['../x', '../../secret', 'a/b', 'a\\b', '.hidden', '..', '', 'a b']) {
      expect(lastRunPath(n)).toBeUndefined()
    }
  })
})

describe('trimForMcp', () => {
  it('writes nothing outside the state directory for a bad name', () => {
    trimForMcp('out', '../escaped')
    expect(existsSync(path.join(home, 'clawops', 'escaped.last-run.json'))).toBe(false)
  })

  it('still persists for a good name', () => {
    trimForMcp('out', 'prod')
    expect(existsSync(path.join(home, 'clawops', 'state', 'prod.last-run.json'))).toBe(true)
  })
})

describe('clawops://stacks/{name}/last-run', () => {
  it('reads a stack\'s output', async () => {
    trimForMcp('hello from prod', 'prod')
    const r = await lastRunHandler()(new URL('clawops://stacks/prod/last-run'), { name: 'prod' })
    expect(r.contents[0]!.text).toBe('hello from prod')
  })

  it('does not read a file outside the state directory', async () => {
    // A file the old join would have reached: state/../outside.last-run.json
    mkdirSync(path.join(home, 'clawops'), { recursive: true })
    writeFileSync(path.join(home, 'clawops', 'outside.last-run.json'), JSON.stringify({ output: 'leaked' }))
    const r = await lastRunHandler()(new URL('clawops://stacks/x/last-run'), { name: '../outside' })
    expect(r.contents[0]!.text).not.toContain('leaked')
    expect(r.contents[0]!.text).toContain('No last-run output found')
  })
})
