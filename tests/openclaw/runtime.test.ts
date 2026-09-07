// The runtime contract. These assert *rendered commands*, not the presence of constants
// in a source file — the six run sites drifted for years while a source-grep suite stayed
// green, and one of those greps even locked in a command that could never run.

import { describe, it, expect } from 'vitest'
import { gatewayRunCommand, gatewayRunArgs, SECURITY_FLAGS } from '../../src/openclaw/runtime.js'

const base = {
  image: 'ghcr.io/openclaw/openclaw:2026.7.1',
  configPath: '/home/clawops/openclaw.json',
}

describe('gatewayRunArgs', () => {
  it('carries everything the gateway needs to start', () => {
    const cmd = gatewayRunArgs(base)
    expect(cmd).toContain('-e OPENCLAW_CONFIG_PATH=/app/config.json')   // config is read
    expect(cmd).toContain('--add-host=host.docker.internal:host-gateway') // host-local models
    expect(cmd).toContain('--port 18789')                                 // argv beats config
    expect(cmd).toContain('gateway run --allow-unconfigured')             // not the bare CMD
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
      configPath: '${OPENCLAW_CONFIG}',
      port: '${OPENCLAW_PORT}',
      envFilePath: '${OPENCLAW_ENV_FILE}',
      supervisor: 'systemd',
    })
    expect(cmd).toContain('-p 127.0.0.1:${OPENCLAW_PORT}:${OPENCLAW_PORT}')
    expect(cmd).toContain('--port ${OPENCLAW_PORT}')
    expect(cmd).toContain('-v ${OPENCLAW_CONFIG}:/app/config.json:ro')
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
