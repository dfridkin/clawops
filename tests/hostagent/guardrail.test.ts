// The operator-only guardrail. A config that passes, then each condition broken alone: a check
// that is satisfied by something being absent cannot pass this, because the passing config has
// all of it present and each case removes or changes exactly one thing.

import { describe, it, expect } from 'vitest'
import { checkGuardrail, containerReach, CLAWOPS_TOOL_PATTERN } from '../../src/hostagent/guardrail.js'

const SUBJECT = { agentId: 'ops', operators: ['telegram:12345'] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test configs are edited freely to break one condition
function passing(): Record<string, any> {
  return {
    agents: {
      entries: {
        main: { default: true, tools: { deny: [CLAWOPS_TOOL_PATTERN] } },
        ops: {},
        helper: { tools: { deny: ['exec', CLAWOPS_TOOL_PATTERN] } },
      },
    },
    bindings: [
      { agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } },
      { agentId: 'helper', match: { channel: 'slack' } },
    ],
    channels: { telegram: { dmPolicy: 'pairing' }, slack: { dmPolicy: 'open' } },
    tools: { agentToAgent: { enabled: false }, sessions: { visibility: 'agent' } },
  }
}

function failuresOf(cfg: Record<string, unknown>): string[] {
  const r = checkGuardrail(cfg, SUBJECT)
  return r.ok ? [] : r.failures
}

describe('the operator-only guardrail', () => {
  it('passes a config where only the operator reaches the agent', () => {
    expect(checkGuardrail(passing(), SUBJECT)).toEqual({ ok: true })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test configs are edited freely to break one condition
  const cases: Array<[string, (c: Record<string, any>) => void, RegExp]> = [
    ['the agent does not exist', (c) => { delete c.agents.entries.ops }, /not in agents.entries/],
    ['the agent is marked default', (c) => { c.agents.entries.main.default = false; c.agents.entries.ops.default = true }, /default agent/],
    ['the agent is the only one', (c) => { c.agents.entries = { ops: {} } }, /default agent/],
    ['the agent is the system agent', (c) => { c.agents.defaults = { systemAgent: { agentId: 'ops' } } }, /systemAgent.agentId sends traffic/],
    ['a Telegram topic routes to the agent', (c) => {
      c.channels.telegram.groups = { '-100': { topics: { '7': { agentId: 'ops' } } } }
    }, /channels.telegram.groups.-100.topics.7.agentId/],
    ['a webhook mapping routes to the agent', (c) => { c.hooks = { mappings: [{ match: { path: '/x' }, agentId: 'OPS' }] } }, /hooks.mappings\[0\].agentId/],
    ['ACP defaults to the agent', (c) => { c.acp = { defaultAgent: 'ops' } }, /acp.defaultAgent/],
    ['a binding names the operator by wildcard', (c) => { c.bindings[0].match.peer.id = '*' }, /someone other than the operator/],
    ['nothing binds the agent', (c) => { c.bindings = c.bindings.slice(1) }, /No binding routes the operator/],
    ['a binding routes a whole channel', (c) => { c.bindings.push({ agentId: 'ops', match: { channel: 'telegram' } }) }, /whole channel/],
    ['a binding routes a group', (c) => {
      c.bindings.push({ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'group', id: '-100' } } })
    }, /group conversation/],
    ['a binding routes someone else', (c) => { c.bindings[0].match.peer.id = '99999' }, /someone other than the operator/],
    ['an ACP binding routes to the agent', (c) => {
      c.bindings.push({ type: 'acp', agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } })
    }, /ACP/],
    ['the channel lets anyone DM', (c) => { c.channels.telegram.dmPolicy = 'open' }, /dmPolicy is "open"/],
    ['the channel DM policy is left to its default', (c) => { delete c.channels.telegram.dmPolicy }, /dmPolicy is not set/],
    ['an account on the channel lets anyone DM', (c) => {
      c.bindings[0].match.accountId = 'work'
      c.channels.telegram.accounts = { work: { dmPolicy: 'open' } }
    }, /accounts.work.dmPolicy is "open"/],
    ['agent-to-agent access is on', (c) => { delete c.tools.agentToAgent }, /Agent-to-agent/],
    ['agent-to-agent allows every agent', (c) => { c.tools.agentToAgent = { enabled: true, allow: ['*'] } }, /Agent-to-agent/],
    ['session visibility is the default', (c) => { delete c.tools.sessions }, /visibility is not set/],
    ['session visibility is tree', (c) => { c.tools.sessions.visibility = 'tree' }, /visibility is "tree"/],
    ['another agent lacks the deny', (c) => { delete c.agents.entries.helper.tools }, /"helper" can call clawops/],
    ['another agent denies only the tools, not the bridge', (c) => {
      c.agents.entries.helper.tools.deny = ['clawops__clawops_*']
    }, /"helper" can call clawops/],
    ['the default agent lacks the deny', (c) => { c.agents.entries.main.tools.deny = [] }, /"main" can call clawops/],
    ['a gateway-wide deny blocks the host agent too', (c) => { c.tools.deny = [CLAWOPS_TOOL_PATTERN] }, /tools.deny blocks/],
  ]

  it.each(cases)('refuses when %s', (_name, breakIt, expected) => {
    const cfg = passing()
    breakIt(cfg)
    const failures = failuresOf(cfg)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.join('\n')).toMatch(expected)
  })

  it('accepts an agent-to-agent allow list that leaves the agent out', () => {
    const cfg = passing()
    cfg.tools.agentToAgent = { enabled: true, allow: ['main', 'help*'] }
    expect(checkGuardrail(cfg, SUBJECT)).toEqual({ ok: true })
  })

  it('does not treat the first agent as default when none is marked', () => {
    const cfg = passing()
    delete cfg.agents.entries.main.default
    cfg.agents.entries = { ops: {}, ...cfg.agents.entries }
    expect(checkGuardrail(cfg, SUBJECT)).toEqual({ ok: true })
  })

  it('accepts a legacy dm peer kind, and a disabled DM policy', () => {
    const cfg = passing()
    cfg.bindings[0].match.peer.kind = 'dm'
    cfg.channels.telegram.dmPolicy = 'allowlist'
    expect(checkGuardrail(cfg, SUBJECT)).toEqual({ ok: true })
  })

  it('refuses an empty config, rather than passing it for having nothing wrong', () => {
    expect(failuresOf({}).length).toBeGreaterThanOrEqual(3)
  })
})

describe('other agents inside the gateway container (condition 6)', () => {
  /** The passing config, with every other agent kept out of the container. */
  function contained() {
    const cfg = passing()
    cfg.agents.entries.main.tools.profile = 'messaging'
    cfg.agents.entries.helper.tools.allow = ['message', 'sessions_list']
    return cfg
  }
  const STRICT = { ...SUBJECT, strict: true }

  it('is reported but not refused by default, since most main agents have these tools', () => {
    const cfg = passing()
    expect(checkGuardrail(cfg, SUBJECT)).toEqual({ ok: true })
    const reach = containerReach(cfg, 'ops')
    expect(reach.join('\n')).toMatch(/"main" can run commands, read and write files, change the gateway configuration/)
    expect(reach.join('\n')).toMatch(/"helper" can .*\(process, terminal,/)
    expect(reach.join('\n')).not.toMatch(/"ops"/)
  })

  it('refuses under --strict', () => {
    const r = checkGuardrail(passing(), STRICT)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.failures.join('\n')).toMatch(/clawops token/)
  })

  it('passes --strict when every other agent is contained', () => {
    expect(containerReach(contained(), 'ops')).toEqual([])
    expect(checkGuardrail(contained(), STRICT)).toEqual({ ok: true })
  })

  it('counts a deny of everything, and the minimal profile, as contained', () => {
    const cfg = contained()
    cfg.agents.entries.main.tools = { deny: ['*'] }
    cfg.agents.entries.helper.tools = { profile: 'minimal', deny: [CLAWOPS_TOOL_PATTERN] }
    expect(containerReach(cfg, 'ops')).toEqual([])
  })

  it('applies a gateway-wide profile to an agent that sets none', () => {
    const cfg = contained()
    delete cfg.agents.entries.main.tools.profile
    cfg.tools.profile = 'messaging'
    expect(containerReach(cfg, 'ops')).toEqual([])
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test configs are edited freely to break one condition
  const cases: Array<[string, (c: Record<string, any>) => void, RegExp]> = [
    ['an agent adds exec back with alsoAllow', (c) => { c.agents.entries.main.tools.alsoAllow = ['exec'] }, /"main" can run commands in the gateway container \(exec\)/],
    ['the gateway adds a file tool for every agent', (c) => { c.tools.alsoAllow = ['file_fetch'] }, /"main" can read and write files in the gateway container \(file_fetch\)/],
    ['an agent uses the coding profile', (c) => { c.agents.entries.main.tools.profile = 'coding' }, /"main" can run commands/],
    ['an allow list grants everything', (c) => { c.agents.entries.helper.tools.allow = ['*'] }, /"helper" can run commands/],
    ['an allow list names a group nobody measured', (c) => { c.agents.entries.helper.tools.allow = ['group:plugins'] }, /"helper" can run commands/],
    ['an allow list names the gateway tool', (c) => { c.agents.entries.helper.tools.allow = ['message', 'gateway'] }, /"helper" can change the gateway configuration in the gateway container \(gateway\)/],
    ['denying the runtime and fs groups leaves the plugin file tools', (c) => {
      c.agents.entries.main.tools = { deny: [CLAWOPS_TOOL_PATTERN, 'group:runtime', 'group:fs'] }
    }, /"main" can run commands, read and write files, change the gateway configuration in the gateway container \(terminal, file_fetch, file_write, dir_list, dir_fetch, gateway\)/],
    ['a per-provider override adds exec back', (c) => {
      c.agents.entries.main.tools.byProvider = { openai: { alsoAllow: ['exec'] } }
    }, /"main" can run commands in the gateway container \(exec\)/],
    ['a per-sender override allows a file tool', (c) => {
      c.tools.toolsBySender = { 'telegram:999': { allow: ['read'] } }
    }, /"main" can read and write files in the gateway container \(read\)/],
    ['a new agent arrives with no tool settings', (c) => { c.agents.entries.newcomer = { tools: { deny: [CLAWOPS_TOOL_PATTERN] } } }, /"newcomer" can run commands/],
  ]

  it.each(cases)('reports, and refuses under --strict, when %s', (_name, breakIt, expected) => {
    const cfg = contained()
    breakIt(cfg)
    expect(containerReach(cfg, 'ops').join('\n')).toMatch(expected)
    const r = checkGuardrail(cfg, STRICT)
    expect(r.ok).toBe(false)
    expect(checkGuardrail(cfg, SUBJECT)).toEqual({ ok: true })
  })
})
