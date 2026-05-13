import { defineCommand } from 'citty'
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { success, failure, warn, info, chalk } from '../../output/human.js'
import { renderTable } from '../../output/table.js'

const SECRETS_DIR = path.join(os.homedir(), '.clawops', 'secrets')

function secretsDir(): string { return SECRETS_DIR }

function secretPath(name: string): string {
  return path.join(secretsDir(), name)
}

function listSecretNames(): string[] {
  if (!existsSync(secretsDir())) return []
  return readdirSync(secretsDir()).filter((f) => !f.startsWith('.'))
}

// ── list ───────────────────────────────────────────────────────────────────

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List all stored secrets and their status' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  run({ args }) {
    const names = listSecretNames()

    if (names.length === 0) {
      info('No secrets stored in ~/.clawops/secrets/')
      info('Run `clawops secret set <name>` to add one.')
      return
    }

    const rows = names.map((name) => {
      const p = secretPath(name)
      try {
        const stat = statSync(p)
        const content = readFileSync(p, 'utf-8').trim()
        const status = content.length > 0 ? 'ok' : 'empty'
        const modified = stat.mtime.toISOString().slice(0, 10)
        return { name, status, source: 'file', path: p, modified, resolvable: content.length > 0 }
      } catch {
        return { name, status: 'unreadable', source: 'file', path: p, modified: '—', resolvable: false }
      }
    })

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
    writeFileSync(secretPath(name), value.trim(), { encoding: 'utf-8', mode: 0o600 })
    success(`Secret "${name}" saved to ${secretPath(name)}  (chmod 600)`)
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

    const p = secretPath(name)
    if (!existsSync(p)) {
      failure(`Secret "${name}" not found at ${p}`)
      process.exit(1)
    }

    // Warn if any stored overlay still references this secret
    const { listOverlays } = await import('../../plan/overlay-store.js')
    const referencingStacks = listOverlays()
      .filter((o) => o.secrets.some((s) => s.name === name))
      .map((o) => o.stackName)

    if (referencingStacks.length > 0) {
      warn(`Secret "${name}" is referenced by stack(s): ${referencingStacks.join(', ')}`)
      warn('Deleting it will leave those stacks with an unresolvable $secret: ref.')
    }

    if (!args.yes) {
      const inquirer = (await import('inquirer')).default
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
        type: 'confirm',
        name: 'confirmed',
        message: `Delete secret "${name}"?`,
        default: false,
      }])
      if (!confirmed) { info('Aborted.'); return }
    }

    unlinkSync(p)
    success(`Secret "${name}" deleted.`)
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
    writeFileSync(secretPath(name), value.trim(), { encoding: 'utf-8', mode: 0o600 })
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
    const { listOverlays } = await import('../../plan/overlay-store.js')
    const overlays = listOverlays()

    const issues: Array<{ kind: string; stack?: string; secret: string; detail: string }> = []

    // 1. Check every known secret file is readable and non-empty
    for (const name of listSecretNames()) {
      const p = secretPath(name)
      try {
        const content = readFileSync(p, 'utf-8').trim()
        if (content.length === 0) {
          issues.push({ kind: 'empty-secret', secret: name, detail: `File exists but is empty: ${p}` })
        }
      } catch {
        issues.push({ kind: 'unreadable-secret', secret: name, detail: `Cannot read: ${p}` })
      }
    }

    // 2. Check every overlay's secret refs are resolvable
    for (const overlay of overlays) {
      for (const s of overlay.secrets) {
        if (s.source === 'file') {
          const ref = s.ref ?? secretPath(s.name)
          if (!existsSync(ref)) {
            issues.push({ kind: 'missing-file', stack: overlay.stackName, secret: s.name, detail: `File not found: ${ref}` })
          }
        } else if (s.source === 'env') {
          const envVar = s.ref ?? s.name
          if (!process.env[envVar]) {
            issues.push({ kind: 'missing-env', stack: overlay.stackName, secret: s.name, detail: `Env var not set: ${envVar}` })
          }
        } else {
          issues.push({ kind: 'cloud-sm-unresolved', stack: overlay.stackName, secret: s.name, detail: `Source "${s.source}" is not auto-resolved — set manually` })
        }
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify({ issues, ok: issues.length === 0 }, null, 2) + '\n')
      return
    }

    if (issues.length === 0) {
      success('All secrets are resolvable. No issues found.')
      return
    }

    failure(`${issues.length} issue${issues.length === 1 ? '' : 's'} found:\n`)
    for (const issue of issues) {
      const prefix = issue.stack ? `[${issue.stack}] ` : ''
      warn(`${prefix}${issue.secret}: ${issue.detail}`)
    }
    process.stdout.write('\n')
    info('Run `clawops secret set <name>` to update a missing or empty secret.')
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
  run() {
    process.stdout.write('Usage: clawops secret <list | set | delete | rotate | audit>\n\n')
    process.stdout.write('  list     Show all stored secrets and their status\n')
    process.stdout.write('  set      Create or update a secret\n')
    process.stdout.write('  delete   Remove a stored secret\n')
    process.stdout.write('  rotate   Update a secret and re-apply config to a running stack\n')
    process.stdout.write('  audit    Report missing secrets and unresolvable refs\n\n')
    process.stdout.write('Run `clawops secret <command> --help` for flags.\n')
  },
})
