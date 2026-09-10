#!/usr/bin/env node
// Does each test actually guard the behaviour it claims to?
//
// Backported from the clawops 2.x line with only the mutations for what v1.7.8 changed —
// the rest target code that does not exist on this branch.
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
    file: 'src/cli/mcp-wire.ts', from: '  await session.exec(`${OC} reload`, signal)', to: '  void OC', test: 'tests/cli/mcp-wire.test.ts' },
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
  { name: 'a 1.x release stops taking latest while latest is still 1.x',
    file: 'scripts/lib/dist-tag-plan.mjs', from: '  if (latestMajor > majorOf(version)) {', to: '  if (latestMajor >= majorOf(version)) {', test: 'tests/scripts/dist-tag-plan.test.ts tests/release' },
  { name: 'a 1.x release takes latest back from 2.x',
    file: 'scripts/lib/dist-tag-plan.mjs', from: '  if (latestMajor > majorOf(version)) {', to: '  if (false) {', test: 'tests/scripts/dist-tag-plan.test.ts tests/release' },
  { name: 'an unreadable latest is treated as this line',
    file: 'scripts/lib/dist-tag-plan.mjs', from: '  if (latestMajor === undefined) {', to: '  if (false) {', test: 'tests/scripts/dist-tag-plan.test.ts' },
  { name: 'main starts publishing under legacy',
    file: 'scripts/lib/dist-tag-plan.mjs', from: "  if (branch !== '1.x') {", to: '  if (false) {', test: 'tests/scripts/dist-tag-plan.test.ts tests/release' },
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
