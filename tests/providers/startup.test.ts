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
    const script = makeStartupScript({ openclawVersion: '2026.4.5', os: 'ubuntu' })
    // Version is set as a shell variable; docker pull/run use ${OPENCLAW_VERSION}
    expect(script).toContain('OPENCLAW_VERSION="2026.4.5"')
    expect(script).toContain('docker pull ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}')
    expect(script).toContain('ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}')
  })

  it('runs container with --allow-unconfigured flag', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('--allow-unconfigured')
  })

  it('mounts the config file as read-only (:ro)', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    // The -v flag mounts $OPENCLAW_CONFIG into /app/config.json:ro
    expect(script).toContain('/app/config.json:ro')
    // OPENCLAW_CONFIG points to the openclaw.json path
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

  it('chowns openclaw.json to clawops after creating it', () => {
    const script = makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' })
    expect(script).toContain('chown clawops:clawops "${OPENCLAW_CONFIG}"')
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
