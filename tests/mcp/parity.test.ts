// Every CLI command is reachable through MCP, or is listed here as deliberately not.
//
// clawops is a CLI and an MCP server over one implementation, and the MCP half is how an agent
// uses it. Adding a command without a tool makes the product quietly worse for half its users:
// 2.1 shipped `harden --tailscale` with no tool at all, so the feature the release was named
// for could not be reached by an agent, and `clawops_doctor` reported hardening drift that
// nothing could fix.
//
// This test does not demand parity — it demands a decision. A new command either gets a tool or
// gets a line in NO_TOOL saying why not, which is a line someone has to write on purpose.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'
import { TOOL_NAMES } from '../../src/mcp/tools/registry.js'

const ROOT = path.resolve(__dirname, '../..')

/** Commands with no MCP tool, and the reason each one is not a gap. */
const NO_TOOL: Record<string, string> = {
  mcp: 'Starts and wires the MCP server itself. A tool for it would be recursive.',
  help: 'tools/list is the MCP equivalent, and every tool carries its own description.',
  setup: 'An interactive wizard built on prompts. clawops_workflow_deploy_app is the agent-shaped equivalent.',
  monitor: 'Covered by clawops_monitor, which returns a snapshot instead of holding a TUI open.',
  down: 'Same operation as destroy, which clawops_destroy covers.',
  tunnel: 'A long-lived local process, not a request and a response.',
  bug: 'Opens a pre-filled GitHub issue in a browser.',
  // Tracked as gaps: see docs/limitations.md. Each needs a tool, not an excuse.
  init: 'GAP (2.2): an agent cannot bootstrap a stack from zero.',
  ssh: 'GAP (2.2): no tool runs an arbitrary remote command.',
  secret: 'GAP (2.2): secret list and audit are read-only and safe to expose; set and rotate carry values (R6).',
  backup: 'GAP (2.2): no pre-upgrade safety step through MCP.',
  migrate: 'GAP (2.2): 1.x to 2.0 migration is CLI-only.',
  gateway: 'PARTIAL: clawops_gateway_restart exists; status and update do not.',
  agents: 'PARTIAL: clawops_agents_list exists; per-agent logs do not.',
  stacks: 'PARTIAL: clawops_stacks_list exists; delete does not.',
  logs: 'Covered by clawops_logs_tail. Following a stream is not tool-shaped.',
  config: 'Covered by clawops_config_get/set/unset/validate.',
  doctor: 'Covered by clawops_doctor.',
  status: 'Covered by clawops_status.',
  apply: 'Covered by clawops_apply.',
  plan: 'Covered by clawops_plan.',
  up: 'Covered by clawops_up.',
  destroy: 'Covered by clawops_destroy.',
  harden: 'Covered by clawops_harden.',
}

/** The registered subcommand names, read from the source rather than a second list. */
function cliCommands(): string[] {
  const src = readFileSync(path.join(ROOT, 'src/cli/index.ts'), 'utf-8')
  const block = src.slice(src.indexOf('subCommands: {'), src.indexOf('\n  },', src.indexOf('subCommands: {')))
  return [...block.matchAll(/^\s{4}([a-z][a-zA-Z0-9]*):/gm)].map((m) => m[1] as string)
}

describe('every CLI command is reachable through MCP, or is deliberately not', () => {
  it('reads the command list from the CLI itself', () => {
    const commands = cliCommands()
    expect(commands).toContain('harden')
    expect(commands.length).toBeGreaterThan(20)
  })

  it('accounts for every command', () => {
    const unaccounted = cliCommands().filter((c) => NO_TOOL[c] === undefined)
    expect(
      unaccounted,
      `New CLI command(s) with no MCP tool and no stated reason: ${unaccounted.join(', ')}. ` +
        'Add a tool to spec/mcp-tools.yaml, or add a line to NO_TOOL saying why an agent does not need one.',
    ).toEqual([])
  })

  it('names a tool that exists wherever it claims one covers the command', () => {
    const missing: string[] = []
    for (const [command, reason] of Object.entries(NO_TOOL)) {
      for (const named of reason.match(/clawops_[a-z_]+/g) ?? []) {
        if (!TOOL_NAMES.includes(named)) missing.push(`${command} → ${named}`)
      }
    }
    expect(missing, `NO_TOOL names tools that do not exist: ${missing.join(', ')}`).toEqual([])
  })

  it('has no tool in the spec that the registry does not serve', () => {
    const spec = load(readFileSync(path.join(ROOT, 'spec/mcp-tools.yaml'), 'utf-8')) as {
      tools: Array<{ name: string }>
    }
    expect(spec.tools.map((t) => t.name).filter((n) => !TOOL_NAMES.includes(n))).toEqual([])
  })

  /*
   * Tool descriptions tell an agent which tool to use instead. Naming one that does not exist
   * sends it to a tool-not-found at the moment it was trying to do the right thing. Four of
   * these shipped: clawops_ssh, clawops_agents_logs, clawops_gateway_update, clawops_gateway_stop.
   */
  it('never points an agent at a tool that does not exist', () => {
    const spec = load(readFileSync(path.join(ROOT, 'spec/mcp-tools.yaml'), 'utf-8')) as {
      tools: Array<{ name: string; description: string }>
    }
    const dangling: string[] = []
    for (const tool of spec.tools) {
      for (const named of tool.description.match(/clawops_[a-z_]+/g) ?? []) {
        if (!TOOL_NAMES.includes(named)) dangling.push(`${tool.name} names ${named}`)
      }
    }
    expect(dangling, dangling.join('; ')).toEqual([])
  })
})
