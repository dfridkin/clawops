import { defineCommand } from 'citty'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'
import { success, failure, info, spinner, warn } from '../../output/human.js'
import { UsageError } from '../../errors/index.js'
import {
  execPrivileged, streamPrivileged, execPrivilegedWithInput,
} from '../../transport/privileged.js'

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
      if (action === 'create') {
        const outPath = typeof args.out === 'string'
          ? args.out
          : `openclaw-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`

        info(`Writing backup to ${outPath}...`)
        const spin = spinner('Creating backup on remote host...')

        // `openclaw backup create` writes to a path; it has no stdout mode. Write it
        // inside the container, stream it out with `docker exec cat`, then clean up.
        // The previous implementation invoked `openclaw-ctl backup create --stdout`:
        // that binary does not exist, and neither does that flag.
        const remoteArchive = '/tmp/clawops-backup.tar.gz'
        const createResult = await execPrivileged(session, 
          `docker exec openclaw sh -lc 'rm -f ${remoteArchive} && ` +
            `openclaw backup create --output ${remoteArchive} --verify --json'`,
          abortController.signal,
        )
        if (createResult.code !== 0) {
          spin.stop()
          throw new Error(`Backup failed on the remote host: ${createResult.stderr.slice(0, 300)}`)
        }

        const backupStream = await streamPrivileged(session, 
          `docker exec openclaw cat ${remoteArchive}`,
          abortController.signal,
        )
        spin.stop()
        // 0600, matching the mode OpenClaw gives the archive on the host. The default is
        // 0644, and this archive carries the state database — whose tables include
        // mcp_oauth_stores, secret_store_entries, worker_environment_credentials and
        // device_auth_tokens, unencrypted.
        const fileStream = createWriteStream(outPath, { mode: 0o600 })
        await pipeline(backupStream, fileStream)
        await execPrivileged(session, 
          `docker exec openclaw rm -f ${remoteArchive}`,
          abortController.signal,
        )
        success(`Backup saved to ${outPath}`)
        info('Saved with mode 0600. The archive contains the state database — OAuth tokens,')
        info('secrets and device credentials, unencrypted. Treat it as a credential.')
      } else {
        // Delegated to OpenClaw, which restores into a FRESH directory and refuses a
        // non-empty target ("Backup restore target directory must be empty"). clawops does
        // not extract archives itself and does not restore in place: writing an archive over
        // a live state directory is how a backup becomes corruption, and upstream already
        // enforces the safe shape.
        const file = typeof args.file === 'string' ? args.file : undefined
        if (!file) {
          throw new UsageError('Usage: clawops backup restore --file <archive.tar.gz>')
        }

        const { createReadStream } = await import('node:fs')
        const { statSync } = await import('node:fs')
        const { STATE_DIR_CONTAINER, stateDirForOS } = await import('../../openclaw/runtime.js')
        const { activateRestored, hasRoomFor } = await import('../../openclaw/restore.js')

        const remoteArchive = '/tmp/clawops-restore.tar.gz'
        const stamp = Date.now()
        /*
         * Staged under the state directory, which is the one path the container and the host both
         * see. It used to be the container's own /tmp: unreachable from the host, and destroyed by
         * `gateway restart`, which stops, removes and re-runs the container — so a restore staged
         * there could evaporate at the next step of the procedure meant to adopt it.
         */
        const stagingInContainer = `${STATE_DIR_CONTAINER}/.clawops-restore-${stamp}`

        const hostExec = (command: string) => execPrivileged(session, command, abortController.signal)
        const osProbe = await hostExec('uname -s')
        const stateDir = stateDirForOS(osProbe.stdout.trim() === 'Darwin' ? 'Darwin' : 'Linux')
        const stagingOnHost = `${stateDir}/.clawops-restore-${stamp}`

        // Expanding needs room for the archive and its contents; the swap afterwards is renames
        // inside one directory and needs none.
        const archiveBytes = statSync(file).size
        const room = await hasRoomFor(hostExec, stateDir, archiveBytes * 3)
        if (!room.ok) {
          throw new UsageError(
            `Not enough free space on the host to expand this archive: ${mib(room.availableBytes)} ` +
              `available where the state lives, and the restore needs about ${mib(room.neededBytes)}. ` +
              'Free some space and run this again; nothing has been changed.',
          )
        }

        const spin = spinner('Uploading archive...')
        const uploadResult = await execPrivilegedWithInput(
          session,
          `docker exec -i openclaw sh -c 'cat > ${remoteArchive}'`,
          createReadStream(file),
          abortController.signal,
        )
        if (uploadResult.code !== 0) {
          spin.stop()
          throw new Error(`Could not upload the archive: ${uploadResult.stderr.slice(0, 300)}`)
        }

        spin.text = 'Verifying and restoring to a staging directory...'
        const restore = await execPrivileged(
          session,
          `docker exec openclaw openclaw backup restore ${remoteArchive} --target ${stagingInContainer} --json`,
          abortController.signal,
        )
        await execPrivileged(
          session, `docker exec openclaw rm -f ${remoteArchive}`, abortController.signal,
        )
        spin.stop()

        if (restore.code !== 0) {
          throw new Error(`Restore failed: ${(restore.stderr || restore.stdout).slice(0, 400)}`)
        }

        let report: { entryCount?: number; warnings?: string[] } = {}
        try {
          report = JSON.parse(restore.stdout.trim()) as typeof report
        } catch {
          info(restore.stdout)
        }

        success(`Archive verified and expanded to ${stagingOnHost} on the host.`)
        if (report.entryCount !== undefined) info(`${report.entryCount} entries restored.`)

        // Surfaced verbatim rather than summarised: they describe consequences clawops
        // cannot judge for the operator — rolled-back approvals, channel credentials that
        // may need relinking — and paraphrasing would lose exactly that detail.
        for (const w of report.warnings ?? []) warn(w)

        if (!args.activate) {
          info('')
          info('Nothing has been activated. Re-run with --activate to put this state into')
          info('service, or adopt it by hand:')
          info("  1. clawops ssh --command 'sudo docker stop openclaw'")
          info(`  2. replace the contents of ${stateDir} with ${stagingOnHost}`)
          info('  3. clawops gateway restart')
          info('Provider plugins are not carried in the archive; re-run `clawops apply` to')
          info('reinstall them, or the gateway starts without its model providers.')
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

        const { restartGateway } = await import('../../plan/remote-config.js')
        const { waitForGateway } = await import('../../openclaw/ready.js')

        const activating = spinner('Activating the restored state...')
        const outcome = await activateRestored({
          stateDir,
          staging: stagingOnHost,
          exec: hostExec,
          restart: async () => {
            activating.text = 'Restarting the gateway...'
            await restartGateway(session, abortController.signal)
          },
          waitHealthy: async () => {
            activating.text = 'Waiting for the gateway to answer...'
            await waitForGateway(session, { signal: abortController.signal })
          },
        })
        activating.stop()

        if (!outcome.ok) {
          failure(outcome.reason)
          if (outcome.keptFailed) info(`The restored state was kept at ${outcome.keptFailed}.`)
          if (outcome.preserved) info(`The previous state is at ${outcome.preserved}.`)
          process.exit(1)
        }

        success('The restored state is live and the gateway is answering.')
        info(`The state it replaced is at ${outcome.preserved}.`)
        info('Remove that directory once you are satisfied; clawops will not.')
        info('Provider plugins are not carried in the archive; re-run `clawops apply` to')
        info('reinstall them, or the gateway starts without its model providers.')
      }
    } finally {
      release()
      drainPool()
    }
  },
})

/** Bytes as MiB, for a message about disk space someone reads while under pressure. */
function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`
}
