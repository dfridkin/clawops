// Persists the config overlay and secrets ref list for a stack so that
// `clawops secret rotate` can re-apply them without re-running the wizard.
//
// Stored at ~/.clawops/overlays/<stackName>.json — not a secret (contains
// $secret:<name> refs, not resolved values).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface SecretEntry {
  name: string
  source: 'env' | 'file' | 'aws-sm' | 'aws-ssm' | 'gcp-sm' | 'azure-kv'
  ref?: string
}

export interface StackOverlay {
  stackName: string
  savedAt: string
  overlay: Record<string, unknown>
  secrets: SecretEntry[]
}

function overlayPath(stackName: string): string {
  return path.join(os.homedir(), '.clawops', 'overlays', `${stackName}.json`)
}

export function saveOverlay(stackName: string, overlay: Record<string, unknown>, secrets: SecretEntry[]): void {
  const dir = path.join(os.homedir(), '.clawops', 'overlays')
  mkdirSync(dir, { recursive: true })
  const data: StackOverlay = { stackName, savedAt: new Date().toISOString(), overlay, secrets }
  writeFileSync(overlayPath(stackName), JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export function loadOverlay(stackName: string): StackOverlay | null {
  const p = overlayPath(stackName)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as StackOverlay
  } catch {
    return null
  }
}

export function listOverlays(): StackOverlay[] {
  const dir = path.join(os.homedir(), '.clawops', 'overlays')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))
    .flatMap((f: string) => {
      try {
        return [JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as StackOverlay]
      } catch {
        return []
      }
    })
}
