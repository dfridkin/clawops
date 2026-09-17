#!/usr/bin/env node
/**
 * Run the package a user would install, not the one in this directory.
 *
 * 2.0.1 shipped an import Node's ESM loader refuses — `@pulumi/pulumi/automation`, a bare
 * directory specifier that resolves only under CommonJS rules. tsx and vitest apply those rules,
 * so 1669 tests, a mutation run and three clouds end to end all passed against source while
 * every cloud command in the published build died on its first import. Nothing in the repo ran
 * the published build.
 *
 * This packs the tarball, installs it somewhere else, and runs the commands whose whole job is
 * to reach the code the bundler treats as external. Anything that only imports our own modules
 * proves nothing here — `--version` passed on 2.0.1.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const work = mkdtempSync(path.join(tmpdir(), 'clawops-verify-pack-'))
const home = path.join(work, 'home')

/** Each must exercise a dependency the bundle leaves external, and must not need credentials. */
const CASES = [
  { argv: ['--version'], expect: /\b\d+\.\d+\.\d+\b/, what: 'the binary starts' },
  { argv: ['doctor', '--json'], expect: /"sections"/, what: 'doctor loads Pulumi and reports' },
  { argv: ['plan', '--help'], expect: /--ssh-cidr/, what: 'plan resolves its module graph' },
  { argv: ['stacks'], expect: /./, what: 'config and provider registry load' },
]

let failed = 0
try {
  console.log('packing…')
  execFileSync('pnpm', ['build'], { cwd: REPO, stdio: 'inherit' })
  execFileSync('npm', ['pack', '--pack-destination', work], { cwd: REPO, stdio: 'inherit' })
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('npm pack produced no tarball')

  console.log(`installing ${tgz} into a scratch tree…`)
  execFileSync('npm', ['init', '-y'], { cwd: work, stdio: 'ignore' })
  execFileSync('npm', ['install', '--no-save', '--silent', path.join(work, tgz)], {
    cwd: work, stdio: 'inherit',
  })

  const bin = path.join(work, 'node_modules', '.bin', 'clawops')
  for (const { argv, expect, what } of CASES) {
    const r = spawnSync(bin, argv, {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, CLAWOPS_HOME: home },
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    // A resolution failure is the shape this exists to catch, and it does not always exit non-zero.
    const unresolved = /Directory import|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.exec(out)
    const ok = !unresolved && expect.test(out)
    console.log(`  ${ok ? '✓' : '✗'} clawops ${argv.join(' ')} — ${what}`)
    if (!ok) {
      failed += 1
      console.log(`      ${(unresolved?.[0] ? out.slice(out.indexOf(unresolved[0])) : out).trim().split('\n').slice(0, 4).join('\n      ')}`)
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed against the packed tarball. This is what users install.`)
  process.exit(1)
}
console.log('\nthe packed tarball runs.')
