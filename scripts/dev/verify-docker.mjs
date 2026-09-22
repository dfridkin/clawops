#!/usr/bin/env node
/**
 * Build the image Glama builds, then hold it to the same standard: does it speak MCP?
 *
 *   pnpm verify:docker
 *
 * The Dockerfile shipped without ever being built. Its first real build failed —
 * `npm pack --pack-destination /out` does not create /out — so Glama could not build it,
 * inferred a spec of its own instead, ran `clawops` with no subcommand, and got the CLI's help
 * text where it wanted a handshake. The listing was withheld for a missing `mkdir`.
 *
 * A Dockerfile nothing builds is a Dockerfile that does not work. This builds it and runs the
 * protocol probe against the container.
 */

import { spawnSync, spawnSync as run } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const IMAGE = 'clawops-mcp-verify:local'

const docker = run('docker', ['info'], { stdio: 'ignore' })
if (docker.status !== 0) {
  console.log('  ! docker is not running — skipping the image check')
  process.exit(0)
}

console.log(`  building ${IMAGE} …`)
const build = spawnSync('docker', ['build', '-q', '-t', IMAGE, '.'], { stdio: ['ignore', 'pipe', 'inherit'] })
if (build.status !== 0) {
  console.log('\n  ✗ the image does not build — Glama cannot list a server it cannot build')
  process.exit(1)
}

/*
 * The container gets a config of its own, mounted. It is read by a non-root user inside the
 * image, so the directory has to be traversable by someone other than the host user who made it.
 */
const home = mkdtempSync(path.join(tmpdir(), 'clawops-docker-probe-'))
writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    version: 1,
    defaults: { stack: 'probe', provider: 'aws' },
    stacks: {
      probe: {
        provider: 'aws',
        stateUrl: 's3://clawops-probe/clawops',
        region: 'us-east-1',
        credentialsRef: { source: 'cli-profile', profileName: 'probe' },
      },
    },
    ssh: { keyPath: '/probe/id_ed25519', knownHostsPath: '/probe/known_hosts' },
  }),
)
chmodSync(home, 0o755)
chmodSync(path.join(home, 'config.json'), 0o644)

const probe = spawnSync(
  process.execPath,
  [
    path.join(import.meta.dirname, 'mcp-probe.mjs'),
    'docker', 'run', '-i', '--rm',
    '-e', 'CLAWOPS_HOME=/probe',
    '-v', `${home}:/probe`,
    IMAGE,
  ],
  { stdio: 'inherit', env: { ...process.env, CLAWOPS_PROBE_HOME: home } },
)
process.exit(probe.status ?? 1)
