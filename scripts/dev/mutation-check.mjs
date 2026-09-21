#!/usr/bin/env node
// Does each test actually guard the behaviour it claims to?
//
// A test that passes proves nothing on its own — it may assert a fixture, grep for a string
// that moved, or take an early-return branch that never runs. This breaks each behaviour
// this release established and checks the corresponding test FAILS. A mutation that survives
// is a test that would not notice the regression.
//
//   node scripts/dev/mutation-check.mjs

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
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
  { name: 'wire assumes the gateway can be wired without asking',
    file: 'src/cli/mcp-wire.ts', from: "  if (!(await supportsMcpAdd(session, signal))) return { status: 'unsupported', url }", to: '  void supportsMcpAdd', test: 'tests/cli/mcp-wire.test.ts' },
  { name: 'wire treats a missing mcp add as available',
    file: 'src/cli/mcp-wire.ts', from: '  return help.code === 0', to: '  return true', test: 'tests/cli/mcp-wire.test.ts' },

  // ── WO-60: the channel catalog ───────────────────────────────────────────────
  { name: 'the Teams channel key reverts to one the schema does not have',
    file: 'spec/integrations.yaml', from: '  - id: msteams\n    channelKey: msteams', to: '  - id: teams\n    channelKey: teams', test: 'tests/spec/integrations.test.ts' },
  { name: "Discord's token field reverts to botToken",
    file: 'spec/integrations.yaml', from: '      - name: token\n        label: Bot token\n        description: Bot token from the Discord', to: '      - name: botToken\n        label: Bot token\n        description: Bot token from the Discord', test: 'tests/spec/integrations.test.ts' },
  { name: 'a channel stops declaring the plugin that provides it',
    file: 'spec/integrations.yaml', from: '    plugin:\n      package: "@openclaw/discord"\n      source: npm\n', to: '', test: 'tests/spec/integrations.test.ts' },
  { name: 'a channel stops recording the keys the schema requires',
    file: 'spec/integrations.yaml', from: '    requiredConfig: [dmPolicy, groupPolicy, mediaMaxMb]', to: '    requiredConfig: [dmPolicy]', test: 'tests/spec/integrations.test.ts' },
  { name: 'the wizard offers a channel it cannot configure',
    file: 'src/cli/commands/setup.ts', from: '  return integrations.filter((i) => i.wizardSupported !== false)', to: '  return integrations', test: 'tests/spec/integrations.test.ts' },
  { name: 'a channel without wizardSupported is dropped instead of offered',
    file: 'src/cli/commands/setup.ts', from: '  return integrations.filter((i) => i.wizardSupported !== false)', to: '  return integrations.filter((i) => i.wizardSupported === true)', test: 'tests/spec/integrations.test.ts' },
  { name: 'an envDefault reverts to a name OpenClaw does not read',
    file: 'spec/integrations.yaml', from: '        envDefault: DISCORD_BOT_TOKEN', to: '        envDefault: OPENCLAW_DISCORD_TOKEN', test: 'tests/spec/integrations.test.ts' },
  { name: 'a channel claims a --use-env path it does not have',
    file: 'spec/integrations.yaml', from: '    # `openclaw channels add --use-env` answers: OpenClaw does not recognize option\n    # "--use-env". There is no non-interactive path for this channel.\n    useEnvSupported: false', to: '    useEnvSupported: true', test: 'tests/spec/integrations.test.ts' },
  { name: 'a downloadable channel claims to be bundled',
    file: 'spec/integrations.yaml', from: '      package: "@openclaw/discord"\n      source: npm', to: '      package: ""\n      source: bundled', test: 'tests/spec/integrations.test.ts' },
  { name: 'the wizard stops writing the schema-required channel defaults',
    file: 'src/cli/commands/setup.ts', from: '  return { ...(integ.defaults ?? {}) }', to: '  return {}', test: 'tests/spec/integrations.test.ts' },
  { name: 'Slack reverts to the webhook setup the tooling does not install',
    file: 'spec/integrations.yaml', from: '    infraRequired: false\n    plugin:\n      package: "@openclaw/slack"', to: '    infraRequired: true\n    plugin:\n      package: "@openclaw/slack"', test: 'tests/spec/integrations.test.ts' },
  { name: 'Slack loses the app token Socket Mode needs',
    file: 'spec/integrations.yaml', from: '        envDefault: SLACK_APP_TOKEN', to: '        envDefault: SLACK_SIGNING_SECRET', test: 'tests/spec/integrations.test.ts' },
  { name: 'a channel default is set to a value the schema rejects',
    file: 'spec/integrations.yaml', from: '      mode: socket', to: '      mode: webhook', test: 'tests/spec/integrations.test.ts' },

  // ── WO-44 carried: the observability surface ────────────────────────────────
  { name: 'logs go back to the journalctl-or-docker chain',
    file: 'src/openclaw/logs.ts', from: "    'docker exec openclaw openclaw logs',", to: "    'journalctl -u openclaw 2>/dev/null || docker logs openclaw',", test: 'tests/openclaw/logs.test.ts tests/cli/logs.test.ts tests/mcp/logs.test.ts' },
  { name: 'a --since window is silently served by a source that cannot honour it',
    file: 'src/openclaw/logs.ts', from: '  if (opts.since) {', to: '  if (false) {', test: 'tests/openclaw/logs.test.ts tests/cli/logs.test.ts tests/mcp/logs.test.ts' },
  { name: 'logs are read from a gateway that is not answering',
    file: 'src/openclaw/logs.ts', from: '  if (!opts.gatewayReachable) {', to: '  if (false) {', test: 'tests/openclaw/logs.test.ts tests/mcp/logs.test.ts tests/cli/logs.test.ts' },
  { name: 'the log source is chosen but never reported',
    file: 'src/cli/commands/logs.ts', from: '      info(`Logs: ${choice.source} — ${choice.reason}`)', to: '      void choice', test: 'tests/cli/logs.test.ts' },
  { name: 'the MCP tool stops saying which source answered',
    file: 'src/mcp/tools/cli/logs.ts', from: '    let output = `[source: ${choice.source} — ${choice.reason}]\\n${result.stdout}`', to: '    let output = result.stdout', test: 'tests/mcp/logs.test.ts' },
  { name: 'agent logs go back to the removed agents-logs command',
    file: 'src/openclaw/logs.ts', from: "    'docker exec openclaw openclaw audit',", to: "    'docker exec -t openclaw openclaw agents logs',", test: 'tests/openclaw/logs.test.ts tests/cli/agents.test.ts' },
  { name: 'agent activity is no longer scoped to the agent',
    file: 'src/openclaw/logs.ts', from: '    `--agent ${shellQuote(opts.agentId)}`,', to: "    '',", test: 'tests/openclaw/logs.test.ts tests/cli/agents.test.ts' },
  { name: 'a failed audit query shows an empty list instead of an error',
    file: 'src/cli/commands/agents.ts', from: '        if (result.code !== 0) {\n          failure(`Cannot read activity', to: '        if (false) {\n          failure(`Cannot read activity', test: 'tests/cli/agents.test.ts' },

  // ── WO-63: channel plugin installs ───────────────────────────────────────────
  { name: 'channel install goes through the command that exits 0 on failure',
    file: 'src/openclaw/channels.ts', from: "    `openclaw plugins install '${spec}' --accept-capabilities`", to: "    `openclaw channels add --channel ${plugin.channelKey} --use-env`", test: 'tests/openclaw/channels.test.ts' },
  { name: 'channel plugins install unpinned',
    file: 'src/openclaw/channels.ts', from: '  const spec = plugin.version ? `${plugin.package}@${plugin.version}` : plugin.package', to: '  const spec = plugin.package', test: 'tests/openclaw/channels.test.ts tests/spec/integrations.test.ts' },
  { name: 'a bundled channel is installed anyway',
    file: 'src/openclaw/channels.ts', from: "    if (!plugin || plugin.source === 'bundled' || !plugin.package) continue", to: '    if (!plugin) continue', test: 'tests/openclaw/channels.test.ts' },
  { name: 'a bundled channel is reported missing',
    file: 'src/openclaw/channels.ts', from: '  return [...configuredChannelKeys(cfg)].filter((k) => !installed.has(k) && !bundled.has(k))', to: '  return [...configuredChannelKeys(cfg)].filter((k) => !installed.has(k))', test: 'tests/openclaw/channels.test.ts' },
  { name: 'channel verification trusts anything but installed:true',
    file: 'src/openclaw/channels.ts', from: '        .filter(([, v]) => v.installed === true)', to: '        .filter(([, v]) => v.installed !== false)', test: 'tests/openclaw/channels.test.ts' },
  { name: 'settings blocks are treated as channels',
    file: 'src/openclaw/channels.ts', from: "  const notAChannel = new Set(['defaults', 'modelByChannel'])", to: '  const notAChannel = new Set([])', test: 'tests/openclaw/channels.test.ts' },
  { name: 'an unreadable channel listing reports everything missing',
    file: 'src/openclaw/channels.ts', from: '    return [] // unreadable output is a reporting problem, not a missing channel', to: '    return [...configuredChannelKeys(cfg)]', test: 'tests/openclaw/channels.test.ts' },
  { name: 'a channel plugin pin drifts off the runtime floor',
    file: 'spec/integrations.yaml', from: '      package: "@openclaw/discord"\n      source: npm\n      version: "2026.9.2"', to: '      package: "@openclaw/discord"\n      source: npm\n      version: "2026.9.3"', test: 'tests/spec/integrations.test.ts' },

  // ── WO-64: Bedrock on the 2.0 config contract ────────────────────────────────
  { name: 'the models block reverts to the shape OpenClaw rejects',
    file: 'src/openclaw/models.ts', from: '  return { providers: { [key]: entry } }', to: "  return { provider: key, modelId } as Record<string, unknown>", test: 'tests/openclaw/models-block.test.ts' },
  { name: 'the provider is keyed by catalog id, not OpenClaw id',
    file: 'src/openclaw/models.ts', from: '  const fromPath = provider.configPath?.split(\'.\').pop()', to: '  const fromPath = undefined as string | undefined', test: 'tests/openclaw/models-block.test.ts' },
  { name: 'the models[] array is dropped',
    file: 'src/openclaw/models.ts', from: "  entry['models'] = [", to: "  entry['__models'] = [", test: 'tests/openclaw/models-block.test.ts' },
  { name: 'Bedrock loses its transport',
    file: 'src/openclaw/models.ts', from: "  if (provider.api) entry['api'] = provider.api", to: '  void provider.api', test: 'tests/openclaw/models-block.test.ts' },
  { name: 'the model entry loses its transport',
    file: 'src/openclaw/models.ts', from: '      ...(provider.api ? { api: provider.api } : {}),', to: '      ...{},', test: 'tests/openclaw/models-block.test.ts' },
  { name: 'a bundled provider gets a transport it did not ask for',
    file: 'src/openclaw/models.ts', from: "  if (provider.api) entry['api'] = provider.api", to: "  entry['api'] = provider.api ?? 'openai-responses'", test: 'tests/openclaw/models-block.test.ts' },
  { name: 'the resolved inference profile is ignored',
    file: 'src/openclaw/models.ts', from: '  const modelId = opts.resolvedModelId ?? model.modelId ?? model.id', to: '  const modelId = model.modelId ?? model.id', test: 'tests/openclaw/models-block.test.ts' },
  { name: 'a profile from another geography is used anyway',
    file: 'src/openclaw/bedrock.ts', from: '  return {\n    ok: false,\n    error:\n      `Bedrock has inference profiles', to: '  return { ok: true, profileId: candidates[0]!, why: \'any\' }\n  return {\n    ok: false,\n    error:\n      `Bedrock has inference profiles', test: 'tests/openclaw/bedrock.test.ts' },
  { name: 'profile matching becomes a substring match',
    file: 'src/openclaw/bedrock.ts', from: '    .filter((id) => id.endsWith(`.${foundationModelId}`))', to: '    .filter((id) => id.includes(foundationModelId))', test: 'tests/openclaw/bedrock.test.ts' },
  { name: 'ap regions stop mapping to apac',
    file: 'src/openclaw/bedrock.ts', from: "  if (prefix === 'ap') return 'apac'", to: '  void prefix', test: 'tests/openclaw/bedrock.test.ts' },
  { name: 'bedrock catalog loses the transport declaration',
    file: 'spec/models.yaml', from: '    api: bedrock-converse-stream', to: '    apiX: bedrock-converse-stream', test: 'tests/openclaw/models-block.test.ts' },

  // ── WO-66: account preflight ─────────────────────────────────────────────────
  { name: 'a failed service listing reports the APIs as enabled',
    file: 'src/providers/gcp/preflight.ts', from: '    const on = enabled?.has(api.service) ?? false', to: '    const on = enabled?.has(api.service) ?? true', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'preflight offers a fix without naming what it changes',
    file: 'src/providers/gcp/preflight.ts', from: '      mutates: on ? undefined : `Enables ${api.service} on project ${project}`,', to: '      mutates: undefined,', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'preflight runs every check against a project it does not know',
    file: 'src/providers/gcp/preflight.ts', from: '  if (!project) return checks', to: '  void project', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'the state bucket is created without versioning',
    file: 'src/providers/gcp/preflight.ts', from: '        versioning: { enabled: true },', to: '        versioning: { enabled: false },', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'unusable ADC is reported as an API problem',
    file: 'src/providers/gcp/preflight.ts', from: '  if (!token) {', to: '  if (false) {', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'the bucket check treats any response as existing',
    file: 'src/providers/gcp/preflight.ts', from: '  return res.ok', to: '  return true', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'the ADC-file test mocks nothing again',
    file: 'tests/providers/gcp/adapter.test.ts', from: '    mockAccessSync.mockImplementation(() => { throw new Error(\'ENOENT\') })', to: '    void mockAccessSync', test: 'tests/providers/gcp/adapter.test.ts' },
  { name: 'adapters stop registering themselves',
    file: 'src/providers/gcp/index.ts', from: 'registerProvider(gcpAdapter)', to: 'void gcpAdapter', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'a long check name runs into its detail again',
    file: 'src/cli/commands/doctor.ts', from: "${check.name.length >= NAME_COLUMN ? '  ' : ''}", to: '', test: 'tests/cli/doctor.test.ts' },
  { name: 'the plan\'s SSH CIDRs are dropped on the way to Pulumi again',
    file: 'src/plan/stack-config.ts', from: "  await stack.setConfig('sshCidrs', {", to: "  await stack.setConfig('sshCidrsX', {", test: 'tests/plan/stack-config.test.ts' },
  { name: 'accessMode defaults to open instead of restricted',
    file: 'src/plan/stack-config.ts', from: "  await stack.setConfig('accessMode', { value: 'restricted' })", to: "  await stack.setConfig('accessMode', { value: 'open' })", test: 'tests/plan/stack-config.test.ts' },
  { name: 'gateway CIDRs are dropped',
    file: 'src/plan/stack-config.ts', from: "  await stack.setConfig('gatewayCidrs', {", to: "  await stack.setConfig('gatewayCidrsX', {", test: 'tests/plan/stack-config.test.ts' },

  { name: 'the workspace goes back to spawning bare `pulumi`',
    file: 'src/pulumi/automation.ts', from: '      pulumiCommand,\n', to: '', test: 'tests/pulumi/automation.test.ts' },
  { name: 'a CLI on PATH is ignored in favour of downloading one',
    file: 'src/pulumi/cli.ts', from: "    return { kind: 'path', version: versionOf(await PulumiCommand.get()) }", to: "    return { kind: 'missing' }", test: 'tests/pulumi/cli.test.ts' },
  { name: 'our pinned copy loses to whatever is on PATH',
    file: 'src/pulumi/cli.ts', from: '  const root = pulumiCliRoot(configDir)\n  try {\n    return { kind:', to: '  const root = pulumiCliRoot(configDir)\n  if (await PulumiCommand.get().then(() => true, () => false)) return { kind: \'path\', version: versionOf(await PulumiCommand.get()) }\n  try {\n    return { kind:', test: 'tests/pulumi/cli.test.ts' },
  { name: 'the CLI is looked for next to the CWD rather than the config dir (R7)',
    file: 'src/diagnostics/index.ts', from: '  const cli = await pulumiCliStatus(configDir)', to: '  const cli = await pulumiCliStatus(process.cwd())', test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'the missing CLI is reported as a pass',
    file: 'src/diagnostics/index.ts', from: "            name: 'Pulumi CLI',\n            status: 'warn',", to: "            name: 'Pulumi CLI',\n            status: 'pass',", test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'the install announcement goes to stdout (R15)',
    file: 'src/pulumi/cli.ts', from: 'process.stderr.write(`Pulumi CLI not found', to: 'process.stdout.write(`Pulumi CLI not found', test: 'tests/pulumi/cli.test.ts' },
  { name: 'the install is announced only after it finishes',
    file: 'src/pulumi/cli.ts', from: "  announce({ root })\n  try {\n    return await PulumiCommand.install({ root })", to: "  try {\n    const c = await PulumiCommand.install({ root })\n    announce({ root })\n    return c", test: 'tests/pulumi/cli.test.ts' },
  { name: 'a failed install loses the reason it failed',
    file: 'src/pulumi/cli.ts', from: '`could not install the Pulumi CLI into ${root}: ${reason}\\n` +', to: '`could not install the Pulumi CLI into ${root}\\n` +', test: 'tests/pulumi/cli.test.ts' },
  { name: 'the CLI root collides with the Pulumi home',
    file: 'src/pulumi/cli.ts', from: "return path.join(configDir, '.pulumi-cli')", to: "return path.join(configDir, '.pulumi')", test: 'tests/pulumi/cli.test.ts' },
  { name: 'plan ignores --ssh-cidr again',
    file: 'src/cli/commands/plan.ts', from: '          network,\n', to: '', test: 'tests/cli/plan.test.ts' },
  { name: 'a bare IP is assumed to be a /32',
    file: 'src/plan/network-args.ts', from: "  return /^(\\d{1,3}\\.){3}\\d{1,3}\\/(3[0-2]|[12]?\\d)$/.test(v)", to: "  return /^(\\d{1,3}\\.){3}\\d{1,3}(\\/(3[0-2]|[12]?\\d))?$/.test(v)", test: 'tests/plan/network-args.test.ts' },
  { name: 'an invalid CIDR is passed through to the provider',
    file: 'src/plan/network-args.ts', from: '    if (!isCidr(p)) {', to: '    if (false) {', test: 'tests/plan/network-args.test.ts tests/cli/plan.test.ts' },
  { name: 'failed IP detection falls back to no rules',
    file: 'src/plan/network-args.ts', from: "  if (!result.ok || result.ip.trim() === '') {", to: '  if (false) {', test: 'tests/plan/network-args.test.ts tests/cli/plan.test.ts' },
  { name: 'auto resolves to a whole /24 instead of this host',
    file: 'src/plan/network-args.ts', from: "  const cidr = ip.includes('/') ? ip : `${ip}/32`", to: '  const cidr = `${ip}/24`', test: 'tests/plan/network-args.test.ts' },
  { name: 'the ssh flag fills the gateway list',
    file: 'src/plan/network-args.ts', from: "    ['--ssh-cidr', flags.sshCidr, 'allowedSshCidrs'],", to: "    ['--ssh-cidr', flags.sshCidr, 'allowedGatewayCidrs'],", test: 'tests/plan/network-args.test.ts tests/cli/plan.test.ts' },
  { name: 'publish-gateway accepts anything',
    file: 'src/plan/network-args.ts', from: "  if (v === 'loopback' || v === 'all') return v", to: "  return v as 'loopback' | 'all'; if (v === 'loopback' || v === 'all') return v", test: 'tests/plan/network-args.test.ts tests/cli/plan.test.ts' },
  { name: 'a plan that admits nobody says nothing about it',
    file: 'src/plan/validate.ts', from: "  if ((net.allowedSshCidrs ?? []).length === 0) {", to: '  if (false) {', test: 'tests/plan/network-validate.test.ts' },

  { name: 'the gcloud-configured project is ignored again',
    file: 'src/providers/gcp/preflight.ts', from: '    gcloudConfiguredProject() ??', to: '', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'a project under any INI section is accepted',
    file: 'src/providers/gcp/preflight.ts', from: "    if (section !== 'core') continue", to: '    if (false) continue', test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'a key merely ending in project matches',
    file: 'src/providers/gcp/preflight.ts', from: "    if (trimmed.slice(0, eq).trim() !== 'project') continue", to: "    if (!trimmed.slice(0, eq).trim().endsWith('project')) continue", test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'active_config is ignored and default assumed',
    file: 'src/providers/gcp/preflight.ts', from: "      readFileSync(path.join(dir, 'active_config'), 'utf-8').trim() ??", to: "      'default' ??", test: 'tests/providers/gcp/preflight.test.ts' },
  { name: 'the deploy no longer pins the GCP project it checked',
    file: 'src/plan/stack-config.ts', from: "    if (project) await stack.setConfig('gcp:project', { value: project })", to: '    void project', test: 'tests/plan/stack-config.test.ts' },
  { name: 'every provider gets a gcp project pinned',
    file: 'src/plan/stack-config.ts', from: "  if (plan.spec.provider === 'gcp') {", to: '  if (true) {', test: 'tests/plan/stack-config.test.ts' },

  { name: 'the workspace loses the state passphrase',
    file: 'src/pulumi/automation.ts', from: "        ...(passphrase ? { PULUMI_CONFIG_PASSPHRASE: passphrase } : {}),\n", to: '', test: 'tests/pulumi/automation.test.ts' },
  { name: 'clawops overrides the operator\'s own passphrase',
    file: 'src/pulumi/passphrase.ts', from: '  if (passphraseInEnvironment()) return undefined\n\n  const file', to: '  const file', test: 'tests/pulumi/passphrase.test.ts' },
  { name: 'a new passphrase is generated on every call',
    file: 'src/pulumi/passphrase.ts', from: '    if (stored !== \'\') return stored', to: "    if (false) return stored", test: 'tests/pulumi/passphrase.test.ts' },
  { name: 'the passphrase file is world-readable',
    file: 'src/pulumi/passphrase.ts', from: "mode: 0o600", to: 'mode: 0o644', test: 'tests/pulumi/passphrase.test.ts' },
  { name: 'the passphrase is used before it is saved',
    file: 'src/pulumi/passphrase.ts', from: "  writeFileSync(file, generated + '\\n', { encoding: 'utf-8', mode: 0o600 })\n  return generated", to: '  return generated', test: 'tests/pulumi/passphrase.test.ts' },
  { name: 'doctor creates the passphrase it is reporting on',
    file: 'src/pulumi/passphrase.ts', from: "  if (passphraseInEnvironment()) return 'environment'\n  return existsSync(passphrasePath(configDir)) ? 'stored' : 'absent'", to: "  if (passphraseInEnvironment()) return 'environment'\n  ensurePassphrase(configDir)\n  return 'stored'", test: 'tests/pulumi/passphrase.test.ts' },
  { name: 'apply stops sending the SSH public key',
    file: 'src/plan/stack-config.ts', from: "  await stack.setConfig('sshPublicKey', { value: sshPublicKey })\n", to: '', test: 'tests/plan/stack-config.test.ts' },
  { name: 'a plan with no key deploys an instance nobody can log into',
    file: 'src/plan/stack-config.ts', from: '  if (!sshPublicKey) {', to: '  if (false) {', test: 'tests/plan/stack-config.test.ts' },
  { name: 'the configured key is no longer a fallback',
    file: 'src/plan/stack-config.ts', from: '  const sshPublicKey = plan.spec.ssh?.publicKey ?? fallbackPublicKey()', to: '  const sshPublicKey = plan.spec.ssh?.publicKey', test: 'tests/plan/stack-config.test.ts' },
  { name: 'preview goes back to configuring a different stack than apply',
    file: 'src/plan/generate.ts', from: '    await writeStackConfig(stack, plan)', to: "    await stack.setConfig('instanceType', { value: instanceType })", test: 'tests/plan/generate.test.ts tests/plan/stack-config.test.ts' },
  { name: 'an empty .pub file is treated as the key',
    file: 'src/plan/ssh-key.ts', from: "    if (contents !== '') return contents", to: '    return contents', test: 'tests/plan/ssh-key.test.ts' },
  { name: 'doctor calls a readable key a usable one',
    file: 'src/diagnostics/index.ts', from: '    const parsed = ssh2.utils.parseKey(readFileSync(keyPath))', to: "    const parsed = { type: 'ssh-ed25519' } as never", test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'egress detection stops asking for text',
    file: 'src/providers/firewall.ts', from: "      headers: { accept: 'text/plain' },\n", to: '', test: 'tests/providers/firewall.test.ts' },
  { name: 'any response body is accepted as an IP',
    file: 'src/providers/firewall.ts', from: '    if (!isIpAddress(ip)) {', to: '    if (false) {', test: 'tests/providers/firewall.test.ts tests/plan/network-args.test.ts' },
  { name: 'an out-of-range octet is an address',
    file: 'src/providers/firewall.ts', from: '    return v.split(\'.\').every((o) => Number(o) <= 255)', to: '    return true', test: 'tests/providers/firewall.test.ts' },
  { name: 'the whole unexpected body is quoted back',
    file: 'src/providers/firewall.ts', from: '  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine', to: '  return oneLine', test: 'tests/providers/firewall.test.ts' },
  { name: 'preview resources are counted twice again',
    file: 'src/plan/generate.ts', from: '    if (seen.has(`${op}${urn}`)) continue', to: '    if (false) continue', test: 'tests/plan/generate.test.ts' },
  { name: 'a create and a delete of one resource collapse into one',
    file: 'src/plan/generate.ts', from: '    if (seen.has(`${op}${urn}`)) continue\n    seen.add(`${op}${urn}`)', to: '    if (seen.has(urn)) continue\n    seen.add(urn)', test: 'tests/plan/generate.test.ts' },

  { name: 'init generates a PKCS#8 key ssh2 cannot use again',
    file: 'src/cli/commands/init.ts', from: "['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'clawops', '-q']", to: "['-t', 'rsa', '-m', 'PKCS8', '-f', keyPath, '-N', '', '-C', 'clawops', '-q']", test: 'tests/cli/init.test.ts' },
  { name: 'a failed ssh-keygen is ignored and init reports success',
    file: 'src/cli/commands/init.ts', from: '      if (gen.error || gen.status !== 0) {', to: '      if (false) {', test: 'tests/cli/init.test.ts' },
  // Redirected, not unset. Unsetting it is the truer mutation and it is not worth running: the
  // suite would then write its fixtures — three stacks, a new default — straight into the
  // developer's own ~/.clawops. Running the mutation checker should not cost you your config.
  { name: 'the init suite stops isolating CLAWOPS_HOME',
    file: 'tests/cli/init.test.ts', from: "  process.env['CLAWOPS_HOME'] = suiteHome", to: "  process.env['CLAWOPS_HOME'] = `${suiteHome}-elsewhere`", test: 'tests/cli/init.test.ts' },

  { name: 'init overwrites the whole config again',
    file: 'src/cli/commands/init.ts', from: '    stacks: { ...(existing?.stacks ?? {}), [stackName]: stack },', to: '    stacks: { [stackName]: stack },', test: 'tests/cli/init.test.ts' },
  { name: 'init drops config outside stacks',
    file: 'src/cli/commands/init.ts', from: '    ...(existing ?? {}),\n', to: '', test: 'tests/cli/init.test.ts' },
  { name: 'an existing stack is silently overwritten',
    file: 'src/cli/commands/init.ts', from: '    if (existing?.stacks[stackName] && !forceOverwrite) {', to: '    if (false) {', test: 'tests/cli/init.test.ts' },
  { name: '--force is required to add a brand new stack',
    file: 'src/cli/commands/init.ts', from: '    if (existing?.stacks[stackName] && !forceOverwrite) {', to: '    if (existing && !forceOverwrite) {', test: 'tests/cli/init.test.ts' },
  { name: 'plan swallows an unregistered stack again',
    file: 'src/plan/generate.ts', from: '    if (err instanceof UsageError) throw err\n', to: '', test: 'tests/plan/generate.test.ts' },
  { name: 'plan rethrows every preview failure',
    file: 'src/plan/generate.ts', from: '    if (err instanceof UsageError) throw err', to: '    if (err) throw err', test: 'tests/plan/generate.test.ts' },

  { name: 'the plan emits the clawops alias instead of a machine type',
    file: 'src/plan/generate.ts', from: '  const instanceType = await resolveInstanceType(intent)', to: "  const instanceType = intent.instanceType ?? 'small'", test: 'tests/plan/generate.test.ts' },
  { name: 'a provider-native instance type is rewritten by the table',
    file: 'src/plan/generate.ts', from: '  if (!isInstanceAlias(requested)) {', to: '  if (false) {', test: 'tests/plan/generate.test.ts' },
  { name: 'an unknown size is passed through in silence',
    file: 'src/plan/generate.ts', from: "      `[clawops] note: \"${requested}\" is not a clawops size ` +", to: "      `` +", test: 'tests/plan/generate.test.ts' },
  { name: 'every size normalises to the same machine',
    file: 'src/plan/generate.ts', from: '  return adapter.normalizeInstanceType(requested)', to: "  return adapter.normalizeInstanceType('small')", test: 'tests/plan/generate.test.ts' },

  { name: 'plan reaches through the lazily-loaded context proxy again',
    file: 'src/plan/generate.ts', from: '  const adapter = await loadAdapterModule(intent.provider as ProviderName)', to: '  const adapter = buildContext({ stack: intent.stackName, provider: intent.provider }).adapter', test: 'tests/plan/generate.test.ts' },

  { name: 'the registry hands back the wrong cloud',
    file: 'src/providers/index.ts', from: '  const adapter = registry.get(name)', to: "  const adapter = registry.get('gcp' as ProviderName)", test: 'tests/cli/context.test.ts tests/plan/generate.test.ts' },
  { name: 'the context hands back a lazily-loaded proxy again',
    file: 'src/cli/context.ts', from: '    return getProvider(name)', to: "    return { name } as unknown as ProviderAdapter", test: 'tests/cli/context.test.ts' },
  { name: 'adapters are no longer registered at import',
    file: 'src/cli/context.ts', from: "import '../providers/register.js'\n", to: '', test: 'tests/cli/context.test.ts' },
  { name: 'an unknown provider resolves to something',
    file: 'src/cli/context.ts', from: '  } catch {\n    throw new UsageError(\n      `Provider "${name}" is not yet supported.', to: '  } catch {\n    return getProvider(\'gcp\') ?? new UsageError(\n      `Provider "${name}" is not yet supported.', test: 'tests/cli/context.test.ts' },

  { name: 'apply reports success without waiting for the host',
    file: 'src/plan/apply.ts', from: '  const readySession = await waitForSsh(conn, {', to: '  const readySession = { close() {}, exec: async () => ({ stdout: \'running\', stderr: \'\', code: 0 }) } as never; void waitForSsh; if (false) await waitForSsh(conn, {', test: 'tests/plan/apply.test.ts' },
  { name: 'the readiness wait gives up on the first refusal',
    file: 'src/transport/wait.ts', from: '      if (!isTransient(lastError)) {', to: '      if (true) {', test: 'tests/transport/wait.test.ts' },
  { name: 'a wrong key is retried until the deadline',
    file: 'src/transport/wait.ts', from: '      if (!isTransient(lastError)) {', to: '      if (false) {', test: 'tests/transport/wait.test.ts' },
  { name: 'the wait spins without pausing',
    file: 'src/transport/wait.ts', from: '    await sleep(intervalMs, opts.signal)', to: '    await sleep(0, opts.signal)', test: 'tests/transport/wait.test.ts' },
  { name: 'an aborted signal is ignored',
    file: 'src/transport/wait.ts', from: "    if (opts.signal?.aborted) throw new NetworkError('Waiting for SSH was aborted')", to: '    void opts.signal', test: 'tests/transport/wait.test.ts' },
  { name: 'the signal never reaches the connection attempt',
    file: 'src/transport/wait.ts', from: '      const session = await connect({ ...conn, signal: opts.signal })', to: '      const session = await connect({ ...conn })', test: 'tests/transport/wait.test.ts' },
  { name: 'the wait announces itself on every attempt',
    file: 'src/transport/wait.ts', from: '      if (attempts === 1) {', to: '      if (true) {', test: 'tests/transport/wait.test.ts' },
  { name: 'authentication failures are treated as permanent',
    file: 'src/transport/wait.ts', from: "  'All configured authentication methods failed',\n", to: '', test: 'tests/transport/wait.test.ts' },

  { name: 'apply builds a connection with no key again',
    file: 'src/plan/apply.ts', from: "    privateKeyPath: expandHome(ctx.config.ssh.keyPath),", to: "    privateKeyPath: '',", test: 'tests/plan/apply.test.ts' },
  { name: 'apply loses the known_hosts path',
    file: 'src/plan/apply.ts', from: "    knownHostsPath: expandHome(ctx.config.ssh.knownHostsPath),", to: "    knownHostsPath: '',", test: 'tests/plan/apply.test.ts' },
  { name: 'a ~ in a configured path is passed to ssh2 verbatim',
    file: 'src/plan/apply.ts', from: "  return p.replace(/^~/, process.env['HOME'] ?? '~')", to: '  return p', test: 'tests/plan/apply.test.ts' },

  { name: 'apply reports success before the gateway answers',
    file: 'src/plan/apply.ts', from: '    await waitForGateway(readySession, {', to: '    if (false) await waitForGateway(readySession, {', test: 'tests/plan/apply.test.ts' },
  { name: 'a running container is accepted as a working gateway',
    file: 'src/openclaw/ready.ts', from: '      if (verdict.ok) return { waitedMs: now() - started, lastContainerStatus }', to: '      return { waitedMs: now() - started, lastContainerStatus }', test: 'tests/openclaw/ready.test.ts' },
  { name: 'the readiness probe ignores the container state',
    file: 'src/openclaw/ready.ts', from: "    if (lastContainerStatus === 'running') {", to: '    if (true) {', test: 'tests/openclaw/ready.test.ts' },
  { name: 'the gateway wait never times out',
    file: 'src/openclaw/ready.ts', from: '    if (now() + intervalMs >= deadline) {', to: '    if (false) {', test: 'tests/openclaw/ready.test.ts' },
  { name: 'the timeout no longer says what the container was doing',
    file: 'src/openclaw/ready.ts', from: '          `Container: ${lastContainerStatus}. Last check: ${lastReason}.` +', to: '          `` +', test: 'tests/openclaw/ready.test.ts' },
  { name: 'the readiness session is leaked',
    file: 'src/plan/apply.ts', from: '    readySession.close()', to: '    void readySession', test: 'tests/plan/apply.test.ts' },
  { name: 'apply opens a second connection instead of reusing the proven one',
    file: 'src/plan/apply.ts', from: '  const readySession = await waitForSsh(conn, {', to: "  const { connect: reconnect } = await import('../transport/ssh.js'); const readySession = await waitForSsh(conn, {", test: 'tests/plan/apply.test.ts' },
  { name: 'the wait closes the session it proved with',
    file: 'src/transport/wait.ts', from: '      if (attempts > 1) opts.onProgress?.(`SSH is up after ${attempts} attempts.`)\n      return session', to: '      if (attempts > 1) opts.onProgress?.(`SSH is up after ${attempts} attempts.`)\n      session.close()\n      return session', test: 'tests/transport/wait.test.ts' },
  { name: 'the gateway is probed on the default port whatever the plan says',
    file: 'src/plan/apply.ts', from: '      port: plan.spec.network?.gatewayPort ?? GATEWAY_PORT,', to: '      port: GATEWAY_PORT,', test: 'tests/plan/apply.test.ts' },
  { name: 'the gateway wait runs before SSH is up',
    file: 'src/plan/apply.ts', from: '  const readySession = await waitForSsh(conn, {\n    signal: opts?.signal,\n    onProgress: (line) => reportProgress(opts, line),\n  })\n', to: '  const readySession = { close() {}, exec: async () => ({ stdout: \'running\', stderr: \'\', code: 0 }) } as never\n', test: 'tests/plan/apply.test.ts' },
  { name: 'progress is reported on every poll',
    file: 'src/openclaw/ready.ts', from: '    if (elapsed - announcedAt >= 30_000 || announcedAt === 0) {', to: '    if (true) {', test: 'tests/openclaw/ready.test.ts' },

  { name: 'progress is folded back into the Pulumi output stream',
    file: 'src/plan/apply.ts', from: '  if (opts?.onProgress) opts.onProgress(line)\n  else opts?.onOutput?.(line)', to: '  opts?.onOutput?.(line)', test: 'tests/plan/apply.test.ts' },
  { name: 'a caller with only onOutput stops seeing progress',
    file: 'src/plan/apply.ts', from: '  else opts?.onOutput?.(line)', to: '', test: 'tests/plan/apply.test.ts' },

  { name: 'destroy leaves a stale host key behind',
    file: 'src/cli/commands/destroy.ts', from: '      const removed = forgetHost(', to: '      const removed = false && forgetHost(', test: 'tests/cli/destroy.test.ts' },
  { name: 'the host is read after the instance is gone',
    file: 'src/cli/commands/destroy.ts', from: '    const doomedHost = await hostOf(stack, ctx)\n', to: '', test: 'tests/cli/destroy.test.ts' },
  { name: 'a ~ in the known_hosts path is passed through',
    file: 'src/cli/commands/destroy.ts', from: "  return p.replace(/^~/, process.env['HOME'] ?? '~')", to: '  return p', test: 'tests/cli/destroy.test.ts' },
  { name: 'forgetting a host takes every other host with it',
    file: 'src/transport/known-hosts.ts', from: '    if (entry && entryMatchesHost(entry, hostEntry)) continue', to: '    if (entry) continue', test: 'tests/transport/known-hosts.test.ts' },
  { name: 'the port is ignored when forgetting a host',
    file: 'src/transport/known-hosts.ts', from: '  const hostEntry = hostEntryFor(host, port)\n  const kept', to: '  const hostEntry = hostEntryFor(host, 22)\n  const kept', test: 'tests/transport/known-hosts.test.ts' },
  { name: 'a host-key mismatch is reported in ssh2 jargon again',
    file: 'src/transport/ssh.ts', from: '  if (!/host.*(denied|verification)/i.test(message)) {', to: '  if (true) {', test: 'tests/transport/known-hosts.test.ts' },
  { name: 'the mismatch advice drops the caveat',
    file: 'src/transport/ssh.ts', from: "    'If you did not expect this address to change hands, do not connect.'", to: "    ''", test: 'tests/transport/known-hosts.test.ts' },
  { name: 'a rewritten error stops being recognised as retryable',
    file: 'src/transport/ssh.ts', from: '    return `SSH connection failed: ${message}`', to: '    return `SSH failed: ${message}`', test: 'tests/transport/known-hosts.test.ts' },

  { name: 'azure refuses an `az login` again',
    file: 'src/providers/azure/index.ts', from: '    const hasCliLogin = Boolean(azureCliAccount())', to: '    const hasCliLogin = false', test: 'tests/providers/azure/adapter.test.ts' },
  { name: 'a logged-out CLI profile counts as a credential',
    file: 'src/providers/azure/cli-auth.ts', from: '  if (!chosen) return undefined', to: '  if (!chosen) return { subscriptionId: \'\', name: \'\' }', test: 'tests/providers/azure/cli-auth.test.ts tests/providers/azure/adapter.test.ts' },
  { name: 'the BOM the Azure CLI writes is left in place',
    file: 'src/providers/azure/cli-auth.ts', from: "    parsed = JSON.parse(body.replace(/^\\uFEFF/, ''))", to: '    parsed = JSON.parse(body)', test: 'tests/providers/azure/cli-auth.test.ts' },
  { name: 'the default subscription flag is ignored',
    file: 'src/providers/azure/cli-auth.ts', from: "  const chosen = entries.find((s) => s['isDefault'] === true) ?? entries[0]", to: '  const chosen = entries[0]', test: 'tests/providers/azure/cli-auth.test.ts' },
  { name: 'ARM_SUBSCRIPTION_ID stops taking precedence',
    file: 'src/providers/azure/cli-auth.ts', from: "    process.env['ARM_SUBSCRIPTION_ID'] ??\n", to: '', test: 'tests/providers/azure/cli-auth.test.ts' },
  { name: 'AZURE_CONFIG_DIR is ignored',
    file: 'src/providers/azure/cli-auth.ts', from: "  const explicit = process.env['AZURE_CONFIG_DIR']\n  if (explicit) return explicit\n", to: '', test: 'tests/providers/azure/cli-auth.test.ts tests/providers/azure/adapter.test.ts' },
  { name: 'doctor --provider is ignored and the config decides',
    file: 'src/diagnostics/index.ts', from: "  if (provider) return [await providerCredentialCheck(provider, 'requested with --provider')]", to: '', test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'doctor --provider reports a failure as a pass',
    file: 'src/diagnostics/index.ts', from: "      ? { name: provider, status: 'pass', detail: why }\n      : { name: provider, status: 'fail', detail: result.errors.join('; ') }", to: "      ? { name: provider, status: 'pass', detail: why }\n      : { name: provider, status: 'pass', detail: result.errors.join('; ') }", test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'the doctor command drops the --provider flag',
    file: 'src/cli/commands/doctor.ts', from: "        provider: typeof args.provider === 'string' ? args.provider : undefined,\n", to: '', test: 'tests/cli/doctor.test.ts tests/diagnostics/doctor.test.ts' },

  { name: 'azure stops checking resource providers',
    file: 'src/providers/azure/index.ts', from: '    return azurePreflight(opts)', to: '    return []', test: 'tests/providers/azure/adapter.test.ts tests/providers/azure/preflight.test.ts' },
  { name: 'an unregistered provider is reported as ready',
    file: 'src/providers/azure/preflight.ts', from: "    const registered = state === 'Registered'", to: '    const registered = true', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'a failed registration lookup counts as registered',
    file: 'src/providers/azure/preflight.ts', from: '    if (!res.ok) return undefined\n    const body = (await res.json()) as { registrationState?: unknown }', to: "    if (!res.ok) return 'Registered'\n    const body = (await res.json()) as { registrationState?: unknown }", test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'the register fix posts to the wrong namespace',
    file: 'src/providers/azure/preflight.ts', from: '            fix: () => register(subscriptionId, provider.namespace, token, opts.signal),', to: "            fix: () => register(subscriptionId, 'Microsoft.Compute', token, opts.signal),", test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'a fix is offered without saying what it changes',
    file: 'src/providers/azure/preflight.ts', from: '            mutates: `Registers the ${provider.namespace} resource provider on subscription ${subscriptionId}`,\n', to: '', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'the state backend is judged on the account alone',
    file: 'src/providers/azure/preflight.ts', from: '  const ok = Boolean(account) && hasSecret', to: '  const ok = Boolean(account)', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'a SAS token is no longer accepted for the state backend',
    file: 'src/providers/azure/preflight.ts', from: "    process.env['AZURE_STORAGE_KEY'] ?? process.env['AZURE_STORAGE_SAS_TOKEN'],", to: "    process.env['AZURE_STORAGE_KEY'],", test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'the state backend check is skipped when the API is unreachable',
    file: 'src/providers/azure/preflight.ts', from: '  checks.push(stateBackendCheck(opts.bucket))\n', to: '', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'preflight runs on without a subscription',
    file: 'src/providers/azure/preflight.ts', from: '  if (!subscriptionId) return checks', to: '  if (!subscriptionId) { void 0 }', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'a service principal is ignored in favour of spawning az',
    file: 'src/providers/azure/preflight.ts', from: '  if (tenantId && clientId && clientSecret) {', to: '  if (false) {', test: 'tests/providers/azure/preflight.test.ts' },

  { name: 'an unavailable VM size is reported as available',
    file: 'src/providers/azure/preflight.ts', from: '  if (available.has(requested)) {', to: '  if (true) {', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'a failed SKU listing counts as availability',
    file: 'src/providers/azure/preflight.ts', from: '  if (!available) {', to: '  if (false) {', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'restricted SKUs are treated as usable',
    file: 'src/providers/azure/preflight.ts', from: '        .filter((s) => !Array.isArray(s.restrictions) || s.restrictions.length === 0)\n', to: '', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'disks and other resource types are offered as VM sizes',
    file: 'src/providers/azure/preflight.ts', from: "        .filter((s) => s.resourceType === 'virtualMachines')\n", to: '', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'the SKU query stops filtering by location',
    file: 'src/providers/azure/preflight.ts', from: "      `?api-version=2021-07-01&$filter=${encodeURIComponent(`location eq '${location}'`)}`", to: "      `?api-version=2021-07-01`", test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'the size suggestions are unbounded',
    file: 'src/providers/azure/preflight.ts', from: '    .slice(0, 4)', to: '', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'any size is suggested as an alternative, whatever its shape',
    file: 'src/providers/azure/preflight.ts', from: "    .filter((n) => /[^0-9]2[a-z]*(_v\\d+)?$/.test(n))\n", to: '', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'preflight stops checking the VM size',
    file: 'src/providers/azure/preflight.ts', from: '  if (opts.region) {', to: '  if (false) {', test: 'tests/providers/azure/preflight.test.ts tests/providers/azure/adapter.test.ts' },

  { name: 'the doctor command drops the --instance-type flag',
    file: 'src/cli/commands/doctor.ts', from: "        instanceType:\n          typeof args['instance-type'] === 'string' ? args['instance-type'] : undefined,\n", to: '', test: 'tests/cli/doctor.test.ts' },
  { name: 'account checks stop passing the size along',
    file: 'src/diagnostics/index.ts', from: '    const results = await adapter.preflight({ region: stackCfg?.region, bucket, instanceType })', to: '    const results = await adapter.preflight({ region: stackCfg?.region, bucket })', test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'the size check ignores the size it was given',
    file: 'src/providers/azure/preflight.ts', from: '        opts.instanceType,\n', to: '', test: 'tests/providers/azure/preflight.test.ts' },

  { name: 'a timeout stops carrying the bootstrap log',
    file: 'src/openclaw/ready.ts', from: '      const tail = await bootstrapTail(session, 12, opts.signal)', to: '      const tail = undefined', test: 'tests/openclaw/ready.test.ts' },
  { name: 'the diagnostic throws over the real error',
    file: 'src/openclaw/ready.ts', from: '  } catch {\n    return undefined\n  }\n}\n\nexport async function waitForGateway', to: '  } catch (err) {\n    throw err\n  }\n}\n\nexport async function waitForGateway', test: 'tests/openclaw/ready.test.ts' },
  { name: 'an empty bootstrap log is reported as content',
    file: 'src/openclaw/ready.ts', from: "    return text === '' ? undefined : text", to: '    return text', test: 'tests/openclaw/ready.test.ts' },
  { name: 'only cloud-init is consulted, never the startup-script unit',
    file: 'src/openclaw/ready.ts', from: "    `journalctl -u google-startup-scripts --no-pager 2>/dev/null | tail -n ${lines}) | tail -n ${lines}`", to: "    `true) | tail -n ${lines}`", test: 'tests/openclaw/ready.test.ts' },

  { name: 'a refused docker inspect is reported as a missing container',
    file: 'src/openclaw/docker.ts', from: '  if (saysNoSuchObject(text)) return { kind: \'missing\' }', to: "  if (true) return { kind: 'missing' }", test: 'tests/openclaw/docker.test.ts tests/openclaw/ready.test.ts' },
  { name: 'the probe masks its failure with a shell fallback again',
    file: 'src/openclaw/docker.ts', from: '    `${dockerCmd} inspect ${name} --format \'${format}\'`,', to: "    `${dockerCmd} inspect ${name} --format '${format}' 2>/dev/null || echo 'not found'`,", test: 'tests/openclaw/docker.test.ts' },
  { name: 'the probe stops escalating to sudo',
    file: 'src/openclaw/docker.ts', from: '  const result = await execPrivileged(', to: '  const result = await session.exec(', test: 'tests/openclaw/docker.test.ts' },
  { name: 'containerStatus reports an unanswerable question as not found',
    file: 'src/openclaw/docker.ts', from: "  return { status: 'unknown', error: result.detail }", to: "  return { status: 'not found' }", test: 'tests/openclaw/docker.test.ts tests/openclaw/ready.test.ts' },
  { name: 'the gateway wait keeps polling through a refusal',
    file: 'src/openclaw/ready.ts', from: '    if (container.error) {', to: '    if (false) {', test: 'tests/openclaw/ready.test.ts' },
  { name: 'doctor calls an unaskable container missing',
    file: 'src/diagnostics/index.ts', from: '    container.error\n      ? {', to: '    false\n      ? {', test: 'tests/diagnostics/doctor.test.ts' },

  { name: 'a host still installing docker fails the deploy',
    file: 'src/openclaw/ready.ts', from: '      if (!looksLikeStillBooting(container.error)) {', to: '      if (true) {', test: 'tests/openclaw/ready.test.ts' },
  { name: 'a permanent refusal is waited out instead of raised',
    file: 'src/openclaw/ready.ts', from: '      if (!looksLikeStillBooting(container.error)) {', to: '      if (false) {', test: 'tests/openclaw/ready.test.ts' },
  { name: 'a refusal is classified as still booting',
    file: 'src/openclaw/docker.ts', from: "    text.includes('command not found') ||", to: "    text.includes('permission denied') ||\n    text.includes('command not found') ||", test: 'tests/openclaw/docker.test.ts tests/openclaw/ready.test.ts' },
  { name: 'a missing docker binary is no longer recognised',
    file: 'src/openclaw/docker.ts', from: "    text.includes('command not found') ||\n", to: '', test: 'tests/openclaw/docker.test.ts tests/openclaw/ready.test.ts' },
  { name: 'the wait stops saying why docker could not be asked',
    file: 'src/openclaw/ready.ts', from: '        ? `docker could not be asked yet: ${container.error}`', to: "        ? 'waiting'", test: 'tests/openclaw/ready.test.ts' },

  { name: 'up goes back to writing its own stack config',
    file: 'src/cli/commands/up.ts', from: '      const result = await applyPlan(plan, {', to: '      const result = { outputs: {} } as never; void applyPlan; if (false) await applyPlan(plan, {', test: 'tests/cli/up.test.ts' },
  { name: 'up applies on a dry run',
    file: 'src/cli/commands/up.ts', from: '      if (isDryRun) {', to: '      if (false) {', test: 'tests/cli/up.test.ts' },
  { name: 'up ignores --no-wait',
    file: 'src/cli/commands/up.ts', from: "        skipReadiness: Boolean(args['no-wait']),", to: '        skipReadiness: false,', test: 'tests/cli/up.test.ts' },
  { name: 'up always skips the readiness waits',
    file: 'src/cli/commands/up.ts', from: "        skipReadiness: Boolean(args['no-wait']),", to: '        skipReadiness: true,', test: 'tests/cli/up.test.ts' },
  { name: 'up drops the network flags',
    file: 'src/cli/commands/up.ts', from: '          network,\n', to: '', test: 'tests/cli/up.test.ts' },
  { name: 'up ignores --gateway-port for cloud stacks',
    file: 'src/cli/commands/up.ts', from: '    if (cloudGatewayPort) network.gatewayPort = parseGatewayPort(cloudGatewayPort)', to: '    void cloudGatewayPort', test: 'tests/cli/up.test.ts' },
  { name: 'up deploys without checking credentials',
    file: 'src/cli/commands/up.ts', from: '    if (!validation.ok) {', to: '    if (false) {', test: 'tests/cli/up.test.ts' },
  { name: 'skipReadiness is ignored by apply',
    file: 'src/plan/apply.ts', from: '  if (opts?.skipReadiness) {', to: '  if (false) {', test: 'tests/plan/apply.test.ts tests/cli/up.test.ts' },
  { name: 'the MCP up tool writes its own stack config again',
    file: 'src/mcp/tools/cli/up.ts', from: '    const result = await applyPlan(plan, {', to: '    const result = { outputs: {} } as never; void applyPlan; if (false) await applyPlan(plan, {', test: 'tests/mcp/ops.test.ts' },
  { name: 'the MCP up tool applies on a dry run',
    file: 'src/mcp/tools/cli/up.ts', from: '    if (input.dryRun) {', to: '    if (false) {', test: 'tests/mcp/ops.test.ts' },

  { name: 'the azure subscription is left to the environment',
    file: 'src/plan/stack-config.ts', from: "    if (subscription) await stack.setConfig('azure-native:subscriptionId', { value: subscription })", to: '    void subscription', test: 'tests/plan/stack-config.test.ts' },
  { name: 'every provider gets an azure subscription pinned',
    file: 'src/plan/stack-config.ts', from: "  if (plan.spec.provider === 'azure') {", to: '  if (true) {', test: 'tests/plan/stack-config.test.ts' },

  { name: 'the logs probe launders a refusal into a word again',
    file: 'src/openclaw/logs.ts', from: "export const GATEWAY_LOGS_PROBE = 'docker exec openclaw openclaw logs --limit 1 >/dev/null'", to: "export const GATEWAY_LOGS_PROBE = 'docker exec openclaw openclaw logs --limit 1 >/dev/null 2>&1 && echo ok || echo no'", test: 'tests/openclaw/logs.test.ts' },
  { name: 'the logs source is decided by stdout rather than the exit code',
    file: 'src/cli/commands/logs.ts', from: '      const choice = chooseLogSource({ since, gatewayReachable: probe.code === 0 })', to: "      const choice = chooseLogSource({ since, gatewayReachable: probe.stdout?.trim() === 'ok' })", test: 'tests/cli/logs.test.ts' },
  { name: 'every gateway probe is treated as reachable',
    file: 'src/cli/commands/logs.ts', from: '      const choice = chooseLogSource({ since, gatewayReachable: probe.code === 0 })', to: '      const choice = chooseLogSource({ since, gatewayReachable: true })', test: 'tests/cli/logs.test.ts' },

  { name: 'an unopenable state backend becomes a warning again',
    file: 'src/plan/generate.ts', from: '    throw new StateError(\n      `Cannot open the state backend', to: '    process.stderr.write(`warn`); stack = undefined as never; void new StateError(\n      `Cannot open the state backend', test: 'tests/plan/generate.test.ts' },
  { name: 'a failed preview becomes fatal',
    file: 'src/plan/generate.ts', from: "    process.stderr.write(\n      `[clawops] Warning: preview failed", to: '    if (true) throw err; process.stderr.write(\n      `[clawops] Warning: preview failed', test: 'tests/plan/generate.test.ts' },
  { name: 'the backend error reports Pulumi\'s exit code instead of the cause',
    file: 'src/plan/generate.ts', from: '  const explained = lines.find((l) => /(^|\\s)error:/i.test(l))', to: '  const explained = undefined as string | undefined', test: 'tests/plan/generate.test.ts' },

  { name: 'aws stops checking its account setup',
    file: 'src/providers/aws/index.ts', from: '    return awsPreflight(opts)', to: '    return []', test: 'tests/providers/aws/adapter.test.ts' },
  { name: 'a bucket that is merely denied is offered a fix that cannot work',
    file: 'src/providers/aws/preflight.ts', from: "            ...(result.reason === 'missing'", to: "            ...(result.reason !== 'nope'", test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'a missing bucket is reported as present',
    file: 'src/providers/aws/preflight.ts', from: '      result.ok\n        ? { id:', to: '      true\n        ? { id:', test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'the state bucket is created without versioning',
    file: 'src/providers/aws/preflight.ts', from: '  await client.send(\n    new PutBucketVersioningCommand({', to: '  if (false) await client.send(\n    new PutBucketVersioningCommand({', test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'the state bucket is created open to the public',
    file: 'src/providers/aws/preflight.ts', from: '  await client.send(\n    new PutPublicAccessBlockCommand({', to: '  if (false) await client.send(\n    new PutPublicAccessBlockCommand({', test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'us-east-1 gets a location constraint it rejects',
    file: 'src/providers/aws/preflight.ts', from: "      ...(region === 'us-east-1'", to: "      ...(region === 'nowhere'", test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'preflight continues without credentials',
    file: 'src/providers/aws/preflight.ts', from: '  if (!account) return checks', to: '  if (!account) { void 0 }', test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'an unofferable instance type is reported as fine',
    file: 'src/providers/aws/preflight.ts', from: '          ok: offering.offered,', to: '          ok: true,', test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'an unaskable instance type check is reported as a failure',
    file: 'src/providers/aws/preflight.ts', from: "    'error' in offering", to: '    false', test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'the instance type check ignores the size it was given',
    file: 'src/providers/aws/preflight.ts', from: '  const instanceType = opts.instanceType ?? INSTANCE_TYPE_MAP[DEFAULT_ALIAS]', to: '  const instanceType = INSTANCE_TYPE_MAP[DEFAULT_ALIAS]', test: 'tests/providers/aws/preflight.test.ts' },

  { name: 'an unaskable check sinks the whole report',
    file: 'src/diagnostics/index.ts', from: "      status: r.unknown ? ('warn' as const) : r.ok ? ('pass' as const) : ('fail' as const),", to: "      status: r.ok ? ('pass' as const) : ('fail' as const),", test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'an unaskable check is reported as a pass',
    file: 'src/diagnostics/index.ts', from: "      status: r.unknown ? ('warn' as const) : r.ok ? ('pass' as const) : ('fail' as const),", to: "      status: r.unknown ? ('pass' as const) : r.ok ? ('pass' as const) : ('fail' as const),", test: 'tests/diagnostics/doctor.test.ts' },
  { name: 'the aws check stops saying what it could not ask',
    file: 'src/providers/aws/preflight.ts', from: "            `clawops could not ask EC2 whether ${instanceType} is offered in ${region}: ` +\n            `${offering.error}. This says nothing about the instance type — the usual cause `", to: "            `` +\n            ``", test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'an unaskable aws check claims the type is offered',
    file: 'src/providers/aws/preflight.ts', from: "          ok: false,\n          unknown: true,", to: '          ok: true,\n          unknown: true,', test: 'tests/providers/aws/preflight.test.ts' },
  { name: 'azure treats an unlistable size as a hard failure again',
    file: 'src/providers/azure/preflight.ts', from: '      ok: false,\n      unknown: true,', to: '      ok: false,', test: 'tests/providers/azure/preflight.test.ts' },
  { name: 'the wizard checks the provider default instead of the size just chosen',
    file: 'src/cli/commands/setup.ts', from: '      instanceType: opts.instanceType,\n', to: '', test: 'tests/cli/setup-preflight.test.ts' },
  { name: 'the wizard counts a question it could not ask as a failure',
    file: 'src/cli/commands/setup.ts', from: '  const failed = checks.filter((c) => !c.ok && !c.unknown)', to: '  const failed = checks.filter((c) => !c.ok)', test: 'tests/cli/setup-preflight.test.ts' },
  { name: 'the wizard calls an account ready without saying what it could not check',
    file: 'src/cli/commands/setup.ts', from: '        ? `${opts.provider} account is ready, as far as clawops could tell.`', to: '        ? `${opts.provider} account is ready.`', test: 'tests/cli/setup-preflight.test.ts' },
  { name: 'an S3 name drops the region, so one bucket serves every region',
    file: 'src/providers/state-bucket.ts', from: '  return { ok: true, name: `clawops-state-${scope.account}-${scope.region}` }', to: '  return { ok: true, name: `clawops-state-${scope.account}` }', test: 'tests/providers/state-bucket.test.ts tests/cli/init.test.ts' },
  { name: 'an Azure container gets a discriminator it does not need',
    file: 'src/providers/state-bucket.ts', from: "    return { ok: true, name: 'clawops-state' }", to: '    return { ok: true, name: `clawops-state-${scope.account ?? "x"}` }', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'a missing account is papered over instead of reported',
    file: 'src/providers/state-bucket.ts', from: '  if (!scope.account) {', to: '  if (false) {', test: 'tests/providers/state-bucket.test.ts tests/cli/init.test.ts' },
  { name: 'the azblob URL grows the state prefix only the bucket backends take',
    file: 'src/providers/state-bucket.ts', from: "  return provider === 'azure' ? `${scheme}${bucket}` : `${scheme}${bucket}/clawops`", to: '  return `${scheme}${bucket}/clawops`', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'S3 stops rejecting the prefixes and suffixes AWS reserves',
    file: 'src/providers/state-bucket.ts', from: "    if (n.startsWith('xn--')) return 'Cannot start with \"xn--\"'", to: '    if (false) return \'\'', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'GCS stops rejecting the name Cloud Storage reserves',
    file: 'src/providers/state-bucket.ts', from: "  if (n.includes('google')) return 'Cannot contain \"google\"'", to: '  if (false) return \'\'', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'an Azure container accepts doubled hyphens',
    file: 'src/providers/state-bucket.ts', from: '    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) {', to: '    if (!/^[a-z0-9-]+$/.test(n)) {', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'the length ceiling stops being enforced',
    file: 'src/providers/state-bucket.ts', from: '  if (n.length > max) return', to: '  if (false) return', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'init writes a stack it could not name a backend for',
    file: 'src/cli/commands/init.ts', from: '        if (!derived.ok) {', to: '        if (false) {', test: 'tests/cli/init.test.ts' },
  { name: 'the wizard suggests a bucket name ignoring the region just chosen',
    file: 'src/cli/commands/setup.ts', from: '        region: answers.region ?? defaultRegion(provider),', to: '        region: defaultRegion(provider),', test: 'tests/cli/setup-preflight.test.ts' },
  { name: 'a state URL is built from an unchecked name',
    file: 'src/providers/state-bucket.ts', from: '  if (verdict !== true) throw new Error', to: '  if (false) throw new Error', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'the dotted Cloud Storage allowance leaks to every name',
    file: 'src/providers/state-bucket.ts', from: "  const dotted = provider === 'gcp' && n.includes('.')", to: '  const dotted = true', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'a dotted Cloud Storage name skips the per-part cap',
    file: 'src/providers/state-bucket.ts', from: '  if (dotted && n.split(\'.\').some((part) => part.length > 63)) {', to: '  if (false) {', test: 'tests/providers/state-bucket.test.ts' },
  { name: 'the manifest sync writes only one of the two version fields',
    file: 'scripts/sync-server-json.mjs', from: 'server.packages[0].version = version', to: 'void version', test: 'tests/release/server-manifest.test.ts' },
  { name: 'the manifest sync stops writing the file',
    file: 'scripts/sync-server-json.mjs', from: 'writeFileSync(serverPath,', to: 'void 0; void (', test: 'tests/release/server-manifest.test.ts' },
  { name: 'the GCP firewall audit stops looking at IPv6',
    file: 'src/harden/modules/gcp-firewall-audit.ts', from: "const WORLD = new Set(['0.0.0.0/0', '::/0'])", to: "const WORLD = new Set(['0.0.0.0/0'])", test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'the GCP firewall audit exempts the ports it exists to check',
    file: 'src/harden/modules/gcp-firewall-audit.ts', from: "    const named = NAMED_PORTS[p]", to: '    const named = undefined', test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'the GCP firewall audit reads disabled rules as live',
    file: 'src/harden/modules/gcp-firewall-audit.ts', from: '    if (fw.disabled) continue', to: '    if (false) continue', test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'an unreadable firewall passes instead of skipping',
    file: 'src/harden/modules/gcp-firewall-audit.ts', from: '    if (!body) {', to: '    if (false) {', test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'shielded VM stops reporting a missing protection',
    file: 'src/harden/modules/gcp-shielded-vm.ts', from: '  if (!s.integrityMonitoring) out.push', to: '  if (false) out.push', test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'OS Login being enabled is reported as fine',
    file: 'src/harden/modules/gcp-os-login.ts', from: '    return enabled', to: '    return false', test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'OS Login becomes on by default, so the wizard pre-checks it',
    file: 'src/harden/modules/gcp-os-login.ts', from: '  defaultOn: false,', to: '  defaultOn: true,', test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'the firewall audit matches the project name instead of the network name',
    file: 'src/harden/modules/gcp-firewall-audit.ts', from: "    if (!networkName(fw.network ?? '').startsWith('clawops-')) continue", to: "    if (!(fw.network ?? '').includes('clawops')) continue", test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'the instance lookup demands an exact name Pulumi never uses',
    file: 'src/harden/gcp-api.ts', from: "  return typeof name === 'string' && name.startsWith('clawops-instance')", to: "  return name === 'clawops-instance'", test: 'tests/harden/gcp-modules.test.ts' },
  { name: 'the preview parser goes back to dropping replacements',
    file: 'src/plan/generate.ts', from: "const PREVIEW_LINE_RE = /^(\\+-|-\\+|[+~-])", to: "const PREVIEW_LINE_RE = /^([+~-])", test: 'tests/plan/disruption.test.ts' },
  { name: 'a replacement is counted as a create',
    file: 'src/plan/generate.ts', from: "    if (op === '+-' || op === '-+') replace.push(ref)", to: "    if (false) replace.push(ref)", test: 'tests/plan/disruption.test.ts' },
  { name: 'the plan stops warning that a replacement destroys the disk',
    file: 'src/cli/commands/plan.ts', from: '  if (replaced.length > 0) {', to: '  if (false) {', test: 'tests/plan/disruption.test.ts' },
  { name: 'the plan stops warning that an update stops the machine',
    file: 'src/cli/commands/plan.ts', from: '  if (diff.update.length > 0) {', to: '  if (false) {', test: 'tests/plan/disruption.test.ts' },
  { name: 'secure boot is left to the GCP default again',
    file: 'src/providers/gcp/program.ts', from: '      enableSecureBoot: true,', to: '      enableSecureBoot: false,', test: 'tests/providers/gcp' },

]

let survived = []
let caught = 0

// A mutation is a temporary edit to a real source file, and this process was killed mid-run
// once — the OS reclaiming memory — leaving `if (false)` in src/openclaw/ready.ts. Only the
// next run noticed, and only because the anchor it wanted had been mutated out from under it.
// The file was untracked, so it did not even show up in `git diff`.
//
// Signal handlers are not enough on their own for two reasons: SIGKILL cannot be caught, and
// the loop spends its life inside a synchronous execSync, where a queued handler cannot run
// until the child exits. So the original is written to a sentinel file BEFORE the source is
// touched, and the next run restores from it. The handlers stay for the ordinary Ctrl-C case.
const SENTINEL = new URL('./.mutation-inflight.json', import.meta.url)

/** A lock beside the sentinel, so a second run cannot start on top of a live one. */
const LOCK = new URL('./.mutation-lock.json', import.meta.url)

function beginMutation(file, original) {
  writeFileSync(SENTINEL, JSON.stringify({ file, original }), 'utf8')
}

/**
 * Refuse to start while another run holds the lock.
 *
 * Two runs mutating the same files at once restore each other's originals in the wrong order
 * and leave live mutations in the working tree. That happened: a run left `parseKey(...)`
 * replaced with a stub and a `'fail'` status flipped to `'pass'` in src/diagnostics/index.ts,
 * and reported a result computed against a corrupted tree. The vitest guard catches a test run
 * started during a mutation; nothing caught a second mutation run.
 *
 * A lock whose owning process is gone is stale and gets cleared, so a killed run does not need
 * manual cleanup.
 */
function acquireLock() {
  if (existsSync(LOCK)) {
    const { pid, started } = JSON.parse(readFileSync(LOCK, 'utf8'))
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { alive = false }
    if (alive) {
      console.error(
        `A mutation check is already running (pid ${pid}, started ${started}).\n` +
        'Two runs mutate the same files and leave residue in the working tree. Wait for it, ' +
        `or kill it and delete ${LOCK.pathname}.`,
      )
      process.exit(1)
    }
    console.log('  cleared a stale lock from a run that is no longer alive\n')
    rmSync(LOCK)
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), 'utf8')
  const release = () => { if (existsSync(LOCK)) rmSync(LOCK) }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130) })
}

function endMutation() {
  if (existsSync(SENTINEL)) rmSync(SENTINEL)
}

/** Put back whatever a killed run left mutated, before doing anything else. */
function restoreFromSentinel() {
  if (!existsSync(SENTINEL)) return
  const { file, original } = JSON.parse(readFileSync(SENTINEL, 'utf8'))
  writeFileSync(file, original)
  rmSync(SENTINEL)
  console.log(`  restored ${file} — a previous run was killed while it was mutated\n`)
}

let inFlight = null

function restoreInFlight() {
  if (!inFlight) return
  writeFileSync(inFlight.file, inFlight.original)
  inFlight = null
  endMutation()
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restoreInFlight()
    process.exit(130)
  })
}
process.on('exit', restoreInFlight)
process.on('uncaughtException', (err) => {
  restoreInFlight()
  throw err
})

acquireLock()
restoreFromSentinel()

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  if (!original.includes(m.from)) {
    survived.push({ ...m, why: 'ANCHOR NOT FOUND — mutation could not be applied' })
    continue
  }
  inFlight = { file: m.file, original }
  beginMutation(m.file, original)
  writeFileSync(m.file, original.replace(m.from, m.to))
  let failed = false
  try {
    execSync(`npx vitest run ${m.test} --reporter=dot 2>&1`, { stdio: 'pipe' })
  } catch {
    failed = true   // the suite noticed
  }
  restoreInFlight()
  if (failed) { caught++; console.log(`  caught   ${m.name}`) }
  else { survived.push({ ...m, why: 'no test failed' }); console.log(`  SURVIVED ${m.name}`) }
}

console.log(`\n  ${caught}/${MUTATIONS.length} mutations caught`)
if (survived.length) {
  console.log('\n  Unguarded behaviour:')
  for (const s of survived) console.log(`    - ${s.name}  (${s.why})`)
  process.exitCode = 1
}
