import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, failure } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'logs',
    description: 'Stream gateway logs from the remote instance',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    follow: { type: 'boolean', alias: 'f', description: 'Follow log output' },
    tail: { type: 'string', description: 'Number of lines to show from end (default: 100)' },
    since: { type: 'string', description: 'Show logs since duration (e.g. 5m, 1h)' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')

    const ctx = buildContext(args)
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
    const conn = ctx.adapter.getConnectionInfo({
      ...base,
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })

    const tailLines = typeof args.tail === 'string' ? parseInt(args.tail, 10) : 100
    const follow = Boolean(args.follow)
    const sinceFlag = typeof args.since === 'string' ? `--since "${args.since}"` : ''
    const followFlag = follow ? '-f' : ''

    // Build journalctl command; fall back to docker logs if journalctl unavailable
    const command = [
      'journalctl -u openclaw',
      `-n ${tailLines}`,
      followFlag,
      sinceFlag,
      '2>/dev/null',
      '|| docker logs openclaw',
      `-n ${tailLines}`,
      follow ? '-f' : '',
    ]
      .filter(Boolean)
      .join(' ')

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    const spin = spinner('Connecting...')
    const { session, release } = await acquireSession({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      privateKeyPath: conn.privateKeyPath,
      knownHostsPath: conn.knownHostsPath,
      signal: abortController.signal,
    })
    spin.stop()

    try {
      if (follow) {
        // Streaming: pipe with backpressure (Issue 16 — Option A)
        const logStream = await session.stream(command, abortController.signal)
        logStream.pipe(process.stdout)

        await new Promise<void>((resolve) => {
          logStream.on('end', resolve)
          logStream.on('close', resolve)
          abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      } else {
        const result = await session.exec(command, abortController.signal)
        process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
      }
    } finally {
      release()
      if (!follow) drainPool()
    }
  },
})
