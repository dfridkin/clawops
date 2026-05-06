// Shared firewall/security-group CIDR resolution logic.
// Used by both the AWS and Azure Pulumi programs.

export type AccessMode = 'restricted' | 'auto' | 'open'

/**
 * Resolve the list of ingress CIDR blocks to allow for a given port.
 *
 * Resolution order:
 * 1. portOverride is set → use those CIDRs (highest priority)
 * 2. accessMode === 'restricted' → use allowedCidrs (empty string = deny all)
 * 3. accessMode === 'auto' → use detectedIp as /32
 * 4. accessMode === 'open' → 0.0.0.0/0
 */
export function resolveIngressCidrs(
  accessMode: string,
  allowedCidrs: string,
  portOverride: string,
  detectedIp: string,
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
      if (!detectedIp.trim()) return []
      const ip = detectedIp.trim()
      return [ip.includes('/') ? ip : `${ip}/32`]
    }
    case 'open':
      return ['0.0.0.0/0']
    default:
      return []
  }
}

/**
 * Fetch the caller's public egress IP from a check service.
 * Used in 'auto' accessMode. Returns empty string on failure.
 */
export async function detectEgressIp(checkUrl: string): Promise<string> {
  try {
    const res = await fetch(checkUrl, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return ''
    return (await res.text()).trim()
  } catch {
    return ''
  }
}
