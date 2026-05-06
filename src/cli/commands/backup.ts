import { defineCommand } from 'citty'
import { createWriteStream, createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'
import { success, failure, info, spinner } from '../../output/human.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'backup',
    description: 'Create or restore an OpenClaw backup (create | restore)',
  },
  args: {
    action: { type: 'positional', description: 'Action: create | restore', required: true },
    out: { type: 'string', description: '[create] Local path to write the backup archive' },
    file: { type: 'string', description: '[restore] Local backup archive to restore from' },
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

        // Ask OpenClaw to stream a backup archive to stdout
        const backupStream = await session.stream(
          'docker exec openclaw openclaw-ctl backup create --stdout',
          abortController.signal,
        )

        spin.stop()
        const fileStream = createWriteStream(outPath)
        await pipeline(backupStream, fileStream)
        success(`Backup saved to ${outPath}`)
      } else {
        // restore
        const filePath = typeof args.file === 'string' ? args.file : null
        if (!filePath) {
          throw new UsageError('--file is required for backup restore')
        }

        if (!args.yes) {
          const { createInterface } = await import('node:readline/promises')
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          try {
            const answer = await rl.question(
              `Restore backup from "${filePath}" to stack "${ctx.stackName}"? This will overwrite existing data. (y/N) `,
            )
            if (answer.trim().toLowerCase() !== 'y') {
              info('Restore cancelled.')
              return
            }
          } finally {
            rl.close()
          }
        }

        info(`Restoring from ${filePath}...`)
        const spin = spinner('Transferring and restoring backup...')

        // Stream the archive into the restore command on the remote host
        const restoreStream = await session.stream(
          'docker exec -i openclaw openclaw-ctl backup restore --stdin',
          abortController.signal,
        )

        const fileStream = createReadStream(filePath)
        await pipeline(fileStream, restoreStream as unknown as NodeJS.WritableStream)
        spin.stop()
        success('Backup restored successfully')
      }
    } finally {
      release()
      drainPool()
    }
  },
})
