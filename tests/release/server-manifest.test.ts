// The MCP registry manifest carries its own copy of the version. It used to be rewritten in CI
// moments before registering and never committed, so the registry was right and the file in the
// repo was wrong: it read 1.7.3 against a published 2.0.2, five releases behind, and misled the
// check that eventually found it.
//
// It is bumped at version time now, inside the Version Packages PR. These tests are what stops
// it drifting again, because nothing else reads the file until a release is already happening.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const read = (f: string) => JSON.parse(readFileSync(resolve(root, f), 'utf8'))

describe('the committed MCP server manifest', () => {
  it('carries the version package.json does', () => {
    const pkg = read('package.json')
    const server = read('server.json')
    expect(server.version).toBe(pkg.version)
    expect(server.packages[0].version).toBe(pkg.version)
  })

  /*
   * The registry entry and the npm listing are two shop windows onto one product, and they had
   * drifted into saying different things — neither of them mentioning MCP, which is half of what
   * this is and the word someone searching the registry would type.
   */
  it('describes the package the same way npm does', () => {
    expect(read('server.json').description).toBe(read('package.json').description)
  })

  /*
   * The registry rejects a longer description with a 422, and it does so at publish time — after
   * npm has already published, since that step runs first. A 110-character description shipped
   * exactly that way: npm got 2.1.0, the registry refused it, and the entry stayed on 1.2.1 for
   * one more release. The limit is asserted here so the next one fails in seconds instead.
   */
  it('keeps the description inside the registry\'s 100-character limit', () => {
    expect(read('server.json').description.length).toBeLessThanOrEqual(100)
  })

  it('names the package that is actually published', () => {
    expect(read('server.json').packages[0].identifier).toBe(read('package.json').name)
  })
})

describe('the release pipeline keeps it in step', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')

  it('bumps it at version time rather than at publish time', () => {
    expect(workflow).toContain('version: pnpm version:packages')
    expect(read('package.json').scripts['version:packages']).toContain('sync-server-json')
  })

  /*
   * A backfill dispatch runs in the same job as changesets' `version`, which leaves the working
   * tree bumped to the next version. Reading it registered a version npm had never published.
   */
  it('registers the committed version, not the one changesets is preparing', () => {
    const yml = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
    const step = yml.slice(yml.indexOf('Publish to MCP Registry'))
    expect(step).toContain('git checkout HEAD -- package.json server.json')
    expect(step.indexOf('git checkout HEAD -- package.json server.json'))
      .toBeLessThan(step.indexOf("require('./package.json').version"))
  })

  it('refuses to publish a manifest that disagrees, instead of rewriting it', () => {
    // The old step edited the file in place during publish, which is exactly how it drifted.
    expect(workflow).not.toMatch(/fs\.writeFileSync\("server\.json"/)
    expect(workflow).toMatch(/server\.json says/)
  })
})

describe('the sync script', () => {
  it('writes package.json\'s version into both places, and is idempotent', () => {
    const before = readFileSync(resolve(root, 'server.json'), 'utf8')
    try {
      const stale = JSON.parse(before)
      stale.version = '0.0.0-stale'
      stale.packages[0].version = '0.0.0-stale'
      writeFileSync(resolve(root, 'server.json'), `${JSON.stringify(stale, null, 2)}\n`)

      execFileSync('node', ['scripts/sync-server-json.mjs'], { cwd: root, stdio: 'pipe' })
      const once = readFileSync(resolve(root, 'server.json'), 'utf8')
      expect(JSON.parse(once).version).toBe(read('package.json').version)
      expect(JSON.parse(once).packages[0].version).toBe(read('package.json').version)

      execFileSync('node', ['scripts/sync-server-json.mjs'], { cwd: root, stdio: 'pipe' })
      expect(readFileSync(resolve(root, 'server.json'), 'utf8')).toBe(once)
    } finally {
      writeFileSync(resolve(root, 'server.json'), before)
    }
  })

  it('leaves the rest of the manifest alone', () => {
    const before = read('server.json')
    execFileSync('node', ['scripts/sync-server-json.mjs'], { cwd: root, stdio: 'pipe' })
    const after = read('server.json')
    for (const key of ['name', 'title', 'description', 'websiteUrl', 'repository', '$schema']) {
      expect(after[key]).toEqual(before[key])
    }
    expect(after.packages[0].packageArguments).toEqual(before.packages[0].packageArguments)
    expect(after.packages[0].transport).toEqual(before.packages[0].transport)
  })
})
