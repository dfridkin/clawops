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
    let capturedCommand = ''
    const exec: RemoteExec = async (cmd) => {
      capturedCommand = cmd
      return { stdout: '', stderr: '', code: 0 }
    }
    await mod.apply(exec)
    expect(capturedCommand).toContain('2222')
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
