// CLI boundary for OpenClaw version enforcement.
// Adapters return Result; this is where an unsupported version becomes a thrown error.

import { UsageError } from '../errors/index.js'
import { assertSupportedVersion, loadVersionSpec } from '../openclaw/versions.js'

/**
 * The version used when the caller does not specify one.
 *
 * Deliberately a concrete pin from the support matrix rather than a moving tag.
 * Before v1.7.2 the default was `stable` in the CLI and `latest` in the Pulumi
 * programs — two different moving tags, both of which now resolve to OpenClaw 2.0,
 * which this clawops line cannot deploy.
 */
export async function defaultOpenclawVersion(): Promise<string> {
  const yaml = await import('js-yaml')
  return loadVersionSpec(yaml).support.recommended
}

/**
 * Refuse to proceed with an OpenClaw version outside the supported range.
 *
 * `resolver` turns a moving tag into a concrete release. Without it an unresolved
 * tag is refused rather than assumed compatible — failing closed, because a moving
 * tag is how an unsupported release reaches a deployment in the first place.
 */
export async function guardOpenclawVersion(
  version: string,
  resolver?: (tag: string) => Promise<string | undefined>,
): Promise<string> {
  const yaml = await import('js-yaml')
  const result = await assertSupportedVersion(version, yaml, resolver)
  if (result.ok) return result.value
  throw new UsageError(result.error.message)
}
