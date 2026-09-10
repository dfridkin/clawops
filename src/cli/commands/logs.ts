import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, failure, info } from '../../output/human.js'
import { execPrivileged, streamPrivileged } from '../../transport/privileged.js'
import {
  GATEWAY_LOGS_PROBE, chooseLogSource, gatewayLogsCommand, containerLogsCommand,
} from '../../openclaw/logs.js'

export default defineCommand({
  meta: {
    name: 'logs',
    description: 'Stream gateway logs from the remote instance',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    follow: { type: 'boolean', alias: 'f', description: 'Follow log output' },
    tail: { type: 'string', description: 'Number of lines to show from end (default: 100)' },
    since: { type: 'string', description: 'Show logs since duration (e.g. 5m, 1h). Reads container output — the gateway log command has no time filter' },
    json: { type: 'boolean', description: "Emit the gateway's structured JSON log lines" },
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
    const since = typeof args.since === 'string' ? args.since : undefined

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
      // Ask before committing to a stream: `openclaw logs` reads the gateway over RPC, so a
      // gateway that is down cannot serve them — which is when logs are wanted most.
      const probe = since
        ? { stdout: '' }
        : await execPrivileged(session, GATEWAY_LOGS_PROBE, abortController.signal)
      const choice = chooseLogSource({ since, gatewayReachable: probe.stdout.trim() === 'ok' })
      const opts = { tail: tailLines, follow, since, json: Boolean(args.json) }
      const command =
        choice.source === 'gateway' ? gatewayLogsCommand(opts) : containerLogsCommand(opts)

      // The old command chained journalctl into docker logs and printed neither name, so a
      // missing log line was indistinguishable from a log source that was never read.
      info(`Logs: ${choice.source} — ${choice.reason}`)

      if (follow) {
        // Streaming: pipe with backpressure (Issue 16 — Option A)
        const logStream = await streamPrivileged(session, command, abortController.signal)
        logStream.pipe(process.stdout)

        await new Promise<void>((resolve) => {
          logStream.on('end', resolve)
          logStream.on('close', resolve)
          abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      } else {
        const result = await execPrivileged(session, command, abortController.signal)
        process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
      }
    } finally {
      release()
      if (!follow) drainPool()
    }
  },
})
