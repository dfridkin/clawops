// clawops_harden handler
//
// The CLI's hardening surface, including the Tailscale flows, reached through one tool. The
// flows themselves are in src/harden/flows.ts, shared with `clawops harden`, so an agent gets
// the same refusals an operator does — a refusal that only the CLI enforces is not a safeguard.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { HardenInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { okText, errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { confirmDestructive } from '../_confirm.js'

export async function handleHarden(input: HardenInput, server: McpServer): Promise<CallToolResult> {
  if (input.tailscale && input.tailscaleRevert) {
    return errText(
      'tailscale and tailscaleRevert do the opposite of each other; pass one, not both.',
    )
  }

  const { getConfig } = await import('../../../config/store.js')
  const config = getConfig()
  if (!config) {
    return errText(
      'No clawops config on this machine. Call clawops_init first to register a stack; until ' +
        'then every clawops tool will say this.',
    )
  }

  const ctx = buildContext({ stack: input.stackName })

  // R19: anything that changes a live host is confirmed first. A dry run changes nothing.
  if (!input.dryRun && !input.yes) {
    const what = input.tailscaleRevert
      ? `Take "${ctx.stackName}" off its tailnet and go back to its public address?`
      : input.tailscale
        ? `Harden "${ctx.stackName}" and join it to your tailnet? clawops will use the tailnet address afterwards.`
        : `Apply hardening modules to "${ctx.stackName}"? This changes the running host.`
    const confirmation = await confirmDestructive(server, {
      message: what,
      title: 'Confirm',
      what: 'changing a running host',
    })
    if (!confirmation.confirmed) {
      return okText(confirmation.reason)
    }
  }

  const { revertTailnet, cutOverToTailnet, connectionFor } = await import('../../../harden/flows.js')

  // Revert is its own errand: it runs over the public address and touches no modules.
  if (input.tailscaleRevert) {
    const outcome = await revertTailnet(ctx, config)
    return outcome.ok ? okText(outcome.message) : errText(outcome.reason)
  }

  const { MODULE_CATALOG, resolveModules, runHardening, formatHardenSummary, makeTailscaleModule } =
    await import('../../../harden/index.js')

  const forStack = makeTailscaleModule(ctx.stackName)
  const resolved = resolveModules(MODULE_CATALOG, input.options, ctx.adapter.name).map((m) =>
    m.id === 'tailscale' ? forStack : m,
  )
  const modules =
    input.tailscale && !resolved.some((m) => m.id === 'tailscale') ? [...resolved, forStack] : resolved

  if (modules.length === 0) {
    return okText(
      `No hardening modules apply to "${ctx.stackName}" (provider: ${ctx.adapter.name}) with those options.`,
    )
  }

  let conn
  try {
    conn = await connectionFor(ctx, config)
  } catch (err) {
    /*
     * A Pulumi automation failure arrives as a multi-line subprocess dump whose first line is
     * `code: -2`. Passed through, an agent is told nothing it can act on, so the actionable
     * part is said plainly and the dump is trimmed to a tail the user can search for.
     */
    const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim()
    return errText(
      `Stack "${ctx.stackName}" has no deployment to harden, or clawops could not read its ` +
        'state. Deploy it first, and check the credentials for its state backend. ' +
        `(${detail.slice(0, 200)})`,
    )
  }

  const results = await runHardening(conn, { modules, dryRun: input.dryRun })

  const lines = [formatHardenSummary(results)]
  const failed = results.filter((r) => r.error)
  for (const r of failed) lines.push(`FAILED  ${r.module.label}: ${r.error}`)

  // The cutover only runs once the modules it depends on have actually run.
  if (input.tailscale && !input.dryRun && failed.length === 0) {
    const outcome = await cutOverToTailnet(ctx, conn, config)
    if (!outcome.ok) {
      lines.push(
        `The host is hardened, but clawops still uses its public address: ${outcome.reason}`,
      )
      const { content } = trimForMcp(lines.join('\n'), ctx.stackName)
      return errText(content)
    }
    lines.push(outcome.message)
    lines.push(
      'To close the public ports, plan with privateOnly: true and apply that plan. ' +
        'Nothing has been closed yet.',
    )
  }

  const { content } = trimForMcp(lines.join('\n'), ctx.stackName)
  return failed.length > 0 ? errText(content) : okText(content)
}
