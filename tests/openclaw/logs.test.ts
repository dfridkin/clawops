import { describe, it, expect } from 'vitest'
import {
  gatewayLogsCommand, containerLogsCommand, chooseLogSource, agentAuditCommand,
  GATEWAY_LOGS_PROBE,
} from '../../src/openclaw/logs.js'

// The CLI and the MCP tool each hand-rolled `journalctl -u openclaw 2>/dev/null || docker
// logs openclaw`. Only the local provider creates that unit, so on every cloud VM the first
// command failed and the fallback answered — correct output, wrong reason, and nothing said
// which had run.

describe('gatewayLogsCommand', () => {
  it('uses the gateway log command OpenClaw 2.0 ships', () => {
    const cmd = gatewayLogsCommand({ tail: 50, follow: false })
    expect(cmd).toBe('docker exec openclaw openclaw logs --limit 50')
  })

  it('adds --follow and --json only when asked', () => {
    expect(gatewayLogsCommand({ tail: 10, follow: true, json: true }))
      .toBe('docker exec openclaw openclaw logs --limit 10 --follow --json')
  })

  it('never invokes journalctl', () => {
    expect(gatewayLogsCommand({ tail: 10, follow: true })).not.toContain('journalctl')
  })
})

describe('containerLogsCommand', () => {
  it('reads the container, with a time filter when given one', () => {
    expect(containerLogsCommand({ tail: 20, follow: false, since: '5m' }))
      .toBe("docker logs openclaw -n 20 --since '5m'")
  })

  it('quotes the time filter so a crafted value cannot break the command', () => {
    const cmd = containerLogsCommand({ tail: 20, follow: false, since: "5m'; rm -rf /; '" })
    expect(cmd.startsWith("docker logs openclaw -n 20 --since '")).toBe(true)
    expect(cmd).toContain("'\\''")
  })
})

describe('chooseLogSource', () => {
  it('reads the gateway when it is answering', () => {
    expect(chooseLogSource({ gatewayReachable: true }).source).toBe('gateway')
  })

  it('falls back to the container when the gateway is not answering', () => {
    // `openclaw logs` goes over RPC, and a gateway that is down is exactly when logs matter.
    const choice = chooseLogSource({ gatewayReachable: false })
    expect(choice.source).toBe('container')
    expect(choice.reason).toMatch(/not answering/)
  })

  it('uses the container for a time filter, even with the gateway up', () => {
    // `openclaw logs` has no --since. Serving it from the gateway would quietly ignore the
    // window the caller asked for and show them the wrong one.
    const choice = chooseLogSource({ since: '5m', gatewayReachable: true })
    expect(choice.source).toBe('container')
    expect(choice.reason).toMatch(/--since/)
  })

  it('always explains itself', () => {
    for (const opts of [
      { gatewayReachable: true },
      { gatewayReachable: false },
      { since: '1h', gatewayReachable: true },
    ]) {
      expect(chooseLogSource(opts).reason.length).toBeGreaterThan(0)
    }
  })
})

describe('GATEWAY_LOGS_PROBE', () => {
  it('is cheap, silent, and answers ok or no', () => {
    // A stream cannot be retried once it starts emitting, so the question is asked first.
    expect(GATEWAY_LOGS_PROBE).toContain('--limit 1')
    expect(GATEWAY_LOGS_PROBE).toContain('>/dev/null')
    expect(GATEWAY_LOGS_PROBE).toContain('echo ok')
    expect(GATEWAY_LOGS_PROBE).toContain('echo no')
  })
})

describe('agentAuditCommand', () => {
  it('queries the audit log, which is where agent-scoped records live in 2.0', () => {
    // OpenClaw 2.0 removed `agents logs`. `openclaw logs` is gateway-wide and its envelope
    // carries no agent key, so filtering it would mean substring-matching a message field.
    const cmd = agentAuditCommand({ agentId: 'claude', limit: 50 })
    expect(cmd).toContain('openclaw audit')
    expect(cmd).toContain("--agent 'claude'")
    expect(cmd).toContain('--kind agent_run')
    expect(cmd).toContain('--json')
    expect(cmd).toContain('--limit 50')
    expect(cmd).not.toContain('agents logs')
  })

  it('continues from a cursor when given one', () => {
    expect(agentAuditCommand({ agentId: 'a', limit: 5, cursor: 'zz' })).toContain("--cursor 'zz'")
  })

  it('omits the cursor when there is none', () => {
    expect(agentAuditCommand({ agentId: 'a', limit: 5 })).not.toContain('--cursor')
  })

  it('quotes the agent id', () => {
    const cmd = agentAuditCommand({ agentId: "a'; rm -rf /; '", limit: 5 })
    expect(cmd).toContain("'\\''")
  })
})
