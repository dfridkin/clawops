#!/usr/bin/env node
/**
 * Coupling report from a local Graphify graph — the same question the PR bot answers, asked
 * here so the answer arrives before the push rather than after it.
 *
 * Extraction runs `--code-only`, which is local AST only: no API key, no LLM call, no cost. The
 * hosted bot also runs semantic extraction, so its fan-out numbers sit a little above these.
 * The ranking is the same, and the delta below — which is the part worth acting on — is exact.
 *
 *   node scripts/dev/graph.mjs                  fan-out for src/, worst first
 *   node scripts/dev/graph.mjs --base main      how this working tree changed it
 *
 * `--base` is the one that settles an argument. A report that says a function is a hotspot is
 * not the same claim as "this branch made it one", and a bot comparing against the wrong
 * baseline will report every function in a touched file as newly coupled.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const OUT = path.join(REPO, 'graphify-out')
/** Edges that mean "this function reaches that one". `contains` is structure, not coupling. */
const REACHES = new Set(['calls', 'indirect_call', 'method', 'imports_from'])

const args = process.argv.slice(2)
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : undefined
const top = Number(args.includes('--top') ? args[args.indexOf('--top') + 1] : 15)

if (spawnSync('graphify', ['--help'], { stdio: 'ignore' }).error) {
  console.error(
    'graphify is not installed. It is the open-source engine behind the PR bot:\n' +
    '  uv tool install graphifyy\n' +
    'Nothing else in this repo depends on it; this script is the only caller.',
  )
  process.exit(127)
}

/** Extract a tree and return { "file::label" → distinct callees }. */
function fanout(tree, outDir) {
  const r = spawnSync('graphify',
    ['extract', tree, '--code-only', '--no-cluster', '--out', outDir],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  if (r.status !== 0) throw new Error(`graphify extract failed for ${tree}`)

  const graph = JSON.parse(readFileSync(path.join(outDir, 'graphify-out', 'graph.json'), 'utf8'))
  const reach = new Map()
  for (const e of graph.edges) {
    if (!REACHES.has(e.relation)) continue
    if (!reach.has(e.source)) reach.set(e.source, new Set())
    reach.get(e.source).add(e.target)
  }
  const out = new Map()
  for (const n of graph.nodes) {
    const file = (n.source_file ?? '').replace(`${tree}/`, '')
    if (!file.startsWith('src/') || !(n.label ?? '').endsWith('()')) continue
    const key = `${file}::${n.label}`
    out.set(key, Math.max(out.get(key) ?? 0, reach.get(n.id)?.size ?? 0))
  }
  return out
}

const head = fanout(REPO, REPO)

if (!base) {
  console.log(`\nFan-out across src/ — ${head.size} functions, worst first\n`)
  const rows = [...head].sort((a, b) => b[1] - a[1]).slice(0, top)
  const w = Math.max(...rows.map(([k]) => k.split('::')[1].length))
  for (const [key, n] of rows) {
    const [file, label] = key.split('::')
    console.log(`  ${String(n).padStart(3)}  ${label.padEnd(w)}  ${file}`)
  }
  console.log('\nRun with --base <ref> to see which of these this branch actually changed.\n')
  process.exit(0)
}

// A worktree, not a stash: the working tree stays exactly as it is while the baseline is read.
const tmp = mkdtempSync(path.join(tmpdir(), 'clawops-graph-'))
const tree = path.join(tmp, 'base')
try {
  execFileSync('git', ['worktree', 'add', '-q', '--detach', tree, base], { cwd: REPO })
  const before = fanout(tree, tmp)

  const grew = []
  for (const [key, after] of head) {
    const prior = before.get(key)
    if (prior === undefined) { if (after > 0) grew.push([key, null, after]); continue }
    if (after > prior) grew.push([key, prior, after])
  }
  grew.sort((a, b) => (b[2] - (b[1] ?? 0)) - (a[2] - (a[1] ?? 0)))

  console.log(`\nFan-out this working tree added, against ${base}\n`)
  if (grew.length === 0) {
    console.log('  nothing — no function in src/ reaches more than it did.\n')
  } else {
    for (const [key, prior, after] of grew) {
      const [file, label] = key.split('::')
      const delta = prior === null ? `new, ${after}` : `${prior} → ${after}`
      console.log(`  ${label.padEnd(30)} ${String(delta).padStart(10)}   ${file}`)
    }
    console.log(
      '\n  A function that only appears here as "new" is new to this branch. Anything else was\n' +
      '  already what it is — a hotspot this branch did not create is not this branch\'s finding.\n',
    )
  }
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: REPO, stdio: 'ignore' })
  rmSync(tmp, { recursive: true, force: true })
}
if (existsSync(OUT)) { /* left in place: the next run reuses its extraction cache */ }
