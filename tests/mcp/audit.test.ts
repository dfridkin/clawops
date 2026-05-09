import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// We re-import audit module dynamically after resetting mocks; we need to avoid
// module cache pollution between tests by using vi.resetModules() in afterEach.

let tempDir: string

vi.mock('../../src/config/store.js', () => ({
  getConfig: vi.fn(() => null),
  getConfigDir: vi.fn(() => ''),
}))

beforeEach(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'clawops-audit-test-'))
  const store = await import('../../src/config/store.js')
  vi.mocked(store.getConfigDir).mockReturnValue(tempDir)
  vi.mocked(store.getConfig).mockReturnValue(null)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('sanitize', () => {
  it('redacts token fields', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ accessToken: 'abc123', stackName: 'prod' })
    expect(result['accessToken']).toBe('[REDACTED]')
    expect(result['stackName']).toBe('prod')
  })

  it('redacts secret fields', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ apiSecret: 'shhh', region: 'us-east-1' })
    expect(result['apiSecret']).toBe('[REDACTED]')
    expect(result['region']).toBe('us-east-1')
  })

  it('redacts password fields', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ password: 'hunter2' })
    expect(result['password']).toBe('[REDACTED]')
  })

  it('redacts connectionString fields', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ connectionString: 'postgres://user:pass@host/db' })
    expect(result['connectionString']).toBe('[REDACTED]')
  })

  it('redacts Authorization fields', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ Authorization: 'Bearer token' })
    expect(result['Authorization']).toBe('[REDACTED]')
  })

  it('exempts keyName and keyPath', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ keyName: 'my-key', keyPath: '/home/user/.ssh/id_rsa' })
    expect(result['keyName']).toBe('my-key')
    expect(result['keyPath']).toBe('/home/user/.ssh/id_rsa')
  })

  it('replaces ARNs in string values', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ resource: 'arn:aws:iam::123456789012:role/MyRole' })
    expect(result['resource']).toContain('arn:aws:***')
    expect(result['resource']).not.toContain('123456789012')
  })

  it('recursively sanitizes nested objects', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ nested: { secretKey: 'val', name: 'foo' } })
    const nested = result['nested'] as Record<string, unknown>
    expect(nested['secretKey']).toBe('[REDACTED]')
    expect(nested['name']).toBe('foo')
  })

  it('passes through non-sensitive primitive fields', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ count: 42, active: true, tags: ['a', 'b'] })
    expect(result['count']).toBe(42)
    expect(result['active']).toBe(true)
    expect(result['tags']).toEqual(['a', 'b'])
  })

  it('redacts key fields (apiKey, awsKey)', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ apiKey: 'sk-abc', awsKey: 'AKIA123', region: 'us-east-1' })
    expect(result['apiKey']).toBe('[REDACTED]')
    expect(result['awsKey']).toBe('[REDACTED]')
    expect(result['region']).toBe('us-east-1')
  })

  it('exempts keyName and keyPath even though they contain "key"', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ keyName: 'my-pair', keyPath: '/home/.ssh/id_rsa' })
    expect(result['keyName']).toBe('my-pair')
    expect(result['keyPath']).toBe('/home/.ssh/id_rsa')
  })

  it('sanitizes objects nested inside arrays', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({
      bindings: [
        { name: 'agent-a', botToken: 'tok123' },
        { name: 'agent-b', botToken: 'tok456' },
      ],
    })
    const bindings = result['bindings'] as Array<Record<string, unknown>>
    expect(bindings[0]?.['name']).toBe('agent-a')
    expect(bindings[0]?.['botToken']).toBe('[REDACTED]')
    expect(bindings[1]?.['botToken']).toBe('[REDACTED]')
  })

  it('passes through scalar array elements unchanged', async () => {
    const { sanitize } = await import('../../src/mcp/audit.js')
    const result = sanitize({ ids: ['a', 'b', 'c'] })
    expect(result['ids']).toEqual(['a', 'b', 'c'])
  })
})

describe('auditLog', () => {
  it('writes JSON line to stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { auditLog, getSessionId } = await import('../../src/mcp/audit.js')
    auditLog({
      ts: '2025-01-01T00:00:00Z',
      sessionId: getSessionId(),
      tool: 'clawops_status',
      args: { stackName: 'prod' },
      durationMs: 12,
      result: 'ok',
    })
    expect(stderrSpy).toHaveBeenCalled()
    const written = String(stderrSpy.mock.calls[0]?.[0] ?? '')
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect(parsed['tool']).toBe('clawops_status')
    expect(parsed['result']).toBe('ok')
    stderrSpy.mockRestore()
  })

  it('appends to disk log file', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { auditLog, getSessionId } = await import('../../src/mcp/audit.js')
    const logPath = path.join(tempDir, 'mcp-audit.log')
    auditLog({
      ts: '2025-01-01T00:00:00Z',
      sessionId: getSessionId(),
      tool: 'clawops_stacks_list',
      args: {},
      durationMs: 5,
      result: 'ok',
    })
    expect(existsSync(logPath)).toBe(true)
    const contents = readFileSync(logPath, 'utf-8')
    expect(contents).toContain('clawops_stacks_list')
    vi.restoreAllMocks()
  })
})

describe('withAudit', () => {
  it('returns handler result on success', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { withAudit } = await import('../../src/mcp/audit.js')
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const wrapped = withAudit('clawops_status', handler)
    const result = await wrapped({ stackName: 'prod' })
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ok' })
    vi.restoreAllMocks()
  })

  it('re-throws errors after logging', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { withAudit } = await import('../../src/mcp/audit.js')
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    const wrapped = withAudit('clawops_up', handler)
    await expect(wrapped({})).rejects.toThrow('boom')
    vi.restoreAllMocks()
  })

  it('records durationMs >= 0', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { withAudit } = await import('../../src/mcp/audit.js')
    const handler = vi.fn().mockResolvedValue({ content: [] })
    const wrapped = withAudit('clawops_status', handler)
    await wrapped({})
    const written = String(stderrSpy.mock.calls[0]?.[0] ?? '')
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect(typeof parsed['durationMs']).toBe('number')
    expect(parsed['durationMs'] as number).toBeGreaterThanOrEqual(0)
    stderrSpy.mockRestore()
  })
})

describe('getSessionId', () => {
  it('returns same UUID for repeated calls', async () => {
    const { getSessionId } = await import('../../src/mcp/audit.js')
    const id1 = getSessionId()
    const id2 = getSessionId()
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)
  })
})
