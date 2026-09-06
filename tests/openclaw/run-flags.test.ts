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
import { dockerRunCmd, dockerRunCmd as gatewayDockerRunCmd } from '../../src/cli/commands/gateway.js'
import { dockerRunCmd as configDockerRunCmd } from '../../src/cli/commands/config.js'

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
  // These assert the *rendered* command rather than grepping source for literals.
  // The literal-grep version passed right up until the commands were consolidated
  // behind gatewayRunCommand(), at which point it started failing on correct code —
  // and it would equally have passed on a site that built the string wrongly.

  const rendered: Array<[string, string]> = [
    ['gateway restart / update (CLI)', gatewayDockerRunCmd('2026.7.1')],
    ['config set (CLI)', configDockerRunCmd('ghcr.io/openclaw/openclaw:2026.7.1')],
    ['cloud VM startup script', makeStartupScript({ openclawVersion: '2026.7.1', os: 'ubuntu' })],
  ]

  for (const [label, cmd] of rendered) {
    it(`${label} sets OPENCLAW_CONFIG_PATH`, () => {
      expect(cmd).toContain('OPENCLAW_CONFIG_PATH=/app/config.json')
    })

    it(`${label} makes host.docker.internal resolvable`, () => {
      expect(cmd).toContain('host.docker.internal:host-gateway')
    })

    it(`${label} passes the gateway command with its flags`, () => {
      // Omitting this is what broke `gateway restart`: the container fell back to the
      // image CMD and died with "existing config is missing gateway.mode".
      expect(cmd).toContain('gateway run')
      expect(cmd).toContain('--allow-unconfigured')
      expect(cmd).toContain('--port 18789')
    })
  }

  it('the restart paths attach the token env file when one exists', () => {
    // Conditional so a deployment created before v1.7.2, which has no env file,
    // still starts rather than failing on a missing --env-file target.
    for (const [, cmd] of rendered.slice(0, 2)) {
      expect(cmd).toContain('/home/clawops/openclaw.env')
      expect(cmd).toMatch(/\[ -s [^\]]+ \] && echo --env-file/)
    }
  })

  it('the shell template and MCP tool still carry the flags inline', () => {
    // These two build their command as text, so a source check is the only option.
    for (const path of ['src/providers/local/bootstrap.sh.tmpl', 'src/mcp/tools/cli/gateway.ts']) {
      const src = read(path)
      expect(src, path).toContain('OPENCLAW_CONFIG_PATH=/app/config.json')
      expect(src, path).toContain('host.docker.internal:host-gateway')
    }
  })

  it('no site invokes openclaw-ctl, which is not a binary in the image', () => {
    // `command -v openclaw-ctl` returns nothing in ghcr.io/openclaw/openclaw; the
    // binary is /usr/local/bin/openclaw. Every caller of the former was dead code.
    //
    // Matches the invocation, not the bare word: the files still mention
    // `openclaw-ctl` in comments explaining what used to be wrong, and that history
    // is worth keeping.
    const invocation = /docker exec[^\n'"`]*openclaw-ctl/
    for (const path of [
      'src/cli/commands/backup.ts',
      'src/mcp/tools/cli/agents.ts',
      'src/cli/commands/agents.ts',
    ]) {
      expect(read(path), path).not.toMatch(invocation)
    }
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

describe('gateway auth token', () => {
  // OpenClaw refuses a non-loopback bind without auth, and in a container it always
  // binds 0.0.0.0. The bootstrap never supplied a token, so a fresh local deployment
  // exited 78 and systemd restart-looped. Verified on 2026.7.1 before and after.
  const tmpl = read('src/providers/local/bootstrap.sh.tmpl')
  const startup = makeStartupScript({ openclawVersion: '2026.7.1', os: 'ubuntu' })

  it('the local bootstrap generates a token', () => {
    expect(tmpl).toContain('OPENCLAW_GATEWAY_TOKEN=')
    expect(tmpl).toMatch(/openssl rand -hex 32/)
  })

  it('the cloud startup script generates a token', () => {
    expect(startup).toContain('OPENCLAW_GATEWAY_TOKEN=')
    expect(startup).toMatch(/openssl rand -hex 32/)
  })

  it('passes the token by env-file, never on argv', () => {
    for (const src of [tmpl, startup]) {
      expect(src).toContain('--env-file')
      // `--token <value>` on the run command would expose it in `ps`.
      expect(src).not.toMatch(/gateway run[^\n]*--token \$/)
    }
  })

  it('restricts the env file and reuses an existing token', () => {
    for (const src of [tmpl, startup]) {
      expect(src).toContain('chmod 600')
      // -s, not -f: an empty file must be regenerated rather than reused.
      expect(src).toMatch(/if \[ ! -s "\$\{OPENCLAW_ENV_FILE\}" \]/)
    }
  })
})
