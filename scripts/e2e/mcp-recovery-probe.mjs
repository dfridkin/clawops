#!/usr/bin/env node
// Backup and restore over MCP, against a stack that cloud.sh has just deployed.
//
//   node scripts/e2e/mcp-recovery-probe.mjs <stack>     (run by cloud.sh when E2E_MCP=1)
//
// The local suite (tests/e2e/local/mcp-tools.e2e.test.ts) proves the same cycle on a host
// where clawops logs in as a user with passwordless sudo. AWS is the host where it does not:
// its login user is not in the docker group, so every docker call goes through clawops'
// privilege escalation — the path where the 2.2 backup upload failed with "permission denied"
// after the backup had already been taken. That is why this runs on a real cloud.
//
// It starts the built server (`dist/cli.js mcp serve`) with the operator's own ~/.clawops,
// because that is where cloud.sh registered the stack. It writes a marker into the state
// directory, takes a backup, changes the marker, restores with activate, and checks the
// marker came back and the gateway answers. Markers are written with `clawops ssh`: the test
// harness may use a shell even though the tools under test may not.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const stack = process.argv[2]
if (!stack) {
  console.error('usage: mcp-recovery-probe.mjs <stack>')
  process.exit(2)
}
const STATE = '/var/lib/clawops/openclaw'
const LONG = { timeout: 1_200_000, resetTimeoutOnProgress: true }

let failures = 0
const pass = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => { console.log(`  ✗ ${m}`); failures++ }

function onHost(command) {
  const out = execFileSync('pnpm', ['-s', 'dev', 'ssh', '--stack', stack, '--command', command], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out.trim().split('\n').pop() ?? ''
}
const marker = () => onHost(`sudo cat ${STATE}/e2e-marker 2>/dev/null || echo MISSING`)
const writeMarker = (v) =>
  onHost(`echo ${v} | sudo tee ${STATE}/e2e-marker >/dev/null && sudo chown 1000:1000 ${STATE}/e2e-marker && echo ok`)
const started = () => /"status"\s*:\s*"started"/.test(onHost('curl -s --max-time 5 http://127.0.0.1:18789/startupz'))

const client = new Client({ name: 'clawops-e2e-cloud', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/cli.js'), 'mcp', 'serve'],
  // The SDK hands a stdio server only a short allowlist of variables (HOME, PATH, USER...)
  // unless told otherwise. Cloud credentials come from the environment (R6), so without this
  // the server cannot read the stack's state and every call fails with Pulumi's "code: -2".
  // A real client config passes AWS_PROFILE in its `env` block; this is the same thing.
  env: process.env,
  stderr: 'ignore',
}))

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, LONG)
  return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError === true }
}

try {
  writeMarker('before-backup')
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'clawops-e2e-cloud-')), 'backup.tar.gz')
  const created = await call('clawops_backup_create', { stackName: stack, out })
  if (created.isError) fail(`clawops_backup_create: ${created.text}`)
  else if (statSync(out).size < 1024) fail(`clawops_backup_create wrote ${statSync(out).size} bytes`)
  else pass(`clawops_backup_create wrote ${statSync(out).size} bytes`)

  writeMarker('after-backup')
  const restored = await call('clawops_backup_restore', { stackName: stack, file: out, activate: true, yes: true })
  if (restored.isError) fail(`clawops_backup_restore: ${restored.text.slice(0, 600)}`)
  else pass('clawops_backup_restore with activate returned ok')

  const now = marker()
  if (now === 'before-backup') pass('the restored state is the backup\'s')
  else fail(`the live marker reads "${now}", not "before-backup"`)

  if (started()) pass('the gateway answers on the restored state')
  else fail('the gateway does not answer after the restore')

  const kept = onHost(`sudo sh -c 'cat ${STATE}.pre-restore-*/e2e-marker' 2>/dev/null || echo MISSING`)
  if (kept === 'after-backup') pass('the replaced state was kept')
  else fail(`the replaced state was not kept (found "${kept}")`)
} catch (err) {
  fail(`probe crashed: ${err.message}`)
} finally {
  await client.close()
}

process.exit(failures > 0 ? 1 : 0)
