// Maker plan apply — per SPEC.md §12.6.

import { buildContext } from '../cli/context.js'
import process from 'node:process'
import { UsageError } from '../errors/index.js'
import { validatePlan } from './validate.js'
import { resolveSecrets } from './secrets.js'
import { saveOverlay } from './overlay-store.js'
import { readRemoteConfig, atomicWriteConfig, restartGateway, deepMerge } from './remote-config.js'
import type { DeployPlan } from './generate.js'
import { writeStackConfig } from './stack-config.js'

export interface ApplyPlanOpts {
  onOutput?: (line: string) => void
  signal?: AbortSignal
  /** Called when drift is detected, before stack.up(). Implementations should prompt the user or throw to abort. */
  confirmDrift?: () => Promise<void>
}

export interface ApplyPlanResult {
  outputs: Record<string, unknown>
  changeSummary: Record<string, number>
  durationMs: number
}

export async function applyPlan(
  plan: DeployPlan,
  opts?: ApplyPlanOpts,
): Promise<ApplyPlanResult> {
  const validation = validatePlan(plan)
  if (!validation.ok) {
    throw new UsageError(
      `Invalid deploy plan:\n${validation.errors.join('\n')}`,
    )
  }

  if (plan.spec.provider === 'local') {
    throw new UsageError(
      'plan/apply is not supported for the local provider. Use `clawops up` directly.',
    )
  }

  // A plan can be generated on one clawops line and applied on another, so the
  // version is re-checked here rather than trusted from plan generation.
  const { guardOpenclawVersion } = await import('../cli/version-guard.js')
  await guardOpenclawVersion(plan.spec.openclaw.version)

  const ctx = buildContext({
    stack: plan.spec.stackName,
    provider: plan.spec.provider,
  })

  const stack = await ctx.getStack()

  await writeStackConfig(stack, plan)

  // Drift detection (ADR 0008): warn if stack was updated after the plan was generated.
  if (plan.metadata.stackVersion !== undefined) {
    const currentInfo = await stack.info()
    if (currentInfo !== undefined && currentInfo.version !== plan.metadata.stackVersion) {
      process.stderr.write(
        `\nWarning: stack "${plan.spec.stackName}" has changed since this plan was generated ` +
        `(plan version: ${plan.metadata.stackVersion}, current: ${currentInfo.version}).\n` +
        `The diff you reviewed may no longer reflect what will be applied.\n\n`,
      )
      if (opts?.confirmDrift) {
        await opts.confirmDrift()
      }
    }
  }

  const start = Date.now()
  const result = await stack.up({ onOutput: opts?.onOutput, signal: opts?.signal })

  const outputs: Record<string, unknown> = Object.fromEntries(
    Object.entries(result.outputs).map(([k, v]) => [k, v.value]),
  )

  const changeSummary: Record<string, number> = {}
  if (result.summary.resourceChanges) {
    for (const [op, count] of Object.entries(result.summary.resourceChanges)) {
      changeSummary[op] = count
    }
  }

  // The instance exists; it is not necessarily up. Pulumi returns as soon as the API accepts
  // the resource, and sshd starts a good half-minute later — so apply used to print its success
  // line, the gateway URL and the public IP while every command that followed failed with
  // ECONNREFUSED, including its own config overlay a few lines below this.
  const { waitForSsh } = await import('../transport/wait.js')
  await waitForSsh(await connectionInfoFor(ctx, outputs), {
    signal: opts?.signal,
    onProgress: (line) => opts?.onOutput?.(line),
  })

  // Post-provisioning: write config overlay + channels to the remote openclaw.json.
  const hasOverlay = plan.spec.openclaw.config !== undefined || plan.spec.openclaw.channels !== undefined
  if (hasOverlay) {
    await applyConfigOverlay(plan, outputs, ctx, opts?.signal)
  }

  return {
    outputs,
    changeSummary,
    durationMs: Date.now() - start,
  }
}

/**
 * Where the instance is, and which key opens it.
 *
 * `getConnectionInfo` reads `privateKeyPath` and `knownHostsPath` out of the object it is
 * handed, and a stack's outputs do not contain them — they are the operator's, from
 * `~/.clawops/config.json`. Every other caller merges them in first; apply passed raw outputs,
 * so it built a connection with an empty key path:
 *
 *   Cannot read SSH private key at : ENOENT: no such file or directory, open ''
 *
 * That was true of the config-overlay step from the beginning. It had simply never run against
 * a real deployment.
 */
async function connectionInfoFor(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  outputs: Record<string, unknown>,
): Promise<{
  host: string
  port: number
  user: string
  privateKeyPath: string
  knownHostsPath: string
}> {
  const { extractBaseOutputs } = await import('../pulumi/outputs.js')
  return ctx.adapter.getConnectionInfo({
    ...extractBaseOutputs(outputs),
    privateKeyPath: expandHome(ctx.config.ssh.keyPath),
    knownHostsPath: expandHome(ctx.config.ssh.knownHostsPath),
  })
}

/** `~` in a configured path is the operator's home, not a directory called "~". */
function expandHome(p: string): string {
  return p.replace(/^~/, process.env['HOME'] ?? '~')
}

async function applyConfigOverlay(
  plan: DeployPlan,
  outputs: Record<string, unknown>,
  ctx: Awaited<ReturnType<typeof buildContext>>,
  signal?: AbortSignal,
): Promise<void> {
  const { connect } = await import('../transport/ssh.js')

  const session = await connect({ ...(await connectionInfoFor(ctx, outputs)), signal })

  try {
    const remote = await readRemoteConfig(session, signal)

    // Resolve $secret: references in the config overlay.
    const configOverlay = plan.spec.openclaw.config ?? {}
    const resolvedOverlay = resolveSecrets(
      configOverlay as Record<string, unknown>,
      (plan.spec.secrets ?? []) as Array<{ name: string; source: 'env' | 'aws-sm' | 'aws-ssm' | 'gcp-sm' | 'azure-kv' | 'file'; ref?: string }>,
    )

    // Merge channels separately so they replace rather than deep-merge.
    const merged = deepMerge(remote, {
      ...resolvedOverlay,
      ...(plan.spec.openclaw.channels !== undefined
        ? { channels: plan.spec.openclaw.channels }
        : {}),
    })

    await atomicWriteConfig(session, merged, signal, {
      openclawVersion: plan.spec.openclaw.version,
    })

    // Install any provider plugin the config names but the image does not bundle, BEFORE
    // the restart — while this deploy still has egress. Left to the gateway, a missing
    // plugin is either fetched mid-boot at the cost of a convergence restart, or silently
    // absent on a deny-all host, which is clawops's default. See src/openclaw/plugins.ts.
    await installProviderPlugins(session, merged, plan.spec.openclaw.version, signal)

    // Channels are install-gated too, and for the same reason: a configured channel with no
    // plugin gives a gateway that starts, reports healthy, and never connects.
    await installChannelPlugins(session, merged, plan.spec.openclaw.version, signal)

    await restartGateway(session, signal)

    // A green gateway says nothing about whether the provider or channel loaded, so ask.
    await verifyProviders(session, merged, signal)
    await verifyChannels(session, merged, signal)
    saveOverlay(plan.spec.stackName, configOverlay as Record<string, unknown>, plan.spec.secrets ?? [])
  } finally {
    session.close()
  }
}

/**
 * Install provider plugins the config needs and the image does not bundle.
 *
 * Failures warn rather than throw: the deployment is otherwise healthy, and
 * `verifyProviders` reports the consequence in terms the operator can act on.
 */
async function installProviderPlugins(
  session: import('../transport/ssh.js').SshSession,
  cfg: Record<string, unknown>,
  openclawVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  const [{ requiredPlugins, installCommand }, { STATE_DIR_HOST_LINUX }, yaml, { readFileSync }, { join }, { resolveSpecDir }] =
    await Promise.all([
      import('../openclaw/plugins.js'),
      import('../openclaw/runtime.js'),
      import('js-yaml'),
      import('node:fs'),
      import('node:path'),
      import('../spec-path.js'),
    ])

  const catalog = yaml.load(
    readFileSync(join(resolveSpecDir(), 'models.yaml'), 'utf-8'),
  ) as { providers: Array<{ id: string; configPath?: string; plugin?: { package: string; version: string } }> }

  const needed = requiredPlugins(cfg, catalog)
  if (needed.length === 0) return

  const { execPrivileged } = await import('../transport/privileged.js')
  const image = `ghcr.io/openclaw/openclaw:${openclawVersion}`
  for (const plugin of needed) {
    const result = await execPrivileged(
      session,
      installCommand(plugin, image, STATE_DIR_HOST_LINUX),
      signal,
    )
    if (result.code !== 0) {
      process.stderr.write(
        `[clawops] warning: could not install ${plugin.package}@${plugin.version} for ` +
          `provider "${plugin.providerId}": ${result.stderr || result.stdout}\n`,
      )
    }
  }
}

/**
 * Check that every configured provider actually loaded.
 *
 * The failure this exists for is quiet: on a deny-all host the gateway starts healthy
 * without the provider, so nothing in a normal deploy would report it.
 */
async function verifyProviders(
  session: import('../transport/ssh.js').SshSession,
  cfg: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const { missingProviders } = await import('../openclaw/plugins.js')
  const { execPrivileged } = await import('../transport/privileged.js')
  const result = await execPrivileged(
    session,
    'docker exec openclaw openclaw plugins list --json',
    signal,
  )
  if (result.code !== 0) return

  const missing = missingProviders(cfg, result.stdout)
  if (missing.length > 0) {
    process.stderr.write(
      `[clawops] warning: the gateway is running, but these configured model providers ` +
        `did not load: ${missing.join(', ')}.\n` +
        `[clawops] The deployment will look healthy and fail on first use. Check egress to ` +
        `ClawHub, then re-run apply.\n`,
    )
  }
}

/** The channel catalog, read from spec. */
async function loadChannelCatalog(): Promise<{
  integrations: Array<{ channelKey: string; plugin?: { package: string; source: string; version?: string } }>
}> {
  const [yaml, { readFileSync }, { join }, { resolveSpecDir }] = await Promise.all([
    import('js-yaml'),
    import('node:fs'),
    import('node:path'),
    import('../spec-path.js'),
  ])
  return yaml.load(readFileSync(join(resolveSpecDir(), 'integrations.yaml'), 'utf-8')) as {
    integrations: Array<{ channelKey: string; plugin?: { package: string; source: string; version?: string } }>
  }
}

/**
 * Install channel plugins the config names.
 *
 * `openclaw plugins install`, not `openclaw channels add`. The latter installs and
 * configures in one step, and returns 0 whether or not the install succeeded — it prints the
 * failure, says "Returning to selection", and exits 0. Measured on 2026.9.2.
 */
async function installChannelPlugins(
  session: import('../transport/ssh.js').SshSession,
  cfg: Record<string, unknown>,
  openclawVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  const [{ requiredChannelPlugins, channelInstallCommand }, { STATE_DIR_HOST_LINUX }] =
    await Promise.all([import('../openclaw/channels.js'), import('../openclaw/runtime.js')])

  const needed = requiredChannelPlugins(cfg, await loadChannelCatalog())
  if (needed.length === 0) return

  const { execPrivileged } = await import('../transport/privileged.js')
  const image = `ghcr.io/openclaw/openclaw:${openclawVersion}`
  for (const plugin of needed) {
    const result = await execPrivileged(
      session,
      channelInstallCommand(plugin, image, STATE_DIR_HOST_LINUX),
      signal,
    )
    if (result.code !== 0) {
      process.stderr.write(
        `[clawops] warning: could not install ${plugin.package}@${plugin.version} for ` +
          `channel "${plugin.channelKey}": ${result.stderr || result.stdout}\n`,
      )
    }
  }
}

/**
 * Check that every configured channel is actually installed.
 *
 * Asked of `channels list`, not inferred from an exit code — the command that installs and
 * configures a channel reports success either way.
 */
async function verifyChannels(
  session: import('../transport/ssh.js').SshSession,
  cfg: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const { missingChannels, CHANNELS_LIST_CMD } = await import('../openclaw/channels.js')
  const { execPrivileged } = await import('../transport/privileged.js')
  const result = await execPrivileged(session, CHANNELS_LIST_CMD, signal)
  if (result.code !== 0) return

  const missing = missingChannels(cfg, result.stdout, await loadChannelCatalog())
  if (missing.length > 0) {
    process.stderr.write(
      `[clawops] warning: the gateway is running, but these configured channels are not ` +
        `installed: ${missing.join(', ')}.\n` +
        `[clawops] They will never connect. Check egress to registry.npmjs.org, then re-run ` +
        `apply.\n`,
    )
  }
}
