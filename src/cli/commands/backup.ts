import { defineCommand } from 'citty'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'
import { success, failure, info, spinner } from '../../output/human.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'backup',
    description: 'Create an OpenClaw backup (restore is unavailable on this release line)',
  },
  args: {
    action: { type: 'positional', description: 'Action: create (restore returns in clawops 2.x)', required: true },
    out: { type: 'string', description: '[create] Local path to write the backup archive' },
    file: { type: 'string', description: '[restore] Local backup archive (restore is unavailable)' },
    stack: { type: 'string', description: 'Target stack name' },
    yes: { type: 'boolean', description: '[restore] Skip confirmation prompt' },
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
        const createResult = await session.exec(
          `docker exec openclaw sh -lc 'rm -f ${remoteArchive} && ` +
            `openclaw backup create --output ${remoteArchive} --verify --json'`,
          abortController.signal,
        )
        if (createResult.code !== 0) {
          spin.stop()
          throw new Error(`Backup failed on the remote host: ${createResult.stderr.slice(0, 300)}`)
        }

        const backupStream = await session.stream(
          `docker exec openclaw cat ${remoteArchive}`,
          abortController.signal,
        )
        spin.stop()
        const fileStream = createWriteStream(outPath)
        await pipeline(backupStream, fileStream)
        await session.exec(
          `docker exec openclaw rm -f ${remoteArchive}`,
          abortController.signal,
        )
        success(`Backup saved to ${outPath}`)
        info('The archive contains credentials — store it accordingly.')
      } else {
        // `openclaw backup restore` does not exist on the OpenClaw line this clawops
        // release supports — 2026.7.1 ships `backup create` and `backup verify` only.
        // Restore arrived with OpenClaw 2.0. The previous implementation piped an
        // archive into `openclaw-ctl backup restore --stdin`: neither the binary nor
        // the subcommand exists, so it never restored anything.
        //
        // Failing with an explanation beats a hand-rolled untar into a live state
        // directory, which is how backups get turned into corruption.
        throw new UsageError(
          'Restore is not available on this clawops release.\n' +
            'OpenClaw up to 2026.7.1-2 provides `backup create` and `backup verify` only; ' +
            'restore arrived in OpenClaw 2.0 and will be supported by clawops 2.x.\n' +
            'To recover manually: copy the archive to the host, then extract it into the ' +
            'gateway container with the gateway stopped.',
        )
      }
    } finally {
      release()
      drainPool()
    }
  },
})
