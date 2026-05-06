// Local provider state store — persists connection info for non-Pulumi stacks.
// Lives at ~/.clawops/state/<stackName>.json (atomic write, same pattern as config/store.ts).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getConfigDir } from '../../config/store.js'
import type { BaseStackOutputs, ConnectionInfo } from '../types.js'

export interface LocalState extends BaseStackOutputs {
  sshPort: number
  sshUser: string
  privateKeyPath: string
  knownHostsPath: string
}

export function stateDir(): string {
  return path.join(getConfigDir(), 'state')
}

export function statePath(stackName: string): string {
  return path.join(stateDir(), `${stackName}.json`)
}

export function readLocalState(stackName: string): LocalState | null {
  try {
    const raw = readFileSync(statePath(stackName), 'utf-8')
    return JSON.parse(raw) as LocalState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function writeLocalState(stackName: string, state: LocalState): void {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const dest = statePath(stackName)
  const tmp = path.join(dir, `.state-${randomUUID()}.tmp`)
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  renameSync(tmp, dest)
}

export function localStateToConnectionInfo(
  state: LocalState,
): ConnectionInfo {
  return {
    host: state.sshHost,
    port: state.sshPort,
    user: state.sshUser,
    privateKeyPath: state.privateKeyPath,
    knownHostsPath: state.knownHostsPath,
  }
}
