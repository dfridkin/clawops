// Config delivery (v1.7.2). Every `docker run` site must tell OpenClaw where its
// config is; without OPENCLAW_CONFIG_PATH the mounted file is read by nothing.
// Verified on 2026.7.1 and 2026.8.1 — see docs/spikes/SP-01-container-profile.md.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIG_PATH_ENV,
  ADD_HOST_FLAG,
  PORT_PIN,
  COMMON_RUN_FLAGS,
  GATEWAY_PORT,
} from '../../src/openclaw/run-flags.js'
import { normaliseGatewayPort } from '../../src/plan/remote-config.js'
import { makeStartupScript } from '../../src/providers/startup.js'
import { dockerRunCmd } from '../../src/cli/commands/gateway.js'

const ROOT = join(__dirname, '../..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('run flags', () => {
  it('points OpenClaw at the mounted config', () => {
    expect(CONFIG_PATH_ENV).toBe('-e OPENCLAW_CONFIG_PATH=/app/config.json')
  })

  it('makes host.docker.internal resolvable for host-local model runtimes', () => {
    expect(ADD_HOST_FLAG).toBe('--add-host=host.docker.internal:host-gateway')
  })

  it('pins the listener to the published port', () => {
    expect(PORT_PIN).toBe(`--port ${GATEWAY_PORT}`)
  })

  it('bundles the flags every config-mounting site needs', () => {
    expect(COMMON_RUN_FLAGS).toContain('OPENCLAW_CONFIG_PATH')
    expect(COMMON_RUN_FLAGS).toContain('add-host')
  })
})

describe('every run site delivers the config', () => {
  // A site that mounts /app/config.json but omits OPENCLAW_CONFIG_PATH silently
  // ignores everything clawops writes. Keeping this list explicit is the point:
  // it fails when a new run site is added without the flag.
  const sites: Array<[string, string]> = [
    ['cloud VM startup script', 'src/providers/startup.ts'],
    ['local bootstrap template', 'src/providers/local/bootstrap.sh.tmpl'],
    ['gateway restart (CLI)', 'src/cli/commands/gateway.ts'],
    ['config apply (CLI)', 'src/cli/commands/config.ts'],
    ['gateway restart (MCP)', 'src/mcp/tools/cli/gateway.ts'],
  ]

  for (const [label, path] of sites) {
    it(`${label} sets OPENCLAW_CONFIG_PATH`, () => {
      const src = read(path)
      expect(src).toContain('OPENCLAW_CONFIG_PATH=/app/config.json')
    })

    it(`${label} makes host.docker.internal resolvable`, () => {
      expect(read(path)).toContain('host.docker.internal:host-gateway')
    })
  }

  it('remote-config restart uses the shared flags rather than its own literals', () => {
    const src = read('src/plan/remote-config.ts')
    expect(src).toContain('COMMON_RUN_FLAGS')
    expect(src).toContain('PORT_PIN')
  })

  it('MCP restart mounts the config, as the CLI path does', () => {
    // It previously ran `docker run … ${image}` with no -v at all, silently
    // reverting the gateway to defaults on every MCP-initiated restart.
    expect(read('src/mcp/tools/cli/gateway.ts')).toContain('/app/config.json:ro')
  })
})

describe('rendered commands', () => {
  it('the cloud startup script pins the port', () => {
    const script = makeStartupScript({ openclawVersion: '2026.7.1', os: 'ubuntu' })
    expect(script).toContain('--port 18789')
    expect(script).toContain('OPENCLAW_CONFIG_PATH=/app/config.json')
    expect(script).toContain('host.docker.internal:host-gateway')
  })

  it('the CLI restart command carries the flags', () => {
    const cmd = dockerRunCmd('2026.7.1')
    expect(cmd).toContain('OPENCLAW_CONFIG_PATH=/app/config.json')
    expect(cmd).toContain('host.docker.internal:host-gateway')
    expect(cmd).toContain('/app/config.json:ro')
  })
})

describe('normaliseGatewayPort', () => {
  it('rewrites a divergent port and reports the old value', () => {
    const cfg = { gateway: { port: 19999 } }
    expect(normaliseGatewayPort(cfg)).toBe(19999)
    expect((cfg.gateway as { port: number }).port).toBe(GATEWAY_PORT)
  })

  it('leaves a matching port alone and reports no change', () => {
    const cfg = { gateway: { port: GATEWAY_PORT } }
    expect(normaliseGatewayPort(cfg)).toBeUndefined()
    expect((cfg.gateway as { port: number }).port).toBe(GATEWAY_PORT)
  })

  it('fills in a missing port without reporting a change', () => {
    const cfg: Record<string, unknown> = { gateway: {} }
    expect(normaliseGatewayPort(cfg)).toBeUndefined()
    expect((cfg['gateway'] as { port: number }).port).toBe(GATEWAY_PORT)
  })

  it('ignores configs with no gateway block', () => {
    expect(normaliseGatewayPort({})).toBeUndefined()
    expect(normaliseGatewayPort({ gateway: null })).toBeUndefined()
    expect(normaliseGatewayPort({ gateway: [] })).toBeUndefined()
  })
})
