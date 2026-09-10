// The runtime contract. These assert *rendered commands*, not the presence of constants
// in a source file — the six run sites drifted for years while a source-grep suite stayed
// green, and one of those greps even locked in a command that could never run.

import { describe, it, expect } from 'vitest'
import { gatewayRunCommand, gatewayRunArgs, SECURITY_FLAGS } from '../../src/openclaw/runtime.js'

const base = {
  image: 'ghcr.io/openclaw/openclaw:2026.9.2',
  stateDir: '/var/lib/clawops/openclaw',
}

describe('gatewayRunArgs', () => {
  it('carries everything the gateway needs to start', () => {
    const cmd = gatewayRunArgs(base)
    // No OPENCLAW_CONFIG_PATH: the mount point IS OpenClaw's default config location,
    // so setting it would be one more thing to keep in sync. SP-11 §B.
    expect(cmd).not.toContain('OPENCLAW_CONFIG_PATH')
    expect(cmd).toContain('--add-host=host.docker.internal:host-gateway') // host-local models
    expect(cmd).toContain('--port 18789')                                 // argv beats config
    expect(cmd).toContain('gateway run')                                  // not the bare CMD
    expect(cmd).not.toMatch(/gateway run[^\n]*--allow-unconfigured/)                     // WO-40
    expect(cmd).toContain('OPENCLAW_SUPERVISOR_MODE=external')            // no self-update
    expect(cmd).toContain('openclaw.env')                                 // token, off argv
  })

  it('publishes on loopback by default', () => {
    // The gateway is reached over `clawops tunnel` or a reverse proxy — never by opening
    // the port to the world. `session.tunnel(local, 'localhost', remote)` connects to the
    // remote's loopback, so tunnelling is unaffected by this.
    expect(gatewayRunArgs(base)).toContain('-p 127.0.0.1:18789:18789')
    expect(gatewayRunArgs(base)).not.toMatch(/-p 18789:18789/)
  })

  it('can publish on all interfaces when a deployment has opened the port', () => {
    const cmd = gatewayRunArgs({ ...base, publish: 'all' })
    expect(cmd).toContain('-p 18789:18789')
    expect(cmd).not.toContain('127.0.0.1')
  })

  it('applies the security profile SP-06 observed on a live Fleet cell', () => {
    const cmd = gatewayRunArgs(base)
    for (const flag of SECURITY_FLAGS.split(' ')) expect(cmd).toContain(flag)
    expect(cmd).toContain('--cap-drop=ALL')
    expect(cmd).toContain('--pids-limit 512')
  })

  it('omits capacity limits unless asked', () => {
    // Fleet caps memory/cpu to divide a host between tenants. clawops is single-tenant,
    // where inheriting Fleet's 2 GB would shrink a large box rather than protect it.
    expect(gatewayRunArgs(base)).not.toContain('--memory')
    expect(gatewayRunArgs(base)).not.toContain('--cpus')
    const limited = gatewayRunArgs({ ...base, limits: { memory: '2g', cpus: '2' } })
    expect(limited).toContain('--memory 2g')
    expect(limited).toContain('--cpus 2')
  })

  it('supervises differently under systemd', () => {
    const unit = gatewayRunArgs({ ...base, supervisor: 'systemd' })
    // systemd owns restarts; a detached container would exit the unit immediately.
    expect(unit).toContain('--rm')
    expect(unit).not.toContain(' -d ')
    expect(unit).not.toContain('--restart unless-stopped')

    const detached = gatewayRunArgs(base)
    expect(detached).toContain('-d --restart unless-stopped')
    expect(detached).not.toContain('--rm')
  })

  it('accepts shell expressions for a template caller', () => {
    const cmd = gatewayRunArgs({
      image: 'ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}',
      stateDir: '${OPENCLAW_STATE_DIR}',
      port: '${OPENCLAW_PORT}',
      envFilePath: '${OPENCLAW_ENV_FILE}',
      supervisor: 'systemd',
    })
    expect(cmd).toContain('-p 127.0.0.1:${OPENCLAW_PORT}:${OPENCLAW_PORT}')
    expect(cmd).toContain('--port ${OPENCLAW_PORT}')
    expect(cmd).toContain('-v ${OPENCLAW_STATE_DIR}:/home/node/.openclaw')
  })

  it('attaches the env file conditionally, so a pre-v1.7.2 host still starts', () => {
    expect(gatewayRunArgs(base)).toContain('$([ -s /home/clawops/openclaw.env ] && echo --env-file')
  })
})

describe('gatewayRunCommand', () => {
  it('stops and removes before running', () => {
    const cmd = gatewayRunCommand(base)
    expect(cmd.indexOf('docker stop openclaw')).toBeLessThan(cmd.indexOf('docker run'))
    expect(cmd.indexOf('docker rm')).toBeLessThan(cmd.indexOf('docker run'))
  })

  it('honours a PATH prefix for hosts where docker is not on a login PATH', () => {
    const cmd = gatewayRunCommand({ ...base, pathPrefix: 'export PATH=/x:$PATH && ' })
    expect(cmd.startsWith('export PATH=/x:$PATH && ')).toBe(true)
  })

  it('is the same run command the systemd path uses, differing only in supervision', () => {
    const chain = gatewayRunCommand(base)
    const args = gatewayRunArgs(base)
    expect(chain).toContain(args)
  })
})

describe('publishForRestart', () => {
  it('preserves a deliberately exposed deployment', async () => {
    const { publishForRestart } = await import('../../src/openclaw/runtime.js')
    // A restart must not narrow reachability any more than it may widen the version.
    expect(publishForRestart('{"18789/tcp":[{"HostIp":"0.0.0.0","HostPort":"18789"}]}')).toBe('all')
    expect(publishForRestart('{"18789/tcp":[{"HostIp":"","HostPort":"18789"}]}')).toBe('all')
    expect(publishForRestart('{"18789/tcp":[{"HostIp":"::","HostPort":"18789"}]}')).toBe('all')
  })

  it('preserves a loopback deployment', async () => {
    const { publishForRestart } = await import('../../src/openclaw/runtime.js')
    expect(publishForRestart('{"18789/tcp":[{"HostIp":"127.0.0.1","HostPort":"18789"}]}')).toBe('loopback')
  })

  it('falls back to the safe scope rather than guessing wide', async () => {
    const { publishForRestart } = await import('../../src/openclaw/runtime.js')
    for (const junk of ['', 'null', 'not json', '{}', '{"18789/tcp":null}']) {
      expect(publishForRestart(junk), junk).toBe('loopback')
    }
  })
})

describe('exposure is an explicit choice', () => {
  it('the wizard no longer opens the gateway to the SSH CIDR', async () => {
    // It used to set allowedGatewayCidrs to whatever the operator gave for SSH, which
    // opened a plaintext HTTP dashboard to their whole office range. Two different risks
    // were being answered by one question.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(import.meta.dirname, '../../src/cli/commands/setup.ts'), 'utf8')
    expect(src).not.toMatch(/allowedGatewayCidrs:\s*\[stackAnswers\.sshCidr/)
    expect(src).toMatch(/allowedGatewayCidrs:\s*\[\]/)
  })

  it('the plan schema defaults publishGateway to loopback', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const schema = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../spec/deploy-plan.schema.json'), 'utf8'),
    ) as { properties: Record<string, never> }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const net = (schema as any).properties.spec.properties.network.properties.publishGateway
    expect(net.default).toBe('loopback')
    expect(net.enum).toEqual(['loopback', 'all'])
  })
})

describe('publishedGatewayPort', () => {
  it('reads the host port off a running container', async () => {
    const { publishedGatewayPort } = await import('../../src/openclaw/runtime.js')
    expect(
      publishedGatewayPort('{"18789/tcp":[{"HostIp":"127.0.0.1","HostPort":"18789"}]}'),
    ).toBe(18789)
  })

  it('reads a non-default port', async () => {
    const { publishedGatewayPort } = await import('../../src/openclaw/runtime.js')
    expect(publishedGatewayPort('{"9443/tcp":[{"HostIp":"0.0.0.0","HostPort":"9443"}]}')).toBe(9443)
  })

  it.each([
    ['nothing published', '{}'],
    ['null bindings', 'null'],
    ['a binding with no host port', '{"18789/tcp":[{"HostIp":"0.0.0.0"}]}'],
    ['an empty port list', '{"18789/tcp":[]}'],
    ['unparseable output', 'Error: No such object: openclaw'],
    ['empty output', ''],
  ])('returns undefined for %s', async (_label, stdout) => {
    // Undefined, never a guess: the only caller opens a firewall port with it.
    const { publishedGatewayPort } = await import('../../src/openclaw/runtime.js')
    expect(publishedGatewayPort(stdout)).toBeUndefined()
  })

  it('rejects a port outside the valid range', async () => {
    const { publishedGatewayPort } = await import('../../src/openclaw/runtime.js')
    expect(publishedGatewayPort('{"x/tcp":[{"HostPort":"0"}]}')).toBeUndefined()
    expect(publishedGatewayPort('{"x/tcp":[{"HostPort":"70000"}]}')).toBeUndefined()
  })
})
