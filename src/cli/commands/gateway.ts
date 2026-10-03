import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, success, failure, info } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { renderTable } from '../../output/table.js'
import {
  IMAGE_INSPECT_CMD, imageForRestart, versionOf,
} from '../../openclaw/run-flags.js'
import { PUBLISH_INSPECT_CMD, publishForRestart } from '../../openclaw/runtime.js'
import {
  dockerRunCmd, gatewayStatus, resolveUpdateVersion, updateGateway,
} from '../../openclaw/gateway-ops.js'
import { execPrivileged } from '../../transport/privileged.js'
import { UsageError } from '../../errors/index.js'

/** Shared docker stop → rm → run command. Re-exported for tests; lives in the shared module. */
export { dockerRunCmd }

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
        const inspected = await gatewayStatus(session, abortController.signal)
        if (!inspected.ok) {
          // Reporting "not running" here would be a statement about the gateway, when the
          // truth is that clawops could not ask.
          failure(inspected.error)
          process.exit(1)
        }
        const status = inspected.value

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
        const target = await resolveUpdateVersion(versionArg ?? args.channel)
        if (!target.ok) throw new UsageError(target.error)
        const version = target.value

        const spin = spinner(`Updating gateway to ${version}...`)
        const result = await updateGateway(session, version, {
          signal: abortController.signal,
          onProgress: (text) => { spin.text = text },
          onNote: (text) => info(text),
        })
        spin.stop()

        if (result.ok) {
          success(result.message)
        } else {
          failure(result.message)
          if (result.hint) info(result.hint)
          process.exit(1)
        }
      }
    } finally {
      release()
      drainPool()
    }
  },
})
