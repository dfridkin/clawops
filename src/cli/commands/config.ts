import { defineCommand } from 'citty'
import { gatewayRunCommand } from '../../openclaw/run-flags.js'
import process from 'node:process'
import { success, failure, warn, info } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { validateOpenclawConfig } from '../../mcp/tools/cli/config.js'

const OPENCLAW_CONFIG = '/home/clawops/openclaw.json'
const OPENCLAW_TMP = '/tmp/clawops-config.json.tmp'

/** docker stop + rm + run with the given full image reference and config mount. */
export function dockerRunCmd(image: string): string {
  return gatewayRunCommand({ image, configPath: OPENCLAW_CONFIG })
}

/** Read a nested value from obj using dot-notation key. */
function getPath(obj: Record<string, unknown>, dotKey: string): unknown {
  return dotKey.split('.').reduce<unknown>((cur, k) => {
    if (cur !== null && typeof cur === 'object') return (cur as Record<string, unknown>)[k]
    return undefined
  }, obj)
}

/** Set a nested value in obj using dot-notation key, creating intermediate objects. */
function setPath(obj: Record<string, unknown>, dotKey: string, value: unknown): void {
  const keys = dotKey.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]!] = value
}

/** Delete a nested key from obj using dot-notation. */
function deletePath(obj: Record<string, unknown>, dotKey: string): void {
  const keys = dotKey.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!
    if (typeof cur[k] !== 'object' || cur[k] === null) return
    cur = cur[k] as Record<string, unknown>
  }
  delete cur[keys[keys.length - 1]!]
}

export default defineCommand({
  meta: {
    name: 'config',
    description: 'Manage OpenClaw gateway configuration (get | set | unset)',
  },
  args: {
    stack:     { type: 'string',  description: 'Target stack name' },
    restart:   { type: 'boolean', description: 'Restart gateway after set/unset' },
    json:      { type: 'boolean', description: 'Emit JSON (for get)' },
    'dry-run': { type: 'boolean', description: 'Show what would change without writing' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')

    const [action, key, value] = (args._ ?? []) as string[]

    if (!action || !['get', 'set', 'unset', 'validate'].includes(action)) {
      failure('Usage: clawops config <get [key] | set key value | unset key | validate>')
      process.exit(2)
    }
    if (action === 'set' && (!key || value === undefined)) {
      failure('Usage: clawops config set <key> <value>')
      process.exit(2)
    }
    if (action === 'unset' && !key) {
      failure('Usage: clawops config unset <key>')
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
      // Read current config from remote VM
      const readResult = await session.exec(`cat ${OPENCLAW_CONFIG}`, abortController.signal)
      let cfg: Record<string, unknown>
      try {
        cfg = JSON.parse(readResult.stdout) as Record<string, unknown>
      } catch {
        failure(`Cannot parse ${OPENCLAW_CONFIG}: ${readResult.stderr || readResult.stdout}`)
        process.exit(1)
      }

      if (action === 'get') {
        const result = key ? getPath(cfg, key) : cfg
        if (args.json) {
          printJson(jsonOk(result))
        } else {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        }
        return
      }

      if (action === 'validate') {
        const issues = validateOpenclawConfig(cfg)
        if (issues.length === 0) {
          success('Config is valid.')
        } else {
          for (const issue of issues) warn(issue)
          failure(`Config has ${issues.length} issue(s).`)
          process.exit(1)
        }
        return
      }

      if (action === 'set') {
        // Try to coerce value to JSON; fall back to raw string
        let parsedValue: unknown = value
        try { parsedValue = JSON.parse(value!) } catch { /* keep string */ }
        setPath(cfg, key!, parsedValue)
      } else {
        deletePath(cfg, key!)
      }

      if (args['dry-run']) {
        info(`Dry run — would write to ${OPENCLAW_CONFIG}:`)
        process.stdout.write(JSON.stringify(cfg, null, 2) + '\n')
        return
      }

      // Atomic write via base64 to avoid shell-escaping issues
      const json = JSON.stringify(cfg, null, 2)
      const b64 = Buffer.from(json, 'utf-8').toString('base64')
      const writeCmd =
        `echo '${b64}' | base64 -d > ${OPENCLAW_TMP} && ` +
        `mv ${OPENCLAW_TMP} ${OPENCLAW_CONFIG} && ` +
        `chown clawops:clawops ${OPENCLAW_CONFIG}`

      const writeResult = await session.exec(writeCmd, abortController.signal)
      if (writeResult.code !== 0) {
        failure(`Failed to write config: ${writeResult.stderr}`)
        process.exit(1)
      }

      success(`config ${action}: ${key ?? '(all)'}`)

      if (args.restart) {
        info('Restarting gateway...')
        // Read current image version to preserve it
        const imgResult = await session.exec(
          `docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null || echo 'ghcr.io/openclaw/openclaw:stable'`,
          abortController.signal,
        )
        const image = imgResult.stdout.trim()
        const restartResult = await session.exec(dockerRunCmd(image), abortController.signal)
        if (restartResult.code !== 0) {
          failure(`Restart failed: ${restartResult.stderr}`)
          process.exit(1)
        }
        success('Gateway restarted.')
      }
    } finally {
      release()
      drainPool()
    }
  },
})
