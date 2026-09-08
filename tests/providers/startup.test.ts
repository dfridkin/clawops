// Unit tests for src/providers/startup.ts — verifies generated script content.
// These catch regressions that would otherwise only surface on live VMs.

import { describe, it, expect } from 'vitest'
import { makeStartupScript } from '../../src/providers/startup.js'

describe('makeStartupScript — universal invariants', () => {
  it('starts with #!/bin/bash and set -euo pipefail', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toMatch(/^#!\/bin\/bash\n/)
    expect(script).toContain('set -euo pipefail')
  })

  it('creates clawops user idempotently', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('id -u clawops &>/dev/null || useradd')
  })

  it('creates and chowns .ssh directory to clawops', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('mkdir -p /home/clawops/.ssh')
    expect(script).toContain('chmod 700 /home/clawops/.ssh')
    expect(script).toContain('chown clawops:clawops /home/clawops/.ssh')
  })

  it('installs docker-buildx-plugin', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('docker-buildx-plugin')
  })

  it('installs docker-compose-plugin', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('docker-compose-plugin')
  })

  it('installs docker-ce, docker-ce-cli, containerd.io', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('docker-ce')
    expect(script).toContain('docker-ce-cli')
    expect(script).toContain('containerd.io')
  })

  it('adds clawops to docker group', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('usermod -aG docker clawops')
  })

  it('uses direct .asc download instead of gpg --dearmor pipe', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('docker.asc')
    expect(script).not.toContain('gpg --dearmor')
  })

  it('embeds the specified openclawVersion in the OPENCLAW_VERSION variable assignment', () => {
    const script = makeStartupScript({ openclawVersion: '2026.9.2', os: 'ubuntu' })
    // Version is set as a shell variable; docker pull/run use ${OPENCLAW_VERSION}
    expect(script).toContain('OPENCLAW_VERSION="2026.9.2"')
    expect(script).toContain('docker pull ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}')
    expect(script).toContain('ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}')
  })

  it('runs the gateway WITHOUT --allow-unconfigured', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    // Inverted by WO-40. The flag suppressed upstream's clobbered-config check, and
    // clawops passed it permanently. Provisioning writes gateway.mode: "local" instead,
    // which is what the check actually wants — measured on 2026.9.2.
    expect(script).toContain('gateway run')
    expect(script).not.toMatch(/gateway run[^\n]*--allow-unconfigured/)
    expect(script).toContain('"mode":"local"')
  })

  it('mounts the state directory writable, not the config file read-only', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    // Inverted by WO-39. OpenClaw writes its config by atomic rename, which fails EBUSY
    // over a bind-mounted file whether :ro or rw — that blocked `plugins install`
    // entirely. Mounting the parent directory is the fix, and it is also what makes the
    // SQLite state survive a container replacement.
    expect(script).toContain(':/home/node/.openclaw')
    expect(script).not.toContain('/app/config.json')
    expect(script).not.toContain(':ro')
    expect(script).toContain('openclaw.json')
  })

  it('restarts unless-stopped', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('--restart unless-stopped')
  })

  it('stops and removes existing openclaw container before starting', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('docker stop openclaw')
    expect(script).toContain('docker rm   openclaw')
  })

  it('chowns the state directory NUMERICALLY, never to clawops', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    // useradd clawops gets uid 1001 on Ubuntu 24.04 because the ubuntu user already holds
    // 1000, and the container runs as 1000. A 1001-owned state dir makes the gateway exit
    // 1 with EACCES on its own SQLite WAL — verified on a native Linux bind mount, SP-11.
    expect(script).toContain('chown -R 1000:1000 "${OPENCLAW_STATE_DIR}"')
    expect(script).not.toMatch(/chown[^\n]*clawops:clawops[^\n]*OPENCLAW_STATE_DIR/)
  })

  it('migrates a pre-2.0 config file into the state directory', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    // Without this an in-place upgrade comes up with no configuration at all: the config
    // used to be a bare file in the service user's home.
    expect(script).toContain('OPENCLAW_LEGACY_CONFIG=/home/clawops/openclaw.json')
    expect(script).toMatch(/cp -p "\$\{OPENCLAW_LEGACY_CONFIG\}" "\$\{OPENCLAW_CONFIG\}"/)
    // Guarded both ways: only when a legacy file exists AND the target does not, so
    // re-running provisioning never clobbers a later edit.
    expect(script).toMatch(/\[ -f "\$\{OPENCLAW_LEGACY_CONFIG\}" \] && \[ ! -f "\$\{OPENCLAW_CONFIG\}" \]/)
  })
})

describe('makeStartupScript — OS variants', () => {
  it('uses ubuntu Docker apt source for os=ubuntu', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('download.docker.com/linux/ubuntu')
    expect(script).not.toContain('download.docker.com/linux/debian')
  })

  it('uses debian Docker apt source for os=debian', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'debian' })
    expect(script).toContain('download.docker.com/linux/debian')
    expect(script).not.toContain('download.docker.com/linux/ubuntu')
  })
})

describe('makeStartupScript — Bedrock disabled (default)', () => {
  it('does NOT inject AWS_DEFAULT_REGION env var when bedrockEnabled is false', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu', bedrockEnabled: false })
    expect(script).not.toContain('AWS_DEFAULT_REGION')
  })

  it('does NOT inject AWS_DEFAULT_REGION when bedrockEnabled is omitted', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).not.toContain('AWS_DEFAULT_REGION')
  })
})

describe('makeStartupScript — Bedrock enabled', () => {
  it('injects AWS_DEFAULT_REGION env var into docker run when bedrockEnabled=true', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu', bedrockEnabled: true })
    expect(script).toContain('AWS_DEFAULT_REGION')
  })

  it('uses IMDSv2 two-step token fetch (PUT + X-aws-ec2-metadata-token)', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu', bedrockEnabled: true })
    // Must use PUT to get token
    expect(script).toContain('-X PUT')
    expect(script).toContain('/latest/api/token')
    // Must use the token in the subsequent GET
    expect(script).toContain('X-aws-ec2-metadata-token')
    expect(script).toContain('/latest/meta-data/placement/region')
  })

  it('does NOT use bare GET to IMDS (would fail with httpTokens=required)', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu', bedrockEnabled: true })
    // The bare curl (no token header) must not appear
    expect(script).not.toMatch(/curl -sf http:\/\/169\.254\.169\.254\/latest\/meta-data\/placement\/region[^"]*[^X-aws]/)
  })

  it('falls back to us-east-1 if IMDS is unavailable', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu', bedrockEnabled: true })
    expect(script).toContain('us-east-1')
  })
})
