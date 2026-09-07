#!/usr/bin/env node
// Normalise the schema emitted by `openclaw config schema` so it can be compiled.
//
// Upstream inlines each plugin's config schema into the parent document but does not
// hoist that plugin's `$defs`, nor rewrite the pointers inside it. The result is a
// document whose refs are root-relative (`#/$defs/account`) while the definitions live
// several levels down, under the plugin that owns them. Verified on 2026.9.1: 9 refs,
// 7 distinct targets, root `$defs` absent entirely, and ajv refuses it with
// "can't resolve reference #/$defs/account from id #".
//
// Each ref is rebased onto the NEAREST ANCESTOR that defines it, rather than hoisting
// everything to a shared root `$defs`. On 2026.9.1 the shared names (`secretRef`,
// `secretInput`) happen to be byte-identical between the imap and webhooks plugins, so
// hoisting would also work today — but it would silently merge them the first time a
// release makes them differ, and each plugin's refs would start resolving to the other
// plugin's shape. Nearest-ancestor cannot do that.
//
// Idempotent: running it on already-normalised output changes nothing.

import { readFileSync, writeFileSync } from 'node:fs'

const REF_PREFIX = '#/$defs/'

/** JSON Pointer escaping, per RFC 6901. */
const escape = (seg) => seg.replace(/~/g, '~0').replace(/\//g, '~1')

export function normalise(doc) {
  const rewrites = []
  const unresolved = []

  // Walk with the full ancestor chain so we can find the closest enclosing $defs.
  const walk = (node, path, ancestors) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}/${i}`, ancestors))
      return
    }

    const chain = [...ancestors, { node, path }]

    const ref = node['$ref']
    if (typeof ref === 'string' && ref.startsWith(REF_PREFIX)) {
      const name = ref.slice(REF_PREFIX.length)
      // Nearest first: walk the ancestor chain from the inside out.
      const owner = [...chain].reverse().find(
        (a) => a.node['$defs'] && Object.hasOwn(a.node['$defs'], name),
      )
      if (owner) {
        const target = `${owner.path === '' ? '#' : `#${owner.path}`}/$defs/${escape(name)}`
        rewrites.push({ from: ref, to: target, at: path })
        node['$ref'] = target
      } else {
        unresolved.push({ ref, at: path })
      }
    }

    for (const key of Object.keys(node)) {
      if (key === '$ref') continue
      walk(node[key], `${path}/${escape(key)}`, chain)
    }
  }

  walk(doc, '', [])
  return { doc, rewrites, unresolved }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.filename === process.argv[1]) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.error('usage: normalise-schema.mjs <raw-schema.json> <out.json>')
    process.exit(2)
  }

  const { doc, rewrites, unresolved } = normalise(JSON.parse(readFileSync(input, 'utf8')))

  for (const r of rewrites) console.error(`  rebased ${r.from} -> ${r.to}`)

  if (unresolved.length > 0) {
    // Refusing here is the point: a ref we cannot place means upstream changed the
    // shape of the bug, and guessing would produce a schema that compiles but
    // validates the wrong thing.
    console.error(`\n${unresolved.length} ref(s) could not be resolved to any ancestor $defs:`)
    for (const u of unresolved) console.error(`  ${u.ref} at ${u.at}`)
    process.exit(1)
  }

  writeFileSync(output, JSON.stringify(doc) + '\n')
  console.error(`\n  ${rewrites.length} ref(s) rebased -> ${output}`)
}
