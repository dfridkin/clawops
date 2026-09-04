import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, success, failure } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { renderTable } from '../../output/table.js'

const OPENCLAW_CONFIG = '/home/clawops/openclaw.json'

/** Shared docker stop → rm → run command. Exported for tests. */
export function dockerRunCmd(version: string): string {
  return (
    'docker stop openclaw 2>/dev/null || true && ' +
    'docker rm   openclaw 2>/dev/null || true && ' +
    `docker run -d --name openclaw --restart unless-stopped -p 18789:18789 ` +
    `-e OPENCLAW_CONFIG_PATH=/app/config.json --add-host=host.docker.internal:host-gateway ` +
    `-v ${OPENCLAW_CONFIG}:/app/config.json:ro ghcr.io/openclaw/openclaw:${version}`
  )
}

export default defineCommand({
  meta: {
    name: 'gateway',
    description: 'Manage the OpenClaw gateway daemon (status | restart | update [version])',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    channel: { type: 'string', description: 'Channel for update: stable | dev | <version>' },
    json: { type: 'boolean', description: 'Emit JSON (for status)' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')

    const [action, versionArg] = (args._ ?? []) as string[]

    if (!action || !['status', 'restart', 'update'].includes(action)) {
      failure('Usage: clawops gateway <status | restart | update [version]>')
      process.exit(2)
    }

    const ctx = buildContext(args)
    const stack = await ctx.getStack()
    const outputMap = await stack.outputs()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(outputMap).map(([k, v]) => [k, v.value]),
    )
    const base = extractBaseOutputs(outputs)
    const conn = ctx.adapter.getConnectionInfo({
      ...base,
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    const { session, release } = await acquireSession({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      privateKeyPath: conn.privateKeyPath,
      knownHostsPath: conn.knownHostsPath,
      signal: abortController.signal,
    })

    try {
      if (action === 'status') {
        const statusCmd =
          `docker inspect openclaw ` +
          `--format '{"status":"{{.State.Status}}","started":"{{.State.StartedAt}}","image":"{{.Config.Image}}"}' ` +
          `2>/dev/null || echo '{"status":"not running","started":"","image":""}'`

        const result = await session.exec(statusCmd, abortController.signal)
        type GatewayStatus = { status: string; started: string; image: string }
        let status: GatewayStatus = { status: 'unknown', started: '', image: '' }
        try {
          status = JSON.parse(result.stdout.trim()) as GatewayStatus
        } catch { /* keep default */ }

        if (args.json) {
          printJson(jsonOk(status))
        } else {
          process.stdout.write(
            '\n' +
              renderTable(
                ['Field', 'Value'],
                [
                  ['Status', status.status],
                  ['Started', status.started],
                  ['Image', status.image],
                ],
              ) +
              '\n\n',
          )
        }
      } else if (action === 'restart') {
        // Preserve current image version
        const imgResult = await session.exec(
          `docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null || echo 'ghcr.io/openclaw/openclaw:stable'`,
          abortController.signal,
        )
        const version = imgResult.stdout.trim().split(':')[1] ?? 'stable'

        const spin = spinner('Restarting gateway...')
        const result = await session.exec(dockerRunCmd(version), abortController.signal)
        spin.stop()

        if (result.code !== 0) {
          failure(`Restart failed: ${result.stderr}`)
          process.exit(1)
        }
        success(`Gateway restarted (${version}).`)
      } else {
        // update
        const version = versionArg ?? args.channel ?? 'stable'

        const spin = spinner(`Updating gateway to ${version}...`)

        const pullResult = await session.exec(
          `docker pull ghcr.io/openclaw/openclaw:${version}`,
          abortController.signal,
        )
        if (pullResult.code !== 0) {
          spin.stop()
          failure(`Pull failed: ${pullResult.stderr}`)
          process.exit(1)
        }

        const runResult = await session.exec(dockerRunCmd(version), abortController.signal)
        spin.stop()

        if (runResult.code !== 0) {
          failure(`Start failed: ${runResult.stderr}`)
          process.exit(1)
        }
        success(`Gateway updated to ${version}.`)
      }
    } finally {
      release()
      drainPool()
    }
  },
})
