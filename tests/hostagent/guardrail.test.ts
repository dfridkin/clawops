// The operator-only guardrail. A config that passes, then each condition broken alone: a check
// that is satisfied by something being absent cannot pass this, because the passing config has
// all of it present and each case removes or changes exactly one thing.

import { describe, it, expect } from 'vitest'
import { checkGuardrail, CLAWOPS_TOOL_PATTERN } from '../../src/hostagent/guardrail.js'

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
