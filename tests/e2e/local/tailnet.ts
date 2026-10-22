// A real tailnet for the fleet e2e suite: Headscale on the suite's Docker network, Tailscale on
// the systemd targets as a host runs it, and tailnet nodes that are not fleet hosts (callers).
//
// Tailscale's binaries come from its own image at a pinned version rather than its install
// script, which installs whatever is newest: the version is the one SP-14 to SP-16 measured.

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GenericContainer } from 'testcontainers'
import type { StartedNetwork, StartedTestContainer } from 'testcontainers'
import type { VmTarget } from './vm-container.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HEADSCALE_IMAGE = 'headscale/headscale:v0.27.1'
export const TAILSCALE_IMAGE = 'tailscale/tailscale:v1.88.3'
export const BASE_DOMAIN = 'fleet.test'

async function until<T>(what: string, attempt: () => Promise<T | undefined>, seconds = 60): Promise<T> {
  for (let i = 0; i < seconds; i++) {
    const v = await attempt()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${what} did not happen within ${seconds} s`)
}

export interface HeadscaleNode { id: string; name: string; tags: string[]; ips: string[] }

export interface Headscale {
  container: StartedTestContainer
  /** A reusable auth key for the suite's one user, with these tags. */
  key: (tags?: string[]) => Promise<string>
  setPolicy: (policy: unknown) => Promise<void>
  node: (hostname: string) => Promise<HeadscaleNode>
  /** Replace a node's tags, as an operator retags a host in the admin console. */
  retag: (hostname: string, tags: string[]) => Promise<void>
}

export async function startHeadscale(network: StartedNetwork): Promise<Headscale> {
  const container = await new GenericContainer(HEADSCALE_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('hs')
    .withCopyFilesToContainer([
      { source: path.join(HERE, 'tailnet/headscale.yaml'), target: '/etc/headscale/config.yaml' },
      { source: path.join(HERE, 'tailnet/derp.yaml'), target: '/etc/headscale/derp.yaml' },
    ])
    .withCommand(['serve'])
    .start()
  // The image has no shell, so readiness is a CLI call that succeeds.
  const hs = async (...args: string[]) => {
    const r = await container.exec(['headscale', ...args])
    if (r.exitCode !== 0) throw new Error(`headscale ${args.join(' ')}: ${r.output}`)
    return r.stdout.trim()
  }
  await until('Headscale answering', async () => ((await container.exec(['headscale', 'users', 'list'])).exitCode === 0 ? true : undefined))
  await hs('users', 'create', 'op')

  const nodes = async (): Promise<HeadscaleNode[]> => {
    const listed = JSON.parse(await hs('nodes', 'list', '-o', 'json')) as Array<{ id: number; given_name?: string; name?: string; tags?: string[]; forced_tags?: string[]; valid_tags?: string[]; ip_addresses?: string[] }>
    return listed.map((n) => ({
      id: String(n.id),
      name: n.given_name ?? n.name ?? '',
      tags: n.tags ?? [...(n.forced_tags ?? []), ...(n.valid_tags ?? [])],
      ips: n.ip_addresses ?? [],
    }))
  }
  const node = async (hostname: string) => until(`${hostname} in Headscale`, async () => (await nodes()).find((n) => n.name === hostname))

  return {
    container,
    key: async (tags = []) => (await hs('preauthkeys', 'create', '--user', '1', '--reusable', '--expiration', '4h', ...(tags.length ? ['--tags', tags.join(',')] : []))).split('\n').at(-1)!,
    setPolicy: async (policy) => {
      await container.copyContentToContainer([{ content: JSON.stringify(policy), target: '/var/lib/headscale/policy.json' }])
      await hs('policy', 'set', '-f', '/var/lib/headscale/policy.json')
    },
    node,
    retag: async (hostname, tags) => {
      const n = await node(hostname)
      await hs('nodes', 'tag', '-i', n.id, ...tags.flatMap((t) => ['-t', t]))
    },
  }
}

let binaries: { tailscale: string; tailscaled: string } | undefined

/** Tailscale's two binaries, copied out of its image once per run. */
export function tailscaleBinaries(): { tailscale: string; tailscaled: string } {
  if (binaries) return binaries
  const dir = mkdtempSync(path.join(tmpdir(), 'clawops-e2e-tailscale-'))
  const id = execFileSync('docker', ['create', TAILSCALE_IMAGE], { encoding: 'utf-8' }).trim()
  try {
    for (const b of ['tailscale', 'tailscaled']) execFileSync('docker', ['cp', `${id}:/usr/local/bin/${b}`, path.join(dir, b)])
  } finally {
    execFileSync('docker', ['rm', id])
  }
  binaries = { tailscale: path.join(dir, 'tailscale'), tailscaled: path.join(dir, 'tailscaled') }
  return binaries
}

/** The unit Tailscale's Debian package installs, with the paths it uses. */
const TAILSCALED_UNIT = `[Unit]
Description=Tailscale node agent
Wants=network-pre.target
After=network-pre.target NetworkManager.service systemd-resolved.service

[Service]
ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=41641
ExecStopPost=/usr/sbin/tailscaled --cleanup
Restart=on-failure
RuntimeDirectory=tailscale
RuntimeDirectoryMode=0755
StateDirectory=tailscale
StateDirectoryMode=0700
CacheDirectory=tailscale
CacheDirectoryMode=0750
Type=notify

[Install]
WantedBy=multi-user.target
`

async function waitRunning(run: (cmd: string) => Promise<{ stdout: string }>, what: string): Promise<{ ips: string[] }> {
  return until(`${what} on the tailnet`, async () => {
    const out = (await run('tailscale status --json --peers=false 2>/dev/null')).stdout
    try {
      const s = JSON.parse(out.slice(out.indexOf('{'))) as { BackendState?: string; Self?: { TailscaleIPs?: string[] } }
      return s.BackendState === 'Running' && s.Self?.TailscaleIPs?.length ? { ips: s.Self.TailscaleIPs } : undefined
    } catch {
      return undefined
    }
  }, 90)
}

/** Install tailscaled on a systemd target as the package does, and join it under this hostname. */
export async function joinHost(vm: VmTarget, key: string, hostname: string): Promise<{ ips: string[] }> {
  const bin = tailscaleBinaries()
  await vm.container.copyFilesToContainer([
    { source: bin.tailscale, target: '/usr/bin/tailscale', mode: 0o755 },
    { source: bin.tailscaled, target: '/usr/sbin/tailscaled', mode: 0o755 },
  ])
  await vm.container.copyContentToContainer([{ content: TAILSCALED_UNIT, target: '/etc/systemd/system/tailscaled.service', mode: 0o644 }])
  const r = await vm.inspect('systemctl daemon-reload && systemctl enable --now tailscaled')
  if (r.exitCode !== 0) throw new Error(`tailscaled: ${r.stdout}`)
  // --accept-dns=false, as `clawops harden` leaves a host: peers are found without MagicDNS.
  const up = await vm.inspect(`tailscale up --login-server=http://hs:8080 --auth-key=${key} --hostname=${hostname} --accept-dns=false`)
  if (up.exitCode !== 0) throw new Error(`tailscale up on ${hostname}: ${up.stdout}`)
  return waitRunning((c) => vm.inspect(c), hostname)
}

/** One POST from inside a container or host: prints `{status, body}`, or `{status: 'ERR', code}`. */
export const POST_SCRIPT = `
const [url, body] = process.argv.slice(2)
fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body, signal: AbortSignal.timeout(15000) })
  .then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.text() })))
  .catch((e) => console.log(JSON.stringify({ status: 'ERR', code: String(e.cause?.code ?? e.name) })))
`

export interface PostResult { status: number | 'ERR'; body?: string; code?: string }

export function toolCall(name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
}

function lastJson(out: string): PostResult {
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)
  if (!line) throw new Error(`no answer line in: ${out}`)
  return JSON.parse(line) as PostResult
}

export interface Caller {
  container: StartedTestContainer
  ips: string[]
  post: (url: string, body: string) => Promise<PostResult>
}

/**
 * A node on the suite's Docker network with Node.js to make requests. With a key it joins the
 * tailnet as `hostname`; without one it is only a LAN neighbour of the fleet hosts.
 */
export async function startCaller(network: StartedNetwork, hostname: string, key?: string): Promise<Caller> {
  const bin = tailscaleBinaries()
  const container = await new GenericContainer('node:22-alpine')
    .withNetwork(network)
    .withHostname(hostname)
    // tailscaled in kernel mode makes a TUN device and routes; the neighbour adds a route.
    .withPrivilegedMode()
    .withCopyFilesToContainer([
      { source: bin.tailscale, target: '/usr/local/bin/tailscale', mode: 0o755 },
      { source: bin.tailscaled, target: '/usr/local/bin/tailscaled', mode: 0o755 },
    ])
    .withCopyContentToContainer([{ content: POST_SCRIPT, target: '/post.mjs' }])
    .withCommand(['sh', '-c', key ? 'mkdir -p /var/lib/tailscale /run/tailscale && exec tailscaled --state=/var/lib/tailscale/s --socket=/run/tailscale/tailscaled.sock' : 'exec sleep infinity'])
    .start()
  const run = async (cmd: string) => {
    const r = await container.exec(['sh', '-c', cmd])
    return { stdout: r.output, exitCode: r.exitCode }
  }
  let ips: string[] = []
  if (key) {
    await until('tailscaled in the caller', async () => ((await run('tailscale status --json >/dev/null 2>&1; test -S /run/tailscale/tailscaled.sock')).exitCode === 0 ? true : undefined))
    // No netfilter: a caller needs none, and the image has no iptables.
    const up = await run(`tailscale up --login-server=http://hs:8080 --auth-key=${key} --hostname=${hostname} --accept-dns=false --netfilter-mode=off`)
    if (up.exitCode !== 0) throw new Error(`tailscale up on ${hostname}: ${up.stdout}`)
    ips = (await waitRunning(run, hostname)).ips
  }
  return {
    container,
    ips,
    post: async (url, body) => lastJson((await container.exec(['node', '/post.mjs', url, body])).output),
  }
}

/** The same POST from a fleet host, as clawops-peer or as root, with the host agent's Node. */
export async function postFromHost(vm: VmTarget, url: string, body: string, as: 'clawops-peer' | 'root'): Promise<PostResult> {
  const b64 = Buffer.from(POST_SCRIPT).toString('base64')
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const run = as === 'root' ? '' : 'runuser -u clawops-peer -- '
  const r = await vm.inspect(`echo ${b64} | base64 -d > /tmp/post.mjs && chmod 0644 /tmp/post.mjs && ${run}/opt/clawops-agent/node/bin/node /tmp/post.mjs ${q(url)} ${q(body)}`)
  return lastJson(r.stdout)
}

export function peerUrl(ip: string, port: number): string {
  return `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}/`
}
