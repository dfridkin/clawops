#!/usr/bin/env node
// Every in-repo Markdown link points at something that exists.
//
// Four links in docs/ pointed at `#recovering-from-an-archive`, a section that had been renamed.
// Nothing noticed, because nothing reads the docs the way a reader does: following the links.
// A renamed heading is the common case — the prose around the link still reads correctly, so
// review sees nothing wrong, and the reader lands at the top of the page instead of the answer.
//
// Checks relative links between repo Markdown files and their `#anchors`. External URLs are
// not fetched: a link checker that hits the network fails for reasons that have nothing to do
// with the commit under test.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const roots = ['docs', '.claude'].map((d) => path.join(root, d))
const singles = ['README.md', 'SPEC.md', 'DESIGN_RULES.md'].map((f) => path.join(root, f))

/** GitHub's heading → anchor rule: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
}

function markdownFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full))
    else if (entry.endsWith('.md') || entry.endsWith('.mdx')) out.push(full)
  }
  return out
}

/** Anchors a file offers: its headings, plus any explicit `id="…"`/`<a name="…">`. */
const anchorCache = new Map()
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file)
  const set = new Set()
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf-8')
    for (const line of text.split('\n')) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line)
      if (heading) set.add(slug(heading[1]))
    }
    for (const m of text.matchAll(/(?:name|id)="([^"]+)"/g)) set.add(m[1])
  }
  anchorCache.set(file, set)
  return set
}

const files = [...roots.flatMap(markdownFiles), ...singles.filter(existsSync)]
const problems = []

for (const file of files) {
  const text = readFileSync(file, 'utf-8')
  // Skip fenced code: a shell comment mentioning a path is not a link.
  const body = text.replace(/```[\s\S]*?```/g, '')
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (/^(https?:|mailto:|#!)/.test(target)) continue

    const [rawPath, anchor] = target.split('#')
    const resolved = rawPath === '' ? file : path.resolve(path.dirname(file), rawPath)
    const where = path.relative(root, file)

    if (rawPath !== '' && !existsSync(resolved)) {
      problems.push(`${where}: → ${target} (no such file)`)
      continue
    }
    if (!anchor) continue
    // Only Markdown carries headings; a link into a .ts file's line number is not ours to check.
    if (!/\.mdx?$/.test(resolved)) continue
    if (!anchorsOf(resolved).has(anchor)) {
      problems.push(`${where}: → ${target} (no heading "${anchor}" in ${path.basename(resolved)})`)
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} broken doc link(s):\n`)
  for (const p of problems) console.error(`  ${p}`)
  console.error('\nA renamed heading leaves the prose reading correctly and the link going nowhere.')
  process.exit(1)
}
console.log(`doc links ok — ${files.length} files checked`)
