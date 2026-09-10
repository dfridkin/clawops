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
    file: 'src/providers/startup.ts', from: '"gateway":{"mode":"local","port":${gatewayPort}', to: '"gateway":{"port":${gatewayPort}', test: 'tests/providers tests/openclaw' },
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

  // ── WO-48: plan-driven firewall, and the hardcoded port ──────────────────────
  { name: 'gateway ingress created even on loopback publishing',
    file: 'src/providers/firewall.ts', from: "  if (publishGateway !== 'all') return []", to: '  if (false) return []', test: 'tests/plan/network-validate.test.ts tests/providers' },
  { name: 'any non-empty publish value counts as exposed',
    file: 'src/providers/firewall.ts', from: "  if (publishGateway !== 'all') return []", to: '  if (!publishGateway) return []', test: 'tests/plan/network-validate.test.ts tests/providers' },
  { name: 'an invalid gatewayPort is used instead of the default',
    file: 'src/providers/firewall.ts', from: '  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback', to: '  return Number.isNaN(port) ? fallback : port', test: 'tests/plan/network-validate.test.ts tests/providers' },
  { name: 'plan accepts gateway CIDRs alongside loopback publishing',
    file: 'src/plan/validate.ts', from: "  if (publish === 'loopback' && gatewayCidrs.length > 0) {", to: '  if (false) {', test: 'tests/plan/network-validate.test.ts' },
  { name: 'absent publishGateway no longer defaults to loopback in validation',
    file: 'src/plan/validate.ts', from: "  const publish = net.publishGateway ?? 'loopback'", to: "  const publish = net.publishGateway ?? 'all'", test: 'tests/plan/network-validate.test.ts' },
  { name: 'plan stops noticing a published/configured port mismatch',
    file: 'src/plan/validate.ts', from: '  if (net.gatewayPort !== undefined && configured !== undefined && configured !== net.gatewayPort) {', to: '  if (false) {', test: 'tests/plan/network-validate.test.ts' },
  { name: 'plan stops warning about 0.0.0.0/0',
    file: 'src/plan/validate.ts', from: "    if (cidrs.some((c) => c === '0.0.0.0/0' || c === '::/0')) {", to: '    if (false) {', test: 'tests/plan/network-validate.test.ts' },
  { name: 'ufw opens the gateway port unconditionally again',
    file: 'src/harden/modules/ufw.ts', from: '      if (!gateway.exposed) {', to: '      if (false) {', test: 'tests/harden/modules.test.ts' },
  { name: 'ufw guesses the default port when it cannot read one',
    file: 'src/harden/modules/ufw.ts', from: '      } else if (gateway.port === undefined) {', to: '      } else if (false) {', test: 'tests/harden/modules.test.ts' },
  { name: 'SG audit exempts SSH and the gateway from the world-open check',
    file: 'src/harden/modules/aws-sg-audit.ts', from: '            if (range.CidrIp && WORLD.has(range.CidrIp)) {', to: '            if (range.CidrIp && WORLD.has(range.CidrIp) && ![22, GATEWAY_PORT].includes(fromPort)) {', test: 'tests/harden/aws-modules.test.ts' },
  { name: 'SG audit stops checking IPv6 rules',
    file: 'src/harden/modules/aws-sg-audit.ts', from: '          for (const range of rule.Ipv6Ranges ?? []) {', to: '          for (const range of []) {', test: 'tests/harden/aws-modules.test.ts' },
  { name: 'published port not read from the running container',
    file: 'src/openclaw/runtime.ts', from: '        if (Number.isInteger(port) && port > 0 && port < 65536) return port', to: '        void port', test: 'tests/openclaw/runtime.test.ts tests/harden/modules.test.ts' },
  { name: 'startup script publishes a port the config does not use',
    file: 'src/providers/startup.ts', from: '"gateway":{"mode":"local","port":${gatewayPort}', to: '"gateway":{"mode":"local","port":18789', test: 'tests/openclaw/port-single-source.test.ts tests/providers' },
  { name: 'local bootstrap template pins the port again',
    file: 'src/providers/local/bootstrap.sh.tmpl', from: 'OPENCLAW_PORT={{OPENCLAW_PORT}}', to: 'OPENCLAW_PORT=18789', test: 'tests/openclaw/port-single-source.test.ts tests/providers' },
  { name: 'up accepts a nonsense --gateway-port',
    file: 'src/cli/commands/up.ts', from: '  if (!Number.isInteger(port) || port < 1 || port > 65535) {', to: '  if (false) {', test: 'tests/cli/up.test.ts' },
  { name: 'up falls back to the default port on a bad --gateway-port',
    file: 'src/cli/commands/up.ts', from: '    throw new UsageError(`--gateway-port must be a port number between 1 and 65535, got "${raw}"`)', to: '    return undefined', test: 'tests/cli/up.test.ts' },
  { name: 'wizard SSH prompt defaults to the whole internet again',
    file: 'src/cli/commands/setup.ts', from: '          ...(sshCidrDefault ? { default: sshCidrDefault } : {}),', to: "          default: '0.0.0.0/0',", test: 'tests/cli/setup-cidr.test.ts' },
  { name: 'wizard accepts an empty SSH CIDR',
    file: 'src/cli/commands/setup.ts', from: "  if (v === '') return 'Required — enter a CIDR such as 203.0.113.4/32'", to: "  if (false) return ''", test: 'tests/cli/setup-cidr.test.ts' },
  { name: 'wizard offers a default even when detection failed',
    file: 'src/cli/commands/setup.ts', from: '  if (!result.ok) return undefined', to: "  if (!result.ok) return '0.0.0.0/0'", test: 'tests/cli/setup-cidr.test.ts' },
  { name: 'harden opens a reverse-proxy port it was never told about',
    file: 'src/harden/modules/ufw.ts', from: "      const rules = [`ufw allow ${sshPort}/tcp comment \"clawops SSH\"`]", to: "      const rules = [`ufw allow ${sshPort}/tcp comment \"clawops SSH\"`, 'ufw allow 443/tcp']", test: 'tests/harden/modules.test.ts' },

  // ── WO-61: the MCP wiring plumbing ───────────────────────────────────────────
  { name: 'wire saves without probing the server first',
    file: 'src/cli/mcp-wire.ts', from: '`--transport streamable-http`,', to: '`--transport streamable-http --no-probe`,', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire goes back to stdio, which spawns inside the container',
    file: 'src/cli/mcp-wire.ts', from: '`--transport streamable-http`,', to: '`--command clawops --arg mcp --arg serve`,', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire points the gateway at its own loopback',
    file: 'src/cli/mcp-wire.ts', from: '  return `http://host.docker.internal:${port}/`', to: '  return `http://127.0.0.1:${port}/`', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire drops the bearer header',
    file: 'src/cli/mcp-wire.ts', from: '...(opts.token ? [`--header ${shellQuote(`Authorization=Bearer ${opts.token}`)}`] : []),', to: '...[],', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire reports success when the probe failed',
    file: 'src/cli/mcp-wire.ts', from: '  if (added.code !== 0) {', to: '  if (false) {', test: 'tests/cli/mcp-wire.test.ts tests/cli/mcp.test.ts' },
  { name: 'wire never reloads, so the change does not take effect',
    file: 'src/cli/mcp-wire.ts', from: '  await execPrivileged(session, `${OC} reload`, signal)', to: '  void OC', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire adds over an existing entry without removing it',
    file: 'src/cli/mcp-wire.ts', from: '  if (alreadyWired) {', to: '  if (false) {', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire replaces an existing entry without being asked',
    file: 'src/cli/mcp-wire.ts', from: "  if (alreadyWired && !opts.rewire) return { status: 'exists', url }", to: '  void opts.rewire', test: 'tests/cli/mcp-wire.test.ts tests/cli/mcp.test.ts' },
  { name: 'wire stops quoting the url',
    file: 'src/cli/mcp-wire.ts', from: '`--url ${shellQuote(url)}`,', to: '`--url ${url}`,', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire adds on top of a failed unset',
    file: 'src/cli/mcp-wire.ts', from: '    if (removed.code !== 0) {', to: '    if (false) {', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'MCP HTTP server shares one transport for every client',
    file: 'src/mcp/server.ts', from: '  const existing = typeof sessionId === \'string\' ? sessions.get(sessionId) : undefined', to: '  const existing = sessions.values().next().value', test: 'tests/mcp/http-live.test.ts' },
  { name: 'MCP HTTP server treats an unknown session as a new one',
    file: 'src/mcp/server.ts', from: "  if (typeof sessionId === 'string') {", to: '  if (false) {', test: 'tests/mcp/http-live.test.ts' },
  { name: 'MCP HTTP server serves without checking the token',
    file: 'src/mcp/server.ts', from: '  if (token) {', to: '  if (false) {', test: 'tests/mcp/http-live.test.ts' },
  { name: 'MCP HTTP token compare short-circuits on length only',
    file: 'src/mcp/server.ts', from: '  return timingSafeEqual(a, b)', to: '  return true', test: 'tests/mcp/http-live.test.ts' },
  { name: 'MCP HTTP binds anywhere without a token',
    file: 'src/mcp/server.ts', from: '  if (isLoopbackBind(bind) || token) return { ok: true }', to: '  return { ok: true }\n  if (isLoopbackBind(bind) || token) return { ok: true }', test: 'tests/mcp/http-live.test.ts tests/mcp/http.test.ts' },
  { name: 'MCP HTTP treats 0.0.0.0 as loopback',
    file: 'src/mcp/server.ts', from: "const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])", to: "const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0'])", test: 'tests/mcp/http-live.test.ts' },
  { name: 'MCP HTTP server default port collides with the gateway',
    file: 'src/mcp/server.ts', from: 'export const MCP_HTTP_PORT = 18790', to: 'export const MCP_HTTP_PORT = 18789', test: 'tests/mcp/http-live.test.ts' },
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
