#!/usr/bin/env node
/**
 * Put package.json's version into server.json, at version time.
 *
 * The MCP registry submission needs server.json to carry the version being published. That
 * rewrite used to happen in CI, in the publish step, moments before registering, and was never
 * committed — so the registry was always right and the committed file was always behind. It read
 * `1.7.3` against a published `2.0.2` for five releases, and misled a check that went looking.
 *
 * Running it here, from the `version:packages` script, puts the bump in the Version Packages PR
 * next to the one in package.json, where it is reviewed with everything else. No push to a
 * protected branch is needed, which is what made the CI-side fix awkward in the first place.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const serverPath = path.join(root, 'server.json')

const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (typeof version !== 'string' || version === '') {
  console.error('package.json has no version'); process.exit(1)
}

const server = JSON.parse(readFileSync(serverPath, 'utf8'))
const before = [server.version, server.packages?.[0]?.version]

server.version = version
if (!Array.isArray(server.packages) || server.packages.length === 0) {
  console.error('server.json has no packages[] to version'); process.exit(1)
}
server.packages[0].version = version

writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`)

const changed = before.some((v) => v !== version)
console.log(
  changed
    ? `server.json: ${before[0]} -> ${version}`
    : `server.json: already ${version}`,
)
