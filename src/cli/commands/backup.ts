import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info, spinner, warn } from '../../output/human.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'backup',
    description: 'Create an OpenClaw backup, or restore one into a staging directory',
  },
  args: {
    action: { type: 'positional', description: 'Action: create | restore', required: true },
    out: { type: 'string', description: '[create] Local path to write the backup archive' },
    file: { type: 'string', description: '[restore] Local backup archive to verify and expand on the host' },
    stack: { type: 'string', description: 'Target stack name' },
    yes: { type: 'boolean', description: '[restore] Skip confirmation prompt' },
    activate: { type: 'boolean', description: '[restore] Put the restored state into service: stop the gateway, swap it in, restart, and roll back if it does not come up' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')

    const action = args.action as string
    if (action !== 'create' && action !== 'restore') {
      throw new UsageError(`Unknown action: ${action}. Use "create" or "restore"`)
    }

    const ctx = buildContext(args)

    // Resolve connection info
    let conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string }

    if (ctx.adapter.name === 'local') {
      const state = ctx.localState
      if (!state) {
        failure('Stack has no state. Run `clawops up` first.')
        process.exit(4)
      }
      conn = {
        host: state.sshHost,
        port: state.sshPort,
        user: state.sshUser,
        privateKeyPath: state.privateKeyPath,
        knownHostsPath: state.knownHostsPath,
      }
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
      const flows = await import('../../openclaw/backup-flows.js')
      if (action === 'create') {
        const outPath = typeof args.out === 'string' ? args.out : flows.defaultBackupFilename()

        info(`Writing backup to ${outPath}...`)
        const spin = spinner('Creating backup on remote host...')
        const created = await flows.createBackup(session, {
          outPath,
          signal: abortController.signal,
          onPhase: (phase) => { if (phase === 'downloading') spin.stop() },
        })
        spin.stop()
        if (!created.ok) throw new Error(created.reason)
        success(`Backup saved to ${outPath}`)
        for (const line of flows.ARCHIVE_IS_A_CREDENTIAL) info(line)
      } else {
        const file = typeof args.file === 'string' ? args.file : undefined
        if (!file) {
          throw new UsageError('Usage: clawops backup restore --file <archive.tar.gz>')
        }

        let spin: ReturnType<typeof spinner> | undefined
        const staged = await flows.stageRestore(session, {
          file,
          signal: abortController.signal,
          onPhase: (phase) => {
            if (phase === 'uploading') spin = spinner('Uploading archive...')
            else if (spin) spin.text = 'Verifying and restoring to a staging directory...'
          },
        })
        spin?.stop()

        if (staged.unparsedReport !== undefined) info(staged.unparsedReport)
        if (!staged.ok) {
          if (staged.kind === 'refused') throw new UsageError(staged.reason)
          if (staged.kind === 'failed') throw new Error(staged.reason)
          failure(staged.reason)
          if (staged.stagingOnHost) info(flows.nothingChanged(staged.stagingOnHost))
          process.exit(1)
        }

        const { stagingOnHost, stateDir } = staged
        success(`Archive verified and expanded to ${stagingOnHost} on the host.`)
        if (staged.entryCount !== undefined) info(`${staged.entryCount} entries restored.`)

        // Surfaced verbatim rather than summarised: they describe consequences clawops
        // cannot judge for the operator — rolled-back approvals, channel credentials that
        // may need relinking — and paraphrasing would lose exactly that detail.
        for (const w of staged.warnings) warn(w)

        if (!args.activate) {
          info('')
          info('Nothing has been activated. Re-run with --activate to put this state into')
          info('service, or adopt it by hand:')
          info("  1. clawops ssh --command 'sudo docker stop openclaw'")
          info(`  2. replace the contents of ${stateDir} with those of`)
          info(`     ${staged.statePath}`)
          info(`     (the archive holds ${staged.stateDirInArchive} under payload/posix, not a`)
          info('      drop-in state directory — moving the bundle itself stops the gateway)')
          info('  3. clawops gateway restart')
          for (const line of flows.PLUGINS_NOT_CARRIED) info(line)
          return
        }

        if (!args.yes) {
          const { createInterface } = await import('node:readline/promises')
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          const answer = await rl.question(
            `Stop the gateway and put this restored state into service? The state it replaces ` +
              `is kept alongside it, and clawops puts it back if the gateway does not come up. [y/N] `,
          )
          rl.close()
          if (!answer.toLowerCase().startsWith('y')) {
            info(`Aborted. The restored state is at ${stagingOnHost}; nothing was changed.`)
            return
          }
        }

        const activating = spinner('Activating the restored state...')
        const outcome = await flows.activateStaged(session, staged, {
          signal: abortController.signal,
          onPhase: (phase) => {
            if (phase === 'restarting') activating.text = 'Restarting the gateway...'
            else if (phase === 'waiting') activating.text = 'Waiting for the gateway to answer...'
            else if (phase === 'done') activating.stop()
          },
        })
        activating.stop()

        if (!outcome.ok) {
          failure(outcome.reason)
          for (const line of flows.activationFailureDetail(outcome)) info(line)
          process.exit(1)
        }

        success(flows.ACTIVATED)
        for (const line of flows.activatedLines(outcome.preserved)) info(line)
      }
    } finally {
      release()
      drainPool()
    }
  },
})
