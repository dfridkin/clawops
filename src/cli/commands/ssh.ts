import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, failure } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'ssh',
    description: 'Open an SSH session to the stack instance',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    command: { type: 'string', description: 'Remote command to run (instead of interactive shell)' },
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

    const remoteCommand = typeof args.command === 'string' ? args.command : null

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
      if (remoteCommand) {
        const result = await session.exec(remoteCommand, abortController.signal)
        process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
        process.exit(result.code)
      } else {
        // Interactive shell: stream a login shell and pipe stdio
        const shellStream = await session.stream('bash -l', abortController.signal)
        shellStream.pipe(process.stdout)
        process.stdin.pipe(shellStream as unknown as NodeJS.WritableStream)

        await new Promise<void>((resolve) => {
          shellStream.on('end', resolve)
          shellStream.on('close', resolve)
          abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    } finally {
      release()
      drainPool()
    }
  },
})
