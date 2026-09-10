// Unit tests for hardening modules — verifies check/apply logic using a mock RemoteExec.

import { describe, it, expect } from 'vitest'
import type { RemoteExec } from '../../src/harden/types.js'

function makeExec(responses: Record<string, { stdout: string; stderr?: string; code?: number }>): RemoteExec {
  return async (cmd: string) => {
    // Match by checking if the command includes any key substring
    for (const [key, resp] of Object.entries(responses)) {
      if (cmd.includes(key)) {
        return { stdout: resp.stdout, stderr: resp.stderr ?? '', code: resp.code ?? 0 }
      }
    }
    return { stdout: '', stderr: '', code: 0 }
  }
}

describe('sshModule', () => {
  it('check() returns applied when sentinel exists', async () => {
    const { sshModule } = await import('../../src/harden/modules/ssh.js')
    const exec = makeExec({ [`/etc/clawops/hardening/ssh.applied`]: { stdout: 'yes' } })
    const result = await sshModule.check(exec)
    expect(result.status).toBe('applied')
  })

  it('check() returns missing when no sentinel and sshd not hardened', async () => {
    const { sshModule } = await import('../../src/harden/modules/ssh.js')
    const exec = makeExec({
      'test -f': { stdout: 'no' },
      'sshd -T': { stdout: 'PermitRootLogin yes\nPasswordAuthentication yes\n' },
    })
    const result = await sshModule.check(exec)
    expect(result.status).toBe('missing')
  })

  it('apply() throws when authorized_keys is empty (lockout guard)', async () => {
    const { sshModule } = await import('../../src/harden/modules/ssh.js')
    const exec = makeExec({ 'authorized_keys': { stdout: '' } })
    await expect(sshModule.apply(exec)).rejects.toThrow(/authorized_keys is empty/)
  })

  it('apply() succeeds when authorized_keys has a key', async () => {
    const { sshModule } = await import('../../src/harden/modules/ssh.js')
    const exec = makeExec({ 'authorized_keys': { stdout: 'ssh-ed25519 AAAA...' } })
    const result = await sshModule.apply(exec)
    expect(result.changed).toBe(true)
  })
})

describe('ufwModule', () => {
  it('check() returns applied when UFW is active', async () => {
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const exec = makeExec({ 'ufw status': { stdout: 'Status: active\n' } })
    const result = await ufwModule.check(exec)
    expect(result.status).toBe('applied')
  })

  it('check() returns missing when UFW not installed', async () => {
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const exec = makeExec({ 'ufw status': { stdout: 'not installed' } })
    const result = await ufwModule.check(exec)
    expect(result.status).toBe('missing')
  })

  it('makeUfwModule() uses the custom SSH port in apply', async () => {
    const { makeUfwModule } = await import('../../src/harden/modules/ufw.js')
    const mod = makeUfwModule(2222)
    const { exec, script } = recordingExec()
    await mod.apply(exec)
    expect(script()).toContain('2222')
  })

  /**
   * apply() asks the host what the container publishes before writing rules, so the exec
   * has to answer the inspect and then capture the ufw script.
   */
  function recordingExec(bindings?: string): { exec: RemoteExec; script: () => string } {
    const commands: string[] = []
    const exec: RemoteExec = async (cmd) => {
      commands.push(cmd)
      if (cmd.includes('PortBindings')) {
        return { stdout: bindings ?? '{}', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    }
    return { exec, script: () => commands.filter((c) => c.includes('ufw')).join('\n') }
  }

  const LOOPBACK = '{"18789/tcp":[{"HostIp":"127.0.0.1","HostPort":"18789"}]}'
  const EXPOSED = '{"18789/tcp":[{"HostIp":"0.0.0.0","HostPort":"18789"}]}'
  const EXPOSED_ALT_PORT = '{"9443/tcp":[{"HostIp":"0.0.0.0","HostPort":"9443"}]}'

  it('does not open the gateway port when the gateway is on loopback', async () => {
    // The rule used to be unconditional. Since the gateway publishes on 127.0.0.1 by
    // default, `clawops harden` was opening a port nothing was listening on — widening the
    // firewall past what the deployment exposes, which is the opposite of hardening.
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const { exec, script } = recordingExec(LOOPBACK)
    const result = await ufwModule.apply(exec)
    expect(script()).not.toContain('18789')
    expect(script()).toContain('allow 22/tcp')
    expect(result.detail).toMatch(/not opened/)
  })

  it('opens the gateway port when the gateway is published to the network', async () => {
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const { exec, script } = recordingExec(EXPOSED)
    await ufwModule.apply(exec)
    expect(script()).toContain('allow 18789/tcp')
  })

  it('opens the port the container actually publishes, not the default', async () => {
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const { exec, script } = recordingExec(EXPOSED_ALT_PORT)
    await ufwModule.apply(exec)
    expect(script()).toContain('allow 9443/tcp')
    expect(script()).not.toContain('18789')
  })

  it('opens no gateway port when the published port cannot be read', async () => {
    // Exposed, but the port is unreadable. Guessing would either open nothing useful or
    // open something unintended; both are worse than saying so.
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const { exec, script } = recordingExec('{"18789/tcp":[{"HostIp":"0.0.0.0"}]}')
    const result = await ufwModule.apply(exec)
    expect(script()).not.toContain('allow 18789/tcp')
    expect(result.detail).toMatch(/could not be read/)
  })

  it('opens exactly the ports it was asked for, and no others', async () => {
    // Not just "does it include SSH": the whole allow-list. A rule for a port nobody asked
    // about — a reverse proxy's 443, say — is the same class of mistake as the
    // unconditional gateway rule this replaced.
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const { exec, script } = recordingExec(LOOPBACK)
    await ufwModule.apply(exec)
    const allows = script().split(' && ').filter((c) => c.trim().startsWith('ufw allow'))
    expect(allows).toEqual(['ufw allow 22/tcp comment "clawops SSH"'])
  })

  it('opens exactly SSH and the published port when the gateway is exposed', async () => {
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const { exec, script } = recordingExec(EXPOSED_ALT_PORT)
    await ufwModule.apply(exec)
    const allows = script().split(' && ').filter((c) => c.trim().startsWith('ufw allow'))
    expect(allows).toEqual([
      'ufw allow 22/tcp comment "clawops SSH"',
      'ufw allow 9443/tcp comment "OpenClaw gateway"',
    ])
  })

  it('still denies incoming by default and enables ufw', async () => {
    const { ufwModule } = await import('../../src/harden/modules/ufw.js')
    const { exec, script } = recordingExec(LOOPBACK)
    await ufwModule.apply(exec)
    expect(script()).toContain('ufw default deny incoming')
    expect(script()).toContain('ufw --force enable')
  })
})

describe('fail2banModule', () => {
  it('check() returns applied when fail2ban is active', async () => {
    const { fail2banModule } = await import('../../src/harden/modules/fail2ban.js')
    const exec = makeExec({ 'systemctl is-active fail2ban': { stdout: 'active' } })
    const result = await fail2banModule.check(exec)
    expect(result.status).toBe('applied')
  })

  it('check() returns drifted when installed but not running', async () => {
    const { fail2banModule } = await import('../../src/harden/modules/fail2ban.js')
    const exec = makeExec({
      'systemctl is-active': { stdout: 'inactive' },
      'dpkg -l fail2ban': { stdout: '1' },
    })
    const result = await fail2banModule.check(exec)
    expect(result.status).toBe('drifted')
  })
})

describe('dockerSocketModule', () => {
  it('check() returns applied when docker.sock is root:docker 660', async () => {
    const { dockerSocketModule } = await import('../../src/harden/modules/docker-socket.js')
    const exec = makeExec({ 'stat -c': { stdout: 'root docker 660' } })
    const result = await dockerSocketModule.check(exec)
    expect(result.status).toBe('applied')
  })

  it('check() returns drifted when permissions are wrong', async () => {
    const { dockerSocketModule } = await import('../../src/harden/modules/docker-socket.js')
    const exec = makeExec({ 'stat -c': { stdout: 'root root 666' } })
    const result = await dockerSocketModule.check(exec)
    expect(result.status).toBe('drifted')
    expect(result.detail).toContain('root:root 666')
  })

  it('check() returns skipped when docker socket is absent', async () => {
    const { dockerSocketModule } = await import('../../src/harden/modules/docker-socket.js')
    const exec = makeExec({ 'stat -c': { stdout: 'not found', code: 1 } })
    const result = await dockerSocketModule.check(exec)
    expect(result.status).toBe('skipped')
  })
})

describe('unattendedUpgradesModule', () => {
  it('check() returns applied when config file has the upgrade enabled setting', async () => {
    const { unattendedUpgradesModule } = await import('../../src/harden/modules/unattended-upgrades.js')
    const exec = makeExec({
      '20auto-upgrades': { stdout: 'APT::Periodic::Unattended-Upgrade "1";' },
    })
    const result = await unattendedUpgradesModule.check(exec)
    expect(result.status).toBe('applied')
  })
})
