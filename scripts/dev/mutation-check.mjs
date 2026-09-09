#!/usr/bin/env node
// Does each test actually guard the behaviour it claims to?
//
// A test that passes proves nothing on its own — it may assert a fixture, grep for a string
// that moved, or take an early-return branch that never runs. This breaks each behaviour
// this release established and checks the corresponding test FAILS. A mutation that survives
// is a test that would not notice the regression.
//
//   node scripts/dev/mutation-check.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

/** Each: what we break, and which suite must notice. */
const MUTATIONS = [
  { name: 'port pin removed from the run command',
    file: 'src/openclaw/runtime.ts', from: '--port ${port}`,', to: '`,', test: 'tests/openclaw' },
  { name: 'config mounted read-only again',
    file: 'src/openclaw/runtime.ts', from: '`-v ${stateDir}:${STATE_DIR_CONTAINER}`', to: '`-v ${stateDir}:${STATE_DIR_CONTAINER}:ro`', test: 'tests/openclaw' },
  { name: 'gateway published on every interface',
    file: 'src/openclaw/runtime.ts', from: "scope === 'loopback' ? `-p 127.0.0.1:${port}:${port}`", to: "false ? `-p 127.0.0.1:${port}:${port}`", test: 'tests/openclaw' },
  { name: '--allow-unconfigured restored',
    file: 'src/openclaw/runtime.ts', from: 'gateway run --port ${port}`', to: 'gateway run --allow-unconfigured --port ${port}`', test: 'tests/openclaw' },
  { name: 'external supervisor flag dropped (gateway may self-update)',
    file: 'src/openclaw/runtime.ts', from: "    SUPERVISOR_ENV,\n", to: '', test: 'tests/openclaw' },
  { name: 'security profile dropped',
    file: 'src/openclaw/runtime.ts', from: "    SECURITY_FLAGS,\n", to: '', test: 'tests/openclaw' },
  { name: 'health probe accepts the Control UI HTML',
    file: 'src/openclaw/health.ts', from: "if (text.startsWith('<')) {", to: 'if (false) {', test: 'tests/openclaw/health.test.ts' },
  { name: 'health probe treats "live" as "started"',
    file: 'src/openclaw/health.ts', from: "if (kind === 'started' && obj['status'] !== 'started') {", to: 'if (false) {', test: 'tests/openclaw/health.test.ts' },
  { name: 'provider reconcile matches plugin id, not providerIds',
    file: 'src/openclaw/plugins.ts', from: '.flatMap((p) => p.providerIds ?? []),', to: '.flatMap((p) => (p as { id?: string }).id ? [(p as { id?: string }).id as string] : []),', test: 'tests/openclaw/plugins.test.ts' },
  { name: 'plugin version pin replaced by latest',
    file: 'src/openclaw/plugins.ts', from: "@${plugin.version}'", to: "'", test: 'tests/openclaw/plugins.test.ts' },
  { name: 'downgrade across a schema boundary allowed',
    file: 'src/openclaw/upgrade.ts', from: 'if (foundVersion > targetVersion) {', to: 'if (false) {', test: 'tests/openclaw/upgrade.test.ts' },
  { name: 'upgrade repairs in a loop instead of once',
    file: 'src/openclaw/upgrade.ts', from: '  await steps.repair()\n  await steps.run(ctx.version)', to: '  await steps.repair()\n  await steps.repair()\n  await steps.run(ctx.version)', test: 'tests/openclaw/upgrade.test.ts' },
  { name: 'gateway.mode no longer required by clawops',
    file: 'src/openclaw/config-validate.ts', from: '  if (mode === undefined) {', to: '  if (false) {', test: 'tests/openclaw/config-validate.test.ts' },
  { name: 'unknown config keys always demoted to warnings',
    file: 'src/openclaw/config-validate.ts', from: 'if (isUnknownKey(e) && runtimeIsNewer) {', to: 'if (isUnknownKey(e)) {', test: 'tests/openclaw/config-validate.test.ts' },
  { name: 'moving tags no longer refused',
    file: 'src/openclaw/versions.ts', from: '  if (isMovingTag(version)) {', to: '  if (false) {', test: 'tests/openclaw/versions.test.ts' },
  { name: 'restart falls back to a moving tag again',
    file: 'src/openclaw/run-flags.ts', from: "  if (!image || image.includes('Error') || !image.includes(':')) {", to: '  if (false) {', test: 'tests/openclaw tests/plan tests/cli' },
  { name: 'publish scope not preserved across restart',
    file: 'src/openclaw/runtime.ts', from: "        if (ip === '' || ip === '0.0.0.0' || ip === '::') return 'all'", to: '        void ip', test: 'tests/openclaw/runtime.test.ts' },
  { name: 'ownership reverts to clawops:clawops',
    file: 'src/plan/remote-config.ts', from: '` && chown ${CONTAINER_UID}:${CONTAINER_UID} ${configPath}`', to: '` && chown clawops:clawops ${configPath}`', test: 'tests/plan tests/openclaw tests/cli' },
  { name: 'provisioning stops writing gateway.mode',
    file: 'src/providers/startup.ts', from: '"gateway":{"mode":"local","port":18789', to: '"gateway":{"port":18789', test: 'tests/providers tests/openclaw' },
  { name: 'pre-2.0 config migration removed',
    file: 'src/providers/startup.ts', from: 'OPENCLAW_LEGACY_CONFIG=/home/clawops/openclaw.json', to: 'OPENCLAW_LEGACY_CONFIG=/nonexistent', test: 'tests/providers/startup.test.ts' },
  { name: 'backup archive written world-readable again',
    file: 'src/cli/commands/backup.ts', from: 'createWriteStream(outPath, { mode: 0o600 })', to: 'createWriteStream(outPath)', test: 'tests/cli/backup.test.ts' },
  { name: 'dist-tag reverts to a SemVer range',
    file: '.github/workflows/release.yml', from: "&& 'legacy' ||", to: "&& 'v1' ||", test: 'tests/release/dist-tag.test.ts' },
]

let survived = []
let caught = 0

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  if (!original.includes(m.from)) {
    survived.push({ ...m, why: 'ANCHOR NOT FOUND — mutation could not be applied' })
    continue
  }
  writeFileSync(m.file, original.replace(m.from, m.to))
  let failed = false
  try {
    execSync(`npx vitest run ${m.test} --reporter=dot 2>&1`, { stdio: 'pipe' })
  } catch {
    failed = true   // the suite noticed
  }
  writeFileSync(m.file, original)
  if (failed) { caught++; console.log(`  caught   ${m.name}`) }
  else { survived.push({ ...m, why: 'no test failed' }); console.log(`  SURVIVED ${m.name}`) }
}

console.log(`\n  ${caught}/${MUTATIONS.length} mutations caught`)
if (survived.length) {
  console.log('\n  Unguarded behaviour:')
  for (const s of survived) console.log(`    - ${s.name}  (${s.why})`)
  process.exitCode = 1
}
