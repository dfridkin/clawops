import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, success, failure, info } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { renderTable } from '../../output/table.js'
import { IMAGE_INSPECT_CMD, imageForRestart, versionOf } from '../../openclaw/run-flags.js'
import {
  gatewayRunCommand, PUBLISH_INSPECT_CMD, publishForRestart, STATE_DIR_HOST_LINUX,
} from '../../openclaw/runtime.js'
import { execPrivileged } from '../../transport/privileged.js'



/** Shared docker stop → rm → run command. Exported for tests. */
export function dockerRunCmd(version: string, publish: 'loopback' | 'all' = 'loopback'): string {
  return gatewayRunCommand({
    image: `ghcr.io/openclaw/openclaw:${version}`,
    stateDir: STATE_DIR_HOST_LINUX,
    publish,
  })
}

export default defineCommand({
  meta: {
    name: 'gateway',
    description: 'Manage the OpenClaw gateway daemon (status | restart | update [version])',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    channel: { type: 'string', description: 'Version for update (a concrete pin; moving tags are refused)' },
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
        // Reuse the version the host already runs — a restart must not change it.
        const imgResult = await execPrivileged(session, IMAGE_INSPECT_CMD, abortController.signal)
        const image = imageForRestart(imgResult.stdout)
        if (!image.ok) {
          failure(image.error)
          process.exit(1)
        }
        const version = versionOf(image.value)
        const pub = await execPrivileged(session, PUBLISH_INSPECT_CMD, abortController.signal)
        const publish = publishForRestart(pub.stdout)

        const spin = spinner('Restarting gateway...')
        const result = await execPrivileged(
          session,
          dockerRunCmd(version, publish),
          abortController.signal,
        )
        spin.stop()

        if (result.code !== 0) {
          failure(`Restart failed: ${result.stderr}`)
          process.exit(1)
        }
        success(`Gateway restarted (${version}).`)
      } else {
        // update
        //
        // The one path that CHANGES the deployed version, and the one path that did not
        // check it. `clawops gateway update 2026.7.1-2` would have pulled a pre-2.0
        // OpenClaw onto a host running the 2.0 contract; and the old default was the
        // moving tag `stable`, handed straight to `docker pull` with no resolution and no
        // range check — exactly how an unsupported release reaches a deployment. Guarding
        // after the pull would be guarding after the damage.
        const { guardOpenclawVersion, defaultOpenclawVersion } =
          await import('../version-guard.js')
        const requested = versionArg ?? args.channel
        const version = requested
          ? await guardOpenclawVersion(requested)
          : await defaultOpenclawVersion()

        const spin = spinner(`Updating gateway to ${version}...`)
        const targetImage = `ghcr.io/openclaw/openclaw:${version}`

        const pullResult = await execPrivileged(session,
          `docker pull ${targetImage}`,
          abortController.signal,
        )
        if (pullResult.code !== 0) {
          spin.stop()
          failure(`Pull failed: ${pullResult.stderr}`)
          process.exit(1)
        }

        // Snapshot, then ask the TARGET release whether it understands this database. The
        // snapshot is not only a rollback point: preflight refuses a live database, because
        // the schema version sits in the WAL until checkpointed.
        spin.text = 'Checking state compatibility...'
        const {
          snapshotCommand, snapshotPathFrom, preflightCommand, parsePreflight, judgePreflight,
        } = await import('../../openclaw/upgrade.js')

        const cur = imageForRestart(
          (await execPrivileged(session, IMAGE_INSPECT_CMD, abortController.signal)).stdout,
        )
        const snapRepo = `${STATE_DIR_HOST_LINUX}/snapshots`
        const snapOut = await execPrivileged(
          session,
          snapshotCommand(cur.ok ? cur.value : targetImage, STATE_DIR_HOST_LINUX, snapRepo),
          abortController.signal,
        )
        const snapPath = snapshotPathFrom(snapOut.stdout)

        if (!snapPath) {
          // No snapshot means no compatibility check and no rollback point. Refuse rather
          // than replace a working container on the strength of a `docker run` exit code.
          spin.stop()
          failure(
            'Could not snapshot the state database before upgrading, so neither the ' +
              'compatibility check nor a rollback point is available.\n' +
              (snapOut.stderr || snapOut.stdout).slice(0, 300),
          )
          process.exit(1)
        }

        const pre = await execPrivileged(
          session,
          preflightCommand(targetImage, STATE_DIR_HOST_LINUX, `${snapPath}/database.sqlite`),
          abortController.signal,
        )
        const report = parsePreflight(pre.stdout)
        const verdict = report
          ? judgePreflight(report)
          : { ok: false as const, reason: `preflight produced no readable report: ${pre.stderr.slice(0, 200)}` }

        if (!verdict.ok) {
          spin.stop()
          failure(`Refusing to upgrade to ${version}: ${verdict.reason}`)
          info(`A snapshot of the current state was kept at ${snapPath}.`)
          process.exit(1)
        }
        if (verdict.ok && verdict.note) info(verdict.note)
        spin.text = `Updating gateway to ${version}...`

        // An update changes the version by request; it must not also change who can
          // reach the gateway.
          const pubU = await execPrivileged(session, PUBLISH_INSPECT_CMD, abortController.signal)
          const runResult = await execPrivileged(
            session,
            dockerRunCmd(version, publishForRestart(pubU.stdout)),
            abortController.signal,
          )
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
