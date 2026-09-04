// OpenClaw version compatibility — loads spec/openclaw-versions.yaml and enforces
// the supported range for this clawops release line.
//
// Until v1.7.2 this spec file was documentation only: nothing read it, so
// `support.max: ""` silently accepted every OpenClaw release, including 2.0.
// See docs/spikes/SP-01-container-profile.md for what that produces.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import type { Result } from '../types/result.js'
import { ok, err } from '../types/result.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Moving tags clawops accepts as an OpenClaw version. These cannot be range-checked
 * directly — they must be resolved to a concrete release first (see `resolveVersion`).
 */
export const MOVING_TAGS = ['latest', 'stable', 'dev', 'main'] as const
export type MovingTag = (typeof MOVING_TAGS)[number]

export function isMovingTag(v: string): v is MovingTag {
  return (MOVING_TAGS as readonly string[]).includes(v)
}

export interface VersionSupport {
  min: string
  max: string
  recommended: string
}

export interface VersionSpec {
  support: VersionSupport
}

let _spec: VersionSpec | undefined

/** Load and cache spec/openclaw-versions.yaml. */
export function loadVersionSpec(yaml: typeof import('js-yaml')): VersionSpec {
  if (_spec) return _spec
  const specPath = join(__dirname, '../../spec/openclaw-versions.yaml')
  try {
    const raw = yaml.load(readFileSync(specPath, 'utf-8')) as Partial<VersionSpec>
    if (!raw?.support?.min) {
      throw new Error('missing support.min')
    }
    _spec = {
      support: {
        min: raw.support.min,
        max: raw.support.max ?? '',
        recommended: raw.support.recommended ?? raw.support.min,
      },
    }
    return _spec
  } catch (e) {
    throw new Error(
      `Cannot load OpenClaw version support matrix from ${specPath}: ${(e as Error).message}`,
    )
  }
}

/** Reset the module cache. Tests only. */
export function _resetVersionSpecCache(): void {
  _spec = undefined
}

/**
 * Compare two OpenClaw date-style versions (`2026.8.1`, `2026.7.1-2`).
 *
 * OpenClaw does not use semver: releases are `YYYY.M.N` with an optional `-N` patch
 * suffix. Segments are compared numerically, so `2026.10.1 > 2026.9.1` — which a
 * lexicographic compare would get wrong.
 *
 * Returns <0 if a precedes b, 0 if equal, >0 if a follows b.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split(/[.-]/)
      .map((seg) => Number.parseInt(seg, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n))
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export interface UnsupportedVersion {
  requested: string
  resolved: string
  reason: 'too-new' | 'too-old'
  supportedRange: string
  message: string
}

/**
 * Check a concrete OpenClaw version against the supported range.
 *
 * The caller MUST resolve moving tags before calling this — passing `latest` through
 * is refused rather than assumed safe, because a moving tag is exactly how an
 * unsupported release reaches a deployment.
 */
export function checkVersion(
  version: string,
  support: VersionSupport,
): Result<string, UnsupportedVersion> {
  if (isMovingTag(version)) {
    return err({
      requested: version,
      resolved: version,
      reason: 'too-new',
      supportedRange: describeRange(support),
      message:
        `Cannot verify OpenClaw compatibility: "${version}" is a moving tag that was not ` +
        `resolved to a concrete release. Pin an explicit version (${support.recommended}) ` +
        `or re-run once tag resolution is available.`,
    })
  }

  if (compareVersions(version, support.min) < 0) {
    return err({
      requested: version,
      resolved: version,
      reason: 'too-old',
      supportedRange: describeRange(support),
      message:
        `OpenClaw ${version} is older than this clawops release supports ` +
        `(${describeRange(support)}). Upgrade OpenClaw, or pin ${support.recommended}.`,
    })
  }

  if (support.max && compareVersions(version, support.max) > 0) {
    return err({
      requested: version,
      resolved: version,
      reason: 'too-new',
      supportedRange: describeRange(support),
      message:
        `OpenClaw ${version} is newer than this clawops release supports ` +
        `(${describeRange(support)}).\n` +
        `OpenClaw 2026.8.1+ changed the container runtime contract: state moved to SQLite, ` +
        `config moved to a writable path, and provider plugins became install-gated.\n` +
        `Use clawops 2.x for OpenClaw 2026.9.1 and later:  npm install -g @clawops/cli@latest\n` +
        `To stay on this line, pin an OpenClaw version at or below ${support.max}.`,
    })
  }

  return ok(version)
}

export function describeRange(support: VersionSupport): string {
  if (!support.max) return `>= ${support.min}`
  return `${support.min} – ${support.max}`
}

/**
 * Resolve a possibly-moving tag to the concrete version it currently points at.
 *
 * `resolver` performs the lookup (registry query, or `docker image inspect` on a host).
 * When resolution is unavailable the moving tag is returned unchanged, and
 * `checkVersion` will refuse it — failing closed rather than assuming compatibility.
 */
export async function resolveVersion(
  version: string,
  resolver?: (tag: string) => Promise<string | undefined>,
): Promise<string> {
  if (!isMovingTag(version)) return version
  if (!resolver) return version
  try {
    return (await resolver(version)) ?? version
  } catch {
    return version
  }
}

/**
 * One-call guard for command handlers: resolve, then check.
 * Returns the concrete version on success.
 */
export async function assertSupportedVersion(
  version: string,
  yaml: typeof import('js-yaml'),
  resolver?: (tag: string) => Promise<string | undefined>,
): Promise<Result<string, UnsupportedVersion>> {
  const spec = loadVersionSpec(yaml)
  const resolved = await resolveVersion(version, resolver)
  const result = checkVersion(resolved, spec.support)
  if (!result.ok && resolved !== version) {
    return err({ ...result.error, requested: version })
  }
  return result
}
