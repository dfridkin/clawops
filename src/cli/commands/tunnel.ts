import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { spinner, success } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'tunnel',
    description: 'Forward the OpenClaw gateway port to localhost',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    port: { type: 'string', description: 'Local port to listen on (default: same as gateway)' },
    'no-open': { type: 'boolean', description: 'Do not open browser after tunnel is ready' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { acquireSession } = await import('../../transport/pool.js')

    const ctx = buildContext(args)
    const stack = await ctx.getStack()
    const outputMap = await stack.outputs()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(outputMap).map(([k, v]) => [k, v.value]),
    )
    const base = extractBaseOutputs(outputs)

    // Parse remote port from gatewayUrl (e.g. https://1.2.3.4:18789)
    const gatewayUrl = new URL(base.gatewayUrl)
    const remotePort = parseInt(gatewayUrl.port, 10) || 443
    const localPort = args.port ? parseInt(String(args.port), 10) : remotePort

    const conn = ctx.adapter.getConnectionInfo({
      ...base,
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })

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
      const handle = await session.tunnel(localPort, 'localhost', remotePort, abortController.signal)
      const localUrl = `http://localhost:${handle.localPort}`

      success(`Tunnel ready: ${localUrl}`)
      process.stdout.write('Press Ctrl+C to close.\n')

      if (!args['no-open']) {
        openBrowser(localUrl)
      }

      await new Promise<void>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(), { once: true })
      })

      handle.close()
    } finally {
      release()
    }
  },
})

function openBrowser(url: string): void {
  const [cmd, ...cmdArgs] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', url]
        : ['xdg-open', url]
  spawn(cmd!, cmdArgs, { detached: true, stdio: 'ignore' }).unref()
}
