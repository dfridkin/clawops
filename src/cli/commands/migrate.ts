// `clawops migrate` — move a 1.x deployment onto the 2.0 runtime contract.
//
// The sequence lives in src/openclaw/migrate.ts; this supplies the effects. See that file
// for why the order is what it is — three assumptions in the original plan were wrong, and
// each was found by running a real migration rather than reasoning about one.

import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, success, failure, info, warn } from '../../output/human.js'
import { execPrivileged } from '../../transport/privileged.js'
import {
  STATE_DIR_HOST_LINUX, CONFIG_FILENAME, CONTAINER_UID, GATEWAY_PORT, gatewayRunCommand,
} from '../../openclaw/runtime.js'
import { probeCommand, interpretProbe } from '../../openclaw/health.js'
import { migrate, describeMigration, type MigrateSteps } from '../../openclaw/migrate.js'

/** The config 1.x never had. Minimal and valid: enough for 2.0 to start. */
const SYNTHESISED_CONFIG = JSON.stringify({
  meta: { lastTouchedVersion: '2026.9.2' },
  gateway: { mode: 'local', port: GATEWAY_PORT, auth: { mode: 'token' } },
  models: {},
  channels: {},
})

export default defineCommand({
  meta: {
    name: 'migrate',
    description: 'Move a 1.x OpenClaw deployment onto the 2.0 runtime contract',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    'openclaw-version': { type: 'string', description: 'OpenClaw 2.x version to migrate to' },
    yes: { type: 'boolean', description: 'Skip the confirmation prompt' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')
    const { guardOpenclawVersion, defaultOpenclawVersion } = await import('../version-guard.js')

    // Guards the TARGET only. The source is a 1.x release this line refuses by design —
    // that is the whole reason to migrate — so running the guard over it would refuse the
    // very deployment this command exists to rescue.
    const requested = typeof args['openclaw-version'] === 'string' ? args['openclaw-version'] : undefined
    const target = requested ? await guardOpenclawVersion(requested) : await defaultOpenclawVersion()
    const targetImage = `ghcr.io/openclaw/openclaw:${target}`

    const ctx = buildContext(args)
    const stack = await ctx.getStack()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(await stack.outputs()).map(([k, v]) => [k, v.value]),
    )
    const conn = ctx.adapter.getConnectionInfo({
      ...extractBaseOutputs(outputs),
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })

    const ac = new AbortController()
    process.on('SIGINT', () => ac.abort())

    const { session, release } = await acquireSession({
      host: conn.host, port: conn.port, user: conn.user,
      privateKeyPath: conn.privateKeyPath, knownHostsPath: conn.knownHostsPath,
      signal: ac.signal,
    })

    const spin = spinner('Inspecting the deployment...')
    const run = (cmd: string) => execPrivileged(session, cmd, ac.signal)
    const archive = '/tmp/clawops-premigration.tar.gz'
    const configPath = `${STATE_DIR_HOST_LINUX}/${CONFIG_FILENAME}`

    const steps: MigrateSteps = {
      inspectSource: async () => {
        const r = await run(`docker inspect openclaw --format '{{.Config.Image}}'`)
        const image = r.stdout.trim()
        return r.code === 0 && image.includes(':') ? image : undefined
      },

      backup: async () => {
        spin.text = 'Taking a verified backup...'
        // Inside the RUNNING 1.x container — verified present in 2026.7.1 by SP-07.
        const r = await run(
          `docker exec openclaw openclaw backup create --output ${archive} --verify --json`,
        )
        return r.code === 0
          ? { ok: true, detail: `${archive} on the host (verified)` }
          : { ok: false, detail: (r.stderr || r.stdout).slice(0, 200) }
      },

      extract: async () => {
        spin.text = 'Extracting state from the running container...'
        const mk = await run(`mkdir -p ${STATE_DIR_HOST_LINUX}`)
        if (mk.code !== 0) return { ok: false, entries: [] }
        // `docker cp` from the RUNNING container. Stopping first would destroy it.
        const cp = await run(`docker cp openclaw:/home/node/.openclaw/. ${STATE_DIR_HOST_LINUX}/`)
        if (cp.code !== 0) return { ok: false, entries: [] }
        const ls = await run(`ls ${STATE_DIR_HOST_LINUX}`)
        return { ok: true, entries: ls.stdout.trim().split(/\s+/).filter(Boolean) }
      },

      chown: async () => {
        // Numeric. `useradd clawops` is uid 1001 on Ubuntu 24.04 while the container runs
        // as 1000, and a mismatch makes the gateway exit 1 on its own SQLite WAL (G25).
        await run(`chown -R ${CONTAINER_UID}:${CONTAINER_UID} ${STATE_DIR_HOST_LINUX}`)
      },

      removeSource: async () => {
        spin.text = 'Stopping the 1.x container...'
        await run('docker stop openclaw 2>/dev/null || true')
        await run('docker rm   openclaw 2>/dev/null || true')
      },

      writeConfig: async () => {
        // Synthesised, not carried forward: 1.x never had a config that applied, and its
        // channel blocks would not validate against the 2.0 schema.
        const b64 = Buffer.from(SYNTHESISED_CONFIG, 'utf-8').toString('base64')
        await run(
          `echo '${b64}' | base64 -d > ${configPath} && ` +
            `chown ${CONTAINER_UID}:${CONTAINER_UID} ${configPath}`,
        )
      },

      start: async () => {
        spin.text = 'Starting the 2.0 gateway...'
        await run(gatewayRunCommand({ image: targetImage, stateDir: STATE_DIR_HOST_LINUX }))
      },

      gate: async () => {
        spin.text = 'Waiting for the gateway to start...'
        let last: string | undefined
        for (let i = 0; i < 15; i++) {
          if (ac.signal.aborted) return { ok: false, reason: 'aborted' }
          const r = await run(probeCommand('started', GATEWAY_PORT))
          const v = interpretProbe('started', r.stdout)
          if (v.ok) return { ok: true }
          last = v.reason
          await new Promise((res) => setTimeout(res, 2000))
        }
        return { ok: false, reason: last ?? 'no response' }
      },

      deviceId: async () => {
        // Before migration it is a file; afterwards it has moved into SQLite, so read
        // whichever is present. A missing value is reported as unknown, never as continuity.
        const file = await run(
          `docker exec openclaw sh -c 'cat ~/.openclaw/identity/device.json 2>/dev/null' ` +
            `|| cat ${STATE_DIR_HOST_LINUX}/identity/device.json 2>/dev/null || true`,
        )
        try {
          const parsed = JSON.parse(file.stdout.trim()) as { deviceId?: string }
          return parsed.deviceId
        } catch {
          return undefined
        }
      },
    }

    try {
      const outcome = await migrate(steps)
      spin.stop()
      const report = describeMigration(outcome)

      if (outcome.kind === 'migrated') {
        success(report.split('\n')[0]!)
        for (const line of report.split('\n').slice(1)) {
          if (/CHANGED|could not be compared/.test(line)) warn(line)
          else info(line)
        }
        info(`Pre-migration backup: ${archive}`)
      } else {
        failure(report)
        process.exit(outcome.kind === 'nothing-to-migrate' ? 0 : 1)
      }
    } finally {
      release()
      drainPool()
    }
  },
})
