import { defineCommand } from 'citty'
import { writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { success, failure, warn, info, chalk } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import {
  secretsDir,
  resolveSecretPath,
  listSecrets,
  auditSecrets,
  prepareSecretDelete,
  deletePreparedSecret,
  deleteConfirmQuestion,
  auditIssuesHeadline,
  formatAuditIssue,
  NO_SECRETS_MESSAGE,
  SET_SECRET_HINT,
  AUDIT_CLEAN_MESSAGE,
  AUDIT_FIX_HINT,
} from '../../secrets/store.js'

/** The secret's file, or exit 2 when the name would point outside the secrets directory. */
function secretPathOrExit(name: string): string {
  const resolved = resolveSecretPath(name)
  if (!resolved.ok) {
    failure(resolved.reason)
    process.exit(2)
  }
  return resolved.path
}

// ── list ───────────────────────────────────────────────────────────────────

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List all stored secrets and their status' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  run({ args }) {
    const rows = listSecrets()

    if (rows.length === 0) {
      info(NO_SECRETS_MESSAGE)
      info(SET_SECRET_HINT)
      return
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
      return
    }

    const tableRows = rows.map((r) => [
      r.name,
      r.resolvable ? chalk.green('ok') : chalk.red(r.status),
      r.modified,
      r.path,
    ])
    process.stdout.write('\n' + renderTable(['Name', 'Status', 'Modified', 'Path'], tableRows) + '\n\n')
  },
})

// ── set ────────────────────────────────────────────────────────────────────

const setCmd = defineCommand({
  meta: { name: 'set', description: 'Create or update a secret' },
  args: {
    value: { type: 'string', description: 'Secret value (skips interactive prompt)' },
  },
  async run({ args }) {
    const [name] = (args._ ?? []) as string[]
    if (!name) {
      failure('Usage: clawops secret set <name>')
      process.exit(2)
    }
    const target = secretPathOrExit(name)

    const inquirer = (await import('inquirer')).default

    let value: string
    if (args.value) {
      value = args.value
    } else {
      const { secretValue } = await inquirer.prompt<{ secretValue: string }>([{
        type: 'password',
        name: 'secretValue',
        message: `Value for secret "${name}": (input is hidden)`,
        validate: (v: unknown) => (typeof v === 'string' && v.trim() !== '') || 'Value cannot be empty',
      }])
      value = secretValue
    }

    mkdirSync(secretsDir(), { recursive: true })
    spawnSync('chmod', ['700', secretsDir()], { stdio: 'ignore' })
    writeFileSync(target, value.trim(), { encoding: 'utf-8', mode: 0o600 })
    success(`Secret "${name}" saved to ${target}  (chmod 600)`)
    info('Run `clawops secret rotate <name>` to propagate it to a running stack.')
  },
})

// ── delete ─────────────────────────────────────────────────────────────────

const deleteCmd = defineCommand({
  meta: { name: 'delete', description: 'Remove a stored secret' },
  args: {
    yes: { type: 'boolean', description: 'Skip confirmation prompt' },
  },
  async run({ args }) {
    const [name] = (args._ ?? []) as string[]
    if (!name) {
      failure('Usage: clawops secret delete <name>')
      process.exit(2)
    }

    const prepared = prepareSecretDelete(name)
    if (!prepared.ok) {
      failure(prepared.reason)
      process.exit(prepared.kind === 'invalid-name' ? 2 : 1)
    }

    // Warn if any stored overlay still references this secret
    for (const line of prepared.warnings) warn(line)

    if (!args.yes) {
      const inquirer = (await import('inquirer')).default
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
        type: 'confirm',
        name: 'confirmed',
        message: deleteConfirmQuestion(name),
        default: false,
      }])
      if (!confirmed) { info('Aborted.'); return }
    }

    success(deletePreparedSecret(prepared))
  },
})

// ── rotate ─────────────────────────────────────────────────────────────────

const rotateCmd = defineCommand({
  meta: { name: 'rotate', description: 'Update a secret and re-apply config to a running stack' },
  args: {
    stack: { type: 'string', description: 'Stack name to re-apply (defaults to config default)' },
    value: { type: 'string', description: 'New secret value (skips interactive prompt)' },
  },
  async run({ args }) {
    const [name] = (args._ ?? []) as string[]
    if (!name) {
      failure('Usage: clawops secret rotate <name> [--stack <name>]')
      process.exit(2)
    }
    const target = secretPathOrExit(name)

    const inquirer = (await import('inquirer')).default

    // 1. Prompt for new value
    let value: string
    if (args.value) {
      value = args.value
    } else {
      const { secretValue } = await inquirer.prompt<{ secretValue: string }>([{
        type: 'password',
        name: 'secretValue',
        message: `New value for secret "${name}": (input is hidden)`,
        validate: (v: unknown) => (typeof v === 'string' && v.trim() !== '') || 'Value cannot be empty',
      }])
      value = secretValue
    }

    mkdirSync(secretsDir(), { recursive: true })
    spawnSync('chmod', ['700', secretsDir()], { stdio: 'ignore' })
    writeFileSync(target, value.trim(), { encoding: 'utf-8', mode: 0o600 })
    success(`Secret "${name}" updated.`)

    // 2. Determine target stack
    const { getConfig } = await import('../../config/store.js')
    const cfg = getConfig()
    const targetStack = args.stack ?? cfg?.defaults?.stack
    if (!targetStack) {
      warn('No stack specified and no default stack in config — skipping re-apply.')
      info('Run `clawops secret rotate <name> --stack <name>` to re-apply to a specific stack.')
      return
    }

    // 3. Load stored overlay for re-apply
    const { loadOverlay } = await import('../../plan/overlay-store.js')
    const stored = loadOverlay(targetStack)
    if (!stored) {
      warn(`No stored overlay for stack "${targetStack}" — cannot re-apply automatically.`)
      info('Re-run `clawops setup` or `clawops apply` to propagate the new secret.')
      return
    }

    // 4. Re-apply overlay to the running stack
    info(`Re-applying config overlay to stack "${targetStack}"…`)
    try {
      const { buildContext } = await import('../context.js')
      const { readRemoteConfig, atomicWriteConfig, restartGateway, deepMerge } = await import('../../plan/remote-config.js')
      const { resolveSecrets } = await import('../../plan/secrets.js')
      const { acquireSession, drainPool } = await import('../../transport/pool.js')
      const { localStateToConnectionInfo } = await import('../../providers/local/state.js')

      const ctx = buildContext({ stack: targetStack })

      let conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string }
      if (ctx.adapter.name === 'local') {
        if (!ctx.localState) throw new Error(`Stack "${targetStack}" has not been bootstrapped yet.`)
        conn = localStateToConnectionInfo(ctx.localState)
      } else {
        const stack = await ctx.getStack()
        const outputMap = await stack.outputs()
        const outputs: Record<string, unknown> = Object.fromEntries(
          Object.entries(outputMap).map(([k, v]) => [k, v.value]),
        )
        const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
        const base = extractBaseOutputs(outputs)
        conn = ctx.adapter.getConnectionInfo({ ...base, privateKeyPath: ctx.config.ssh.keyPath, knownHostsPath: ctx.config.ssh.knownHostsPath })
      }

      const { session, release } = await acquireSession(conn)
      try {
        const remote = await readRemoteConfig(session)
        const resolved = resolveSecrets(stored.overlay, stored.secrets)
        const merged = deepMerge(remote, resolved)
        await atomicWriteConfig(session, merged)
        await restartGateway(session)
      } finally {
        release()
        drainPool()
      }

      success(`Config overlay re-applied and gateway restarted on "${targetStack}".`)
    } catch (err) {
      failure(`Re-apply failed: ${(err as Error).message}`)
      info('The secret file has been updated. Re-run `clawops setup` or `clawops apply` to propagate.')
    }
  },
})

// ── audit ──────────────────────────────────────────────────────────────────

const auditCmd = defineCommand({
  meta: { name: 'audit', description: 'Report missing secrets and unresolvable $secret: refs' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args }) {
    const { issues } = auditSecrets()

    if (args.json) {
      process.stdout.write(JSON.stringify({ issues, ok: issues.length === 0 }, null, 2) + '\n')
      return
    }

    if (issues.length === 0) {
      success(AUDIT_CLEAN_MESSAGE)
      return
    }

    failure(`${auditIssuesHeadline(issues.length)}\n`)
    for (const issue of issues) warn(formatAuditIssue(issue))
    process.stdout.write('\n')
    info(AUDIT_FIX_HINT)
  },
})

// ── root ───────────────────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'secret',
    description: 'Manage clawops secrets (list | set | delete | rotate | audit)',
  },
  args: {},
  subCommands: {
    list: listCmd,
    set: setCmd,
    delete: deleteCmd,
    rotate: rotateCmd,
    audit: auditCmd,
  },
})
