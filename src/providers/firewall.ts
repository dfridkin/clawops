// Shared firewall/security-group CIDR resolution logic.
// Used by the AWS, GCP, and Azure Pulumi programs.

export type AccessMode = 'restricted' | 'auto' | 'open'

export type EgressIpResult =
  | { ok: true; ip: string }
  | { ok: false; error: string }

/**
 * Resolve the list of ingress CIDR blocks to allow for a given port.
 *
 * Resolution order:
 * 1. portOverride is set → use those CIDRs (highest priority)
 * 2. accessMode === 'restricted' → use allowedCidrs (empty string = deny all)
 * 3. accessMode === 'auto' → use detectedIp as /32; throws if detection failed
 * 4. accessMode === 'open' → 0.0.0.0/0
 *
 * Throws a descriptive error when 'auto' mode was requested but IP detection
 * failed — a silent empty return would produce a VM with no ingress rules.
 */
export function resolveIngressCidrs(
  accessMode: string,
  allowedCidrs: string,
  portOverride: string,
  egressResult: EgressIpResult,
): string[] {
  if (portOverride.trim()) {
    return portOverride.split(',').map(s => s.trim()).filter(Boolean)
  }

  switch (accessMode) {
    case 'restricted': {
      if (!allowedCidrs.trim()) return []
      return allowedCidrs.split(',').map(s => s.trim()).filter(Boolean)
    }
    case 'auto': {
      if (!egressResult.ok) {
        throw new Error(
          `accessMode=auto: egress IP detection failed — ${egressResult.error}. ` +
          `Set allowedCidrs explicitly or use accessMode=restricted.`,
        )
      }
      const ip = egressResult.ip.trim()
      if (!ip) {
        throw new Error(
          `accessMode=auto: egress IP detection returned an empty address. ` +
          `Set allowedCidrs explicitly or use accessMode=restricted.`,
        )
      }
      return [ip.includes('/') ? ip : `${ip}/32`]
    }
    case 'open':
      return ['0.0.0.0/0']
    default:
      return []
  }
}

/**
 * Fetch the caller's public egress IP from a provider-neutral check service.
 * Used in 'auto' accessMode. Returns a Result so callers can handle failure
 * explicitly rather than silently receiving an empty CIDR list.
 */
export async function detectEgressIp(checkUrl: string): Promise<EgressIpResult> {
  try {
    const res = await fetch(checkUrl, { signal: AbortSignal.timeout(3_000) })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} from ${checkUrl}` }
    }
    const ip = (await res.text()).trim()
    if (!ip) {
      return { ok: false, error: `empty response from ${checkUrl}` }
    }
    return { ok: true, ip }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Ingress CIDRs for the gateway port, given how the gateway is published.
 *
 * Under `publishGateway: "loopback"` — the default since 2.0 — the container binds
 * 127.0.0.1 on the host, so nothing is listening on a routable interface. A security-group
 * rule for the gateway port then admits traffic to a closed port: it grants no access, and
 * it reads to an auditor as though the gateway were exposed. Both readings are wrong, so no
 * rule is created.
 *
 * `clawops plan` refuses the combination outright, so reaching here with CIDRs and loopback
 * means a stack configured outside the plan flow. Dropping them is still the right answer;
 * the caller reports it.
 */
export function resolveGatewayIngressCidrs(
  publishGateway: string,
  accessMode: string,
  allowedCidrs: string,
  portOverride: string,
  egressResult: EgressIpResult,
): string[] {
  if (publishGateway !== 'all') return []
  return resolveIngressCidrs(accessMode, allowedCidrs, portOverride, egressResult)
}

/**
 * The gateway port for a stack, from Pulumi config.
 *
 * Falls back to the default rather than throwing: a stack created before the port was
 * plan-driven has no such config value, and it is on the default.
 */
export function resolveGatewayPort(raw: string | undefined, fallback: number): number {
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}
