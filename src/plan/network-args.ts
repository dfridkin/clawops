// Turning `--ssh-cidr` / `--gateway-cidr` / `--publish-gateway` into a plan's network block.
//
// `clawops plan` had no way to express any of this. The intent type carried the fields and
// the wizard filled them, but the non-interactive path fell through to:
//
//   const network = intent.network ?? { allowedSshCidrs: [], allowedGatewayCidrs: [] }
//
// so every plan generated from the CLI described a host nothing could connect to. Deny-all is
// the right default (N10) — a plan that cannot say otherwise is not.
//
// `auto` resolves here, at plan time, and the resolved address is written into the plan.
// Resolving it during apply would leave the plan unable to say which address it admits, and
// the plan is the artifact the operator reviews (F5–F6).

import { UsageError } from '../errors/index.js'

/**
 * Same shape the wizard accepts: a dotted quad with a prefix, or anything containing a colon
 * (IPv6, which is left to the provider to reject — clawops has never parsed it).
 */
export function isCidr(value: string): boolean {
  const v = value.trim()
  if (v.includes(':')) return true
  return /^(\d{1,3}\.){3}\d{1,3}\/(3[0-2]|[12]?\d)$/.test(v)
}

/**
 * Split a comma-separated flag value, rejecting anything that is not a CIDR. An empty value
 * yields an empty list: `--ssh-cidr ''` is a way to say "none", not an error.
 */
export function parseCidrList(flag: string, value: string): string[] {
  const parts = value.split(',').map((s) => s.trim()).filter((s) => s !== '')
  for (const p of parts) {
    if (!isCidr(p)) {
      throw new UsageError(
        `${flag}: "${p}" is not a CIDR. Use an address and a prefix, e.g. 203.0.113.4/32.`,
      )
    }
  }
  return parts
}

export function parsePublishGateway(value: string): 'loopback' | 'all' {
  const v = value.trim()
  if (v === 'loopback' || v === 'all') return v
  throw new UsageError(`--publish-gateway: expected "loopback" or "all", got "${v}".`)
}

export interface NetworkFlags {
  sshCidr?: string
  gatewayCidr?: string
  publishGateway?: string
}

export interface ResolvedNetwork {
  allowedSshCidrs: string[]
  allowedGatewayCidrs: string[]
  publishGateway?: 'loopback' | 'all'
}

/**
 * `auto` means "this machine": the egress address as a /32, the same answer the wizard offers.
 * Detection failing is an error rather than a fallback — falling back to no rules produces a
 * host nobody can reach, and falling back to 0.0.0.0/0 is what N10 forbids.
 */
export async function resolveNetworkFlags(
  flags: NetworkFlags,
  deps: { detectEgressIp: () => Promise<{ ok: true; ip: string } | { ok: false; error: string }> },
): Promise<ResolvedNetwork> {
  const resolved: ResolvedNetwork = { allowedSshCidrs: [], allowedGatewayCidrs: [] }

  for (const [flag, raw, key] of [
    ['--ssh-cidr', flags.sshCidr, 'allowedSshCidrs'],
    ['--gateway-cidr', flags.gatewayCidr, 'allowedGatewayCidrs'],
  ] as const) {
    if (raw === undefined) continue
    resolved[key] =
      raw.trim() === 'auto' ? [await autoCidr(flag, deps.detectEgressIp)] : parseCidrList(flag, raw)
  }

  if (flags.publishGateway !== undefined) {
    resolved.publishGateway = parsePublishGateway(flags.publishGateway)
  }
  return resolved
}

async function autoCidr(
  flag: string,
  detect: () => Promise<{ ok: true; ip: string } | { ok: false; error: string }>,
): Promise<string> {
  const result = await detect()
  if (!result.ok || result.ip.trim() === '') {
    const why = result.ok ? 'the lookup returned an empty address' : result.error
    throw new UsageError(
      `${flag} auto: could not detect this machine's public IP — ${why}. ` +
        'Pass the CIDR explicitly, e.g. 203.0.113.4/32.',
    )
  }
  const ip = result.ip.trim()
  const cidr = ip.includes('/') ? ip : `${ip}/32`
  // Belt and braces: detection validates its own response, and this is the last point before
  // the value becomes a firewall rule in a file someone will approve.
  if (!isCidr(cidr)) {
    throw new UsageError(
      `${flag} auto: the detected address "${ip}" is not usable as a CIDR. ` +
        'Pass the CIDR explicitly, e.g. 203.0.113.4/32.',
    )
  }
  return cidr
}
