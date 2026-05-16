import { defineCommand } from 'citty'
import process from 'node:process'
import { chalk, failure } from '../../output/human.js'
import type { SshSession } from '../../transport/ssh.js'

const GATEWAY_PORT = 18789

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
  // Run all queries in parallel over the same SSH connection (SSH2 multiplexes channels)
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

  // Parse docker inspect (pipe-delimited to avoid JSON quoting issues)
  const inspectParts = inspectRaw.stdout.trim().split('|')
  const status = inspectParts[0] ?? 'not found'
  const image = inspectParts[1] ?? ''
  const startedAt = inspectParts[2] ?? ''
  const restartCount = parseInt(inspectParts[3] ?? '0', 10) || 0

  // Parse docker stats
  const statsParts = statsRaw.stdout.trim().split('|')
  const memUsage = statsParts[0] ?? '—'
  const cpuPct = statsParts[1] ?? '—'

  // Parse openclaw.json
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
  opts: { stackName: string; intervalSec: number; showLogs: boolean; noColor?: boolean },
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
  lines.push(g.dim(`  [r] refresh  [l] ${logToggle}  [q] quit     interval: ${opts.intervalSec}s`))

  return lines.join('\n')
}

export default defineCommand({
  meta: {
    name: 'monitor',
    description: 'Live dashboard: gateway health, container status, resource usage, log tail',
  },
  args: {
    stack:      { type: 'string',  description: 'Target stack name' },
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

    const ctx = buildContext(args)

    // Resolve SSH connection (supports both local and cloud stacks)
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

    const ac = new AbortController()
    process.on('SIGINT',  () => ac.abort())
    process.on('SIGTERM', () => ac.abort())

    const { session, release } = await acquireSession({ ...conn, signal: ac.signal })

    // Non-TTY: one snapshot then exit (CI / scripting)
    if (!isTTY) {
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

    // Interactive mode
    let showLogs = true
    let lastSnapshot: MonitorSnapshot | null = null
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleRefresh() {
      refreshTimer = setTimeout(() => void doRefresh(), intervalSec * 1000)
    }

    function cancelRefresh() {
      if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null }
    }

    function redraw() {
      if (!lastSnapshot) return
      const out = renderSnapshot(lastSnapshot, { stackName: ctx.stackName, intervalSec, showLogs, noColor })
      process.stdout.write('\x1b[2J\x1b[H' + out + '\n')
    }

    async function doRefresh() {
      cancelRefresh()
      if (ac.signal.aborted) return
      try {
        lastSnapshot = await gatherSnapshot(session, ac.signal, tailLines)
        redraw()
      } catch (err) {
        if (!ac.signal.aborted) {
          process.stdout.write('\x1b[2J\x1b[H  Error gathering snapshot: ' +
            (err instanceof Error ? err.message : String(err)) + '\n')
        }
      }
      if (!ac.signal.aborted) scheduleRefresh()
    }

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdout.write('\x1b[?25l') // hide cursor

    process.stdin.on('data', (key: string) => {
      if (key === 'q' || key === '\x03') {
        ac.abort()
      } else if (key === 'r') {
        void doRefresh()
      } else if (key === 'l') {
        showLogs = !showLogs
        redraw()
      }
    })

    try {
      await doRefresh()
      await new Promise<void>(resolve => {
        ac.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    } finally {
      cancelRefresh()
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\x1b[?25h\n') // show cursor
      release()
      drainPool()
    }
  },
})
