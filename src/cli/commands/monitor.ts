import { defineCommand } from 'citty'
import process from 'node:process'
import { chalk, failure } from '../../output/human.js'
import type { SshSession } from '../../transport/ssh.js'

const GATEWAY_PORT = 18789

// ─── Snapshot types and helpers ───────────────────────────────────────────────

export interface MonitorSnapshot {
  container: {
    status: string
    image: string
    startedAt: string
    restartCount: number
    memUsage: string
    cpuPct: string
  }
  gateway: {
    reachable: boolean
    version: string
    authMode: string
  }
  disk: string
  logLines: string[]
  capturedAt: Date
}

export function formatUptime(startedAt: string): string {
  if (!startedAt) return '—'
  const ms = Date.now() - new Date(startedAt).getTime()
  if (ms < 0 || isNaN(ms)) return '—'
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h ${mins % 60}m`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m ${totalSecs % 60}s`
}

export async function gatherSnapshot(
  session: SshSession,
  signal: AbortSignal,
  tailLines = 10,
): Promise<MonitorSnapshot> {
  const [inspectRaw, statsRaw, healthRaw, configRaw, diskRaw, logsRaw] = await Promise.all([
    session.exec(
      `docker inspect openclaw --format '{{.State.Status}}|{{.Config.Image}}|{{.State.StartedAt}}|{{.RestartCount}}' 2>/dev/null || echo 'not found|||0'`,
      signal,
    ),
    session.exec(
      `docker stats openclaw --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}' 2>/dev/null || echo '—|—'`,
      signal,
    ),
    session.exec(
      `curl -sf --connect-timeout 2 http://localhost:${GATEWAY_PORT}/health >/dev/null 2>&1 && echo ok || echo unreachable`,
      signal,
    ),
    session.exec(
      `cat /home/clawops/openclaw.json 2>/dev/null || echo '{}'`,
      signal,
    ),
    session.exec(
      `df -h /home/clawops 2>/dev/null | awk 'NR==2{print $5" used ("$3" of "$2")"}'`,
      signal,
    ),
    session.exec(
      `docker logs openclaw -n ${tailLines} 2>&1 || echo '(no logs)'`,
      signal,
    ),
  ])

  const inspectParts = inspectRaw.stdout.trim().split('|')
  const status = inspectParts[0] ?? 'not found'
  const image = inspectParts[1] ?? ''
  const startedAt = inspectParts[2] ?? ''
  const restartCount = parseInt(inspectParts[3] ?? '0', 10) || 0

  const statsParts = statsRaw.stdout.trim().split('|')
  const memUsage = statsParts[0] ?? '—'
  const cpuPct = statsParts[1] ?? '—'

  let version = 'unknown'
  let authMode = 'unknown'
  try {
    const cfg = JSON.parse(configRaw.stdout.trim()) as {
      meta?: { lastTouchedVersion?: string }
      gateway?: { auth?: { mode?: string } }
    }
    version = cfg.meta?.lastTouchedVersion ?? 'unknown'
    authMode = cfg.gateway?.auth?.mode ?? 'unknown'
  } catch { /* keep defaults */ }

  return {
    container: { status, image, startedAt, restartCount, memUsage, cpuPct },
    gateway: {
      reachable: healthRaw.stdout.trim() === 'ok',
      version,
      authMode,
    },
    disk: diskRaw.stdout.trim() || '—',
    logLines: logsRaw.stdout.split('\n').filter(l => l.trim().length > 0),
    capturedAt: new Date(),
  }
}

export function renderSnapshot(
  snap: MonitorSnapshot,
  opts: { stackName: string; intervalSec: number; showLogs: boolean; noColor?: boolean; menuMode?: boolean },
): string {
  const noColor = opts.noColor ?? false
  const g = noColor
    ? { green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s, dim: (s: string) => s, bold: (s: string) => s }
    : chalk

  const LINE = '─'.repeat(68)
  const timeStr = snap.capturedAt.toLocaleTimeString()
  const header = `clawops monitor — ${opts.stackName}`
  const padding = Math.max(1, 68 - header.length - `updated ${timeStr}`.length)

  const gatewayStr = snap.gateway.reachable
    ? g.green('✓ healthy')
    : g.red('✗ unreachable')

  const containerStr = snap.container.status === 'running'
    ? g.green('✓ running')
    : snap.container.status === 'not found'
      ? g.red('✗ not found')
      : g.yellow(`⚠ ${snap.container.status}`)

  const uptime = formatUptime(snap.container.startedAt)
  const shortImage = snap.container.image.replace('ghcr.io/openclaw/openclaw:', '') || '—'

  const lines: string[] = [
    g.bold(header) + ' '.repeat(padding) + g.dim(`updated ${timeStr}`),
    LINE,
    '',
    `  Gateway     ${gatewayStr}   version ${g.bold(snap.gateway.version)}   auth ${snap.gateway.authMode}`,
    `  Container   ${containerStr}   ${g.dim(snap.container.image)}`,
    `  Image tag   ${shortImage}   uptime ${uptime}`,
    `  Resources   CPU ${snap.container.cpuPct}   Memory ${snap.container.memUsage}`,
    `  Restarts    ${snap.container.restartCount}   Disk ${snap.disk}`,
    '',
    LINE,
    '',
  ]

  if (opts.showLogs) {
    lines.push(`  Logs (last ${snap.logLines.length} lines)`)
    for (const l of snap.logLines) {
      lines.push('  ' + g.dim(l))
    }
    lines.push('')
    lines.push(LINE)
    lines.push('')
  }

  const logToggle = opts.showLogs ? 'hide logs' : 'show logs'
  const backHint = opts.menuMode ? '  [s] back' : ''
  lines.push(g.dim(`  [r] refresh  [l] ${logToggle}  [q] quit${backHint}     interval: ${opts.intervalSec}s`))

  return lines.join('\n')
}

// ─── Stack selection menu ─────────────────────────────────────────────────────

export interface MenuEntry {
  name: string
  provider: string
  region: string
  deployed: boolean
}

export async function probeEntries(): Promise<MenuEntry[]> {
  const { buildContext } = await import('../context.js')
  const { getConfig } = await import('../../config/store.js')
  const config = getConfig()
  if (!config) return []

  return Promise.all(
    Object.entries(config.stacks).map(async ([name, stackCfg]): Promise<MenuEntry> => {
      const base: MenuEntry = {
        name,
        provider: stackCfg.provider,
        region: stackCfg.region ?? '—',
        deployed: false,
      }
      try {
        const ctx = buildContext({ stack: name })
        if (ctx.adapter.name === 'local') {
          return { ...base, deployed: !!ctx.localState }
        }
        const stack = await ctx.getStack()
        const outputMap = await stack.outputs()
        const outputs = Object.fromEntries(
          Object.entries(outputMap).map(([k, v]) => [k, (v as { value: unknown }).value]),
        )
        return { ...base, deployed: !!outputs['publicIp'] }
      } catch {
        return base
      }
    }),
  )
}

export function renderMenu(
  entries: MenuEntry[],
  selectedIdx: number,
  showAll: boolean,
  noColor: boolean,
  confirmDelete: string | null,
): string {
  const g = noColor
    ? { green: (s: string) => s, red: (s: string) => s, dim: (s: string) => s, bold: (s: string) => s, yellow: (s: string) => s }
    : chalk

  const visible = showAll ? entries : entries.filter(e => e.deployed)
  const totalDeployed = entries.filter(e => e.deployed).length

  const heading = showAll
    ? 'clawops monitor — all stacks'
    : 'clawops monitor — select a stack'
  const countStr = showAll
    ? `(${totalDeployed} of ${entries.length} running)`
    : `(${totalDeployed} running · ${entries.length - totalDeployed} not deployed)`

  const lines: string[] = ['', `  ${g.bold(heading)}   ${g.dim(countStr)}`, '']

  if (visible.length === 0) {
    if (showAll) {
      lines.push('  No stacks configured. Run `clawops init` to set up.')
    } else {
      lines.push('  No deployed stacks found.')
      lines.push('')
      lines.push(g.dim('  [a] show all  [q] quit'))
    }
  } else {
    for (let i = 0; i < visible.length; i++) {
      const e = visible[i]!
      const cursor = i === selectedIdx ? '▶' : ' '
      const nameStr = i === selectedIdx ? g.bold(e.name.padEnd(24)) : e.name.padEnd(24)
      const provStr = e.provider.padEnd(10)
      const regStr = e.region.padEnd(14)
      const statusStr = showAll
        ? (e.deployed ? g.green('✓ running') : g.dim('✗ not deployed'))
        : ''
      lines.push(`  ${cursor}  ${nameStr}${provStr}${regStr}${statusStr}`)
    }

    lines.push('')

    if (confirmDelete !== null) {
      lines.push(`  ${g.yellow(`Delete "${confirmDelete}" from registry?`)} [y/n]`)
    } else {
      const sel = visible[selectedIdx]
      const canDelete = showAll && sel !== undefined && !sel.deployed
      const toggleLabel = showAll ? '[a] running only' : '[a] show all'
      const deleteHint = canDelete ? '  [d] delete' : ''
      lines.push(g.dim(`  [↑↓] navigate  [enter] select${deleteHint}  ${toggleLabel}  [q] quit`))
    }
  }

  lines.push('')
  return lines.join('\n')
}

async function deleteFromRegistry(name: string): Promise<void> {
  const { requireConfig, setConfig } = await import('../../config/store.js')
  const config = requireConfig()
  const newStacks = { ...config.stacks }
  delete newStacks[name]
  const updated = { ...config, stacks: newStacks }
  if (name === config.defaults.stack) {
    updated.defaults = { ...config.defaults, stack: Object.keys(newStacks)[0]! }
  }
  setConfig(updated)
}

async function runStackMenu(
  ac: AbortController,
  setKeyHandler: (fn: (key: string) => void) => void,
  noColor: boolean,
): Promise<string | null> {
  process.stdout.write('\x1b[2J\x1b[H\n  Checking stacks...\n')
  const entries = await probeEntries()
  if (ac.signal.aborted) return null

  let selectedIdx = 0
  let showAll = false
  let confirmDelete: string | null = null

  function visible(): MenuEntry[] {
    return showAll ? entries : entries.filter(e => e.deployed)
  }

  function redraw(): void {
    process.stdout.write('\x1b[2J\x1b[H' + renderMenu(entries, selectedIdx, showAll, noColor, confirmDelete))
  }

  redraw()

  return new Promise<string | null>(resolve => {
    if (ac.signal.aborted) { resolve(null); return }
    ac.signal.addEventListener('abort', () => resolve(null), { once: true })

    setKeyHandler((key: string) => {
      if (confirmDelete !== null) {
        if (key === 'y' || key === 'Y') {
          const nameToDelete = confirmDelete
          confirmDelete = null
          void deleteFromRegistry(nameToDelete).then(() => {
            const idx = entries.findIndex(e => e.name === nameToDelete)
            if (idx !== -1) entries.splice(idx, 1)
            const vis = visible()
            selectedIdx = Math.min(selectedIdx, Math.max(0, vis.length - 1))
            redraw()
          }).catch(() => { redraw() })
        } else {
          confirmDelete = null
          redraw()
        }
        return
      }

      if (key === 'q' || key === '\x03') { resolve(null); return }

      const vis = visible()

      if (key === '\x1b[A') {
        if (vis.length > 0) selectedIdx = Math.max(0, selectedIdx - 1)
        redraw()
      } else if (key === '\x1b[B') {
        if (vis.length > 0) selectedIdx = Math.min(vis.length - 1, selectedIdx + 1)
        redraw()
      } else if (key === '\r') {
        const sel = vis[selectedIdx]
        if (sel?.deployed) resolve(sel.name)
      } else if (key === 'a') {
        showAll = !showAll
        selectedIdx = 0
        redraw()
      } else if (key === 'd' && showAll) {
        const sel = vis[selectedIdx]
        if (sel !== undefined && !sel.deployed) {
          confirmDelete = sel.name
          redraw()
        }
      }
    })
  })
}

// ─── Dashboard loop ───────────────────────────────────────────────────────────

async function runDashboard(
  session: SshSession,
  stackName: string,
  opts: { intervalSec: number; tailLines: number; noColor: boolean },
  ac: AbortController,
  setKeyHandler: (fn: (key: string) => void) => void,
  menuMode: boolean,
): Promise<'quit' | 'back'> {
  let showLogs = true
  let lastSnapshot: MonitorSnapshot | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleRefresh(): void {
    refreshTimer = setTimeout(() => void doRefresh(), opts.intervalSec * 1000)
  }

  function cancelRefresh(): void {
    if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null }
  }

  function redraw(): void {
    if (!lastSnapshot) return
    const out = renderSnapshot(lastSnapshot, {
      stackName,
      intervalSec: opts.intervalSec,
      showLogs,
      noColor: opts.noColor,
      menuMode,
    })
    process.stdout.write('\x1b[2J\x1b[H' + out + '\n')
  }

  async function doRefresh(): Promise<void> {
    cancelRefresh()
    if (ac.signal.aborted) return
    try {
      lastSnapshot = await gatherSnapshot(session, ac.signal, opts.tailLines)
      redraw()
    } catch (err) {
      if (!ac.signal.aborted) {
        process.stdout.write('\x1b[2J\x1b[H  Error gathering snapshot: ' +
          (err instanceof Error ? err.message : String(err)) + '\n')
      }
    }
    if (!ac.signal.aborted) scheduleRefresh()
  }

  return new Promise<'quit' | 'back'>(resolve => {
    if (ac.signal.aborted) { resolve('quit'); return }

    ac.signal.addEventListener('abort', () => {
      cancelRefresh()
      resolve('quit')
    }, { once: true })

    setKeyHandler((key: string) => {
      if (key === 'q' || key === '\x03') {
        ac.abort()
        cancelRefresh()
        resolve('quit')
      } else if (key === 's' && menuMode) {
        cancelRefresh()
        resolve('back')
      } else if (key === 'r') {
        void doRefresh()
      } else if (key === 'l') {
        showLogs = !showLogs
        redraw()
      }
    })

    void doRefresh()
  })
}

// ─── Command ─────────────────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'monitor',
    description: 'Live dashboard: gateway health, container status, resource usage, log tail',
  },
  args: {
    stack:      { type: 'string',  description: 'Target stack name (omit to pick from a list)' },
    interval:   { type: 'string',  description: 'Refresh interval in seconds (default: 10)' },
    tail:       { type: 'string',  description: 'Log lines to show (default: 10)' },
    'no-color': { type: 'boolean', description: 'Disable ANSI colors (auto-detected when not a TTY)' },
  },
  async run({ args }) {
    const intervalSec = Math.max(2, parseInt(String(args.interval ?? '10'), 10) || 10)
    const tailLines   = Math.max(1, parseInt(String(args.tail    ?? '10'), 10) || 10)
    const isTTY       = Boolean(process.stdout.isTTY)
    const noColor     = Boolean(args['no-color']) || !isTTY

    const { buildContext } = await import('../context.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')

    const ac = new AbortController()
    process.on('SIGINT',  () => ac.abort())
    process.on('SIGTERM', () => ac.abort())

    if (args.stack) {
      // ── Direct mode: --stack given ─────────────────────────────────────────
      const ctx = buildContext(args)

      let conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string }

      if (ctx.adapter.name === 'local') {
        if (!ctx.localState) {
          failure('Stack is not bootstrapped. Run `clawops up` first.')
          process.exit(4)
        }
        const ls = ctx.localState
        conn = { host: ls.sshHost, port: ls.sshPort, user: ls.sshUser, privateKeyPath: ls.privateKeyPath, knownHostsPath: ls.knownHostsPath }
      } else {
        const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
        const stack = await ctx.getStack()
        const outputMap = await stack.outputs()
        const outputs: Record<string, unknown> = Object.fromEntries(
          Object.entries(outputMap).map(([k, v]) => [k, v.value]),
        )
        if (!outputs['publicIp']) {
          failure('Stack has no outputs. Run `clawops up` first.')
          process.exit(4)
        }
        const base = extractBaseOutputs(outputs)
        conn = ctx.adapter.getConnectionInfo({
          ...base,
          privateKeyPath: ctx.config.ssh.keyPath,
          knownHostsPath: ctx.config.ssh.knownHostsPath,
        })
      }

      if (!isTTY) {
        const { session, release } = await acquireSession({ ...conn, signal: ac.signal })
        try {
          const snap = await gatherSnapshot(session, ac.signal, tailLines)
          process.stdout.write(
            renderSnapshot(snap, { stackName: ctx.stackName, intervalSec, showLogs: true, noColor }) + '\n',
          )
        } finally {
          release()
          drainPool()
        }
        return
      }

      const { session, release } = await acquireSession({ ...conn, signal: ac.signal })

      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      process.stdout.write('\x1b[?25l')

      let keyHandler: (key: string) => void = () => {}
      process.stdin.on('data', (key: string) => keyHandler(key))

      try {
        await runDashboard(session, ctx.stackName, { intervalSec, tailLines, noColor }, ac, fn => { keyHandler = fn }, false)
      } finally {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdout.write('\x1b[?25h\n')
        release()
        drainPool()
      }
      return
    }

    // ── Menu mode: no --stack given ──────────────────────────────────────────
    if (!isTTY) {
      failure('Pass --stack <name> or run in a TTY for interactive stack selection.')
      process.exit(2)
    }

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdout.write('\x1b[?25l')

    let keyHandler: (key: string) => void = () => {}
    process.stdin.on('data', (key: string) => keyHandler(key))

    try {
      while (!ac.signal.aborted) {
        const stackName = await runStackMenu(ac, fn => { keyHandler = fn }, noColor)
        if (!stackName || ac.signal.aborted) break

        const ctx = buildContext({ stack: stackName })

        let conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string } | null = null

        if (ctx.adapter.name === 'local') {
          if (!ctx.localState) continue
          const ls = ctx.localState
          conn = { host: ls.sshHost, port: ls.sshPort, user: ls.sshUser, privateKeyPath: ls.privateKeyPath, knownHostsPath: ls.knownHostsPath }
        } else {
          try {
            const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
            const stack = await ctx.getStack()
            const outputMap = await stack.outputs()
            const outputs: Record<string, unknown> = Object.fromEntries(
              Object.entries(outputMap).map(([k, v]) => [k, v.value]),
            )
            if (!outputs['publicIp']) continue
            const base = extractBaseOutputs(outputs)
            conn = ctx.adapter.getConnectionInfo({
              ...base,
              privateKeyPath: ctx.config.ssh.keyPath,
              knownHostsPath: ctx.config.ssh.knownHostsPath,
            })
          } catch { continue }
        }

        if (!conn) continue

        const { session, release } = await acquireSession({ ...conn, signal: ac.signal })
        try {
          const result = await runDashboard(session, stackName, { intervalSec, tailLines, noColor }, ac, fn => { keyHandler = fn }, true)
          if (result === 'quit') break
          // result === 'back' → loop → show menu again
        } finally {
          release()
          drainPool()
        }
      }
    } finally {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\x1b[?25h\n')
    }
  },
})
