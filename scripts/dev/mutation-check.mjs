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
  { name: 'migrate stops the container before extracting state',
    file: 'src/openclaw/migrate.ts', from: '  const extracted = await steps.extract()', to: '  await steps.removeSource()\n  const extracted = await steps.extract()', test: 'tests/openclaw/migrate.test.ts' },
  { name: 'migrate proceeds without a verified backup',
    file: 'src/openclaw/migrate.ts', from: '  if (!backup.ok) {', to: '  if (false) {', test: 'tests/openclaw/migrate.test.ts' },
  { name: 'migrate declares success on the first start',
    file: 'src/openclaw/migrate.ts', from: '  if (!gate.ok) {\n    await steps.start()', to: '  if (false) {\n    await steps.start()', test: 'tests/openclaw/migrate.test.ts' },
  { name: 'migrate claims identity continuity it did not verify',
    file: 'src/openclaw/migrate.ts', from: "      ? 'unknown'", to: "      ? 'preserved'", test: 'tests/openclaw/migrate.test.ts' },
  { name: 'migrate skips the numeric chown',
    file: 'src/openclaw/migrate.ts', from: '  await steps.chown()\n', to: '', test: 'tests/openclaw/migrate.test.ts' },
  { name: 'repair command combines --fix with --json again',
    file: 'src/openclaw/upgrade.ts', from: 'openclaw doctor --fix --non-interactive --yes`', to: 'openclaw doctor --fix --json`', test: 'tests/openclaw/upgrade.test.ts' },
  { name: 'dist-tag reverts to a SemVer range',
    file: '.github/workflows/release.yml', from: "&& 'legacy' ||", to: "&& 'v1' ||", test: 'tests/release/dist-tag.test.ts' },

  // ── WO-47: the MCP tool surface ──────────────────────────────────────────────
  { name: 'doctor calls the gateway healthy because the container is running',
    file: 'src/diagnostics/index.ts', from: "  const verdict = interpretProbe('started', probe.stdout)", to: "  const verdict = { ok: true }", test: 'tests/diagnostics' },
  { name: 'doctor probe accepts the Control UI HTML (no body check)',
    file: 'src/diagnostics/index.ts', from: "  const probe = await session.exec(probeCommand('started', GATEWAY_PORT), signal)", to: "  const probe = await session.exec(probeCommand('started', GATEWAY_PORT), signal); probe.stdout = '{\"ok\":true,\"status\":\"started\"}'", test: 'tests/diagnostics' },
  { name: 'doctor reports ok when checks failed',
    file: 'src/diagnostics/index.ts', from: 'return { sections, ok: counts.fail === 0, counts }', to: 'return { sections, ok: true, counts }', test: 'tests/diagnostics' },
  { name: 'doctor counts warnings as failures (a fresh machine reads as broken)',
    file: 'src/diagnostics/index.ts', from: 'ok: counts.fail === 0,', to: 'ok: counts.fail === 0 && counts.warn === 0,', test: 'tests/diagnostics' },
  { name: 'doctor drops the session release on a failed remote check',
    file: 'src/diagnostics/index.ts', from: '      } finally {\n        handle.release()', to: '      } finally {\n        void 0;', test: 'tests/diagnostics' },
  { name: 'doctor no longer points an unsupported deployment at migrate',
    file: 'src/diagnostics/index.ts', from: "        ? 'this clawops line requires OpenClaw 2.0 or later — run `clawops migrate` to move an '", to: "        ? 'unsupported ('", test: 'tests/diagnostics' },
  { name: 'doctor exits 0 on a failed report',
    file: 'src/cli/commands/doctor.ts', from: '    if (!report.ok) {', to: '    if (false) {', test: 'tests/cli/doctor.test.ts' },
  { name: 'doctor prints the bug hint into --json output',
    file: 'src/cli/commands/doctor.ts', from: '      if (!args.json) {', to: '      if (true) {', test: 'tests/cli/doctor.test.ts' },
  { name: 'doctor leaves its signal handlers attached',
    file: 'src/cli/commands/doctor.ts', from: "      process.off('SIGINT', abort)", to: '      void abort', test: 'tests/cli/doctor.test.ts' },
  { name: 'clawops_doctor recomputes ok from the filtered checks',
    file: 'src/mcp/tools/cli/doctor.ts', from: '  return { sections, ok: report.ok, counts: report.counts }', to: '  return { sections, ok: sections.length === 0, counts: report.counts }', test: 'tests/mcp/doctor.test.ts' },
  { name: 'clawops_doctor keeps passing checks under failuresOnly',
    file: 'src/mcp/tools/cli/doctor.ts', from: "c.status === 'fail' || c.status === 'warn'", to: 'true', test: 'tests/mcp/doctor.test.ts' },
  { name: 'clawops_doctor returns the untrimmed report (bypasses R14)',
    file: 'src/mcp/tools/cli/doctor.ts', from: '  return okText(content)', to: '  return okText(JSON.stringify(payload, null, 2))', test: 'tests/mcp/doctor.test.ts' },
  { name: 'agents list masks a failed listing as an empty one',
    file: 'src/mcp/tools/cli/agents.ts', from: '    if (result.code !== 0) {', to: '    if (false) {', test: 'tests/mcp/agents.test.ts' },
  { name: 'agents list masks a failed listing as empty (CLI)',
    file: 'src/cli/commands/agents.ts', from: '        if (result.code !== 0) {', to: '        if (false) {', test: 'tests/cli/agents.test.ts' },
  { name: 'MCP config read goes back to an unprivileged cat',
    file: 'src/mcp/tools/cli/config.ts', from: '      cfg = await readRemoteConfig(session, ac.signal)\n    } catch (err) {\n      return errText((err as Error).message)\n    }\n    const value =', "to": "      const r = await session.exec('cat /var/lib/clawops/openclaw/openclaw.json', ac.signal)\n      cfg = JSON.parse(r.stdout) as Record<string, unknown>\n    } catch (err) {\n      return errText((err as Error).message)\n    }\n    const value =", test: 'tests/mcp/config.test.ts' },
  { name: 'catalog validator accepts a missing annotation hint',
    file: 'scripts/lib/validate-mcp-spec.ts', from: "        if (typeof ann[hint] !== 'boolean') {", to: '        if (false) {', test: 'tests/scripts' },
  { name: 'catalog validator accepts a writing tool in the read toolset',
    file: 'scripts/lib/validate-mcp-spec.ts', from: "      if (ann.readOnlyHint === false && toolsets.includes('read')) {", to: '      if (false) {', test: 'tests/scripts' },
  { name: 'registry and catalog no longer have to agree',
    file: 'src/mcp/tools/registry.ts', from: 'export const TOOL_NAMES: readonly string[] = Object.keys(TOOL_REGISTRY)', to: "export const TOOL_NAMES: readonly string[] = Object.keys(TOOL_REGISTRY).filter((n) => n !== 'clawops_doctor')", test: 'tests/mcp/catalog.test.ts' },
  { name: 'FakeSshSession matchers stop overriding earlier ones',
    file: 'tests/helpers/ssh.ts', from: '    this.execMatchers.unshift({ pattern, handler })', to: '    this.execMatchers.push({ pattern, handler })', test: 'tests/diagnostics' },
  { name: 'README tool table no longer has to match the catalog',
    file: 'README.md', from: '| `clawops_doctor` | cli |', to: '| `clawops_nonexistent` | cli |', test: 'tests/mcp/catalog.test.ts' },
  { name: 'risk matrix disagrees with the catalog on --read-only',
    file: 'docs/security/tool-risk-matrix.md', from: '| `clawops_doctor` | cli | Read-only | ✅ |', to: '| `clawops_doctor` | cli | Read-only | ❌ |', test: 'tests/mcp/catalog.test.ts' },
  { name: 'read-only docs omit a tool the mode enables',
    file: 'docs/mcp/read-only.md', from: '| `clawops_doctor` | Diagnose', to: '| `clawops_nope` | Diagnose', test: 'tests/mcp/catalog.test.ts' },
  { name: 'safety docs miscount the destructive tools',
    file: 'docs/security/mcp-safety.md', from: 'the 7 destructive ones', to: 'the 8 destructive ones', test: 'tests/mcp/catalog.test.ts' },
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
