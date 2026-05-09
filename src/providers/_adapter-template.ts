// _adapter-template.ts — copy this to src/providers/<name>/index.ts and fill in the blanks.
// Search for TODO_ to find every placeholder that must be replaced before committing.
//
// Checklist before opening a PR:
//   1. Rename all TODO_ identifiers and fill in real values
//   2. Run `pnpm gen:schemas` if you added the provider to spec/providers.schema.json
//   3. Run `pnpm test` — adapter + Pulumi component tests must pass
//   4. Add docs/providers/<name>.md (copy docs/providers/_template.md)
//   5. Update docs/providers/matrix.md with the new column
//   6. Add a changeset: pnpm changeset

import process from 'node:process'
import type {
  ProviderAdapter,
  ProviderName,
  InstanceAlias,
  ConnectionInfo,
  StackOutputs,
  ValidationResult,
  PulumiFn,
} from '../types.js'
// TODO_PROVIDER: import your Pulumi program from ./program.js
// import { TODO_NAMEProgram } from './program.js'

// Map clawops aliases → provider-native instance type strings.
// All five aliases must be present; they need not all be distinct.
const INSTANCE_TYPE_MAP: Record<InstanceAlias, string> = {
  micro:  'TODO_MICRO_TYPE',   // e.g. 't3.micro', 'e2-micro'
  small:  'TODO_SMALL_TYPE',   // e.g. 't3.small', 'e2-standard-2'
  medium: 'TODO_MEDIUM_TYPE',
  large:  'TODO_LARGE_TYPE',
  gpu:    'TODO_GPU_TYPE',
}

// State backend URL scheme — must be one of: 's3' | 'gs' | 'azblob' | 'file'
// Must match the value in spec/providers.schema.json → stateBackend.scheme.
const STATE_SCHEME = 'TODO_SCHEME' // e.g. 's3', 'gs', 'azblob'

// TODO_PROVIDER: rename this variable and the export at the bottom.
const TODO_NAMEAdapter: ProviderAdapter = {
  // TODO_PROVIDER: set name to the lowercase provider id matching the schema enum.
  name: 'TODO_NAME' as ProviderName,

  get program(): PulumiFn {
    // TODO_PROVIDER: return your program import, e.g. return TODO_NAMEProgram
    return async () => ({})
  },

  // Extract connection details from Pulumi stack outputs.
  // Keys must match what your program.ts returns from the inline closure.
  getConnectionInfo(outputs: StackOutputs): ConnectionInfo {
    return {
      host:           String(outputs['sshHost']),
      port:           Number(outputs['sshPort']),
      user:           String(outputs['sshUser']),
      privateKeyPath: String(outputs['privateKeyPath'] ?? ''),
      knownHostsPath: String(outputs['knownHostsPath'] ?? ''),
    }
  },

  normalizeInstanceType(alias: InstanceAlias): string {
    const mapped = INSTANCE_TYPE_MAP[alias]
    if (!mapped) throw new Error(`Unknown instance alias: ${alias}`)
    return mapped
  },

  defaultRegion(): string {
    return 'TODO_DEFAULT_REGION' // e.g. 'us-east-1', 'us-central1', 'eastus'
  },

  stateBackendUrl(bucket: string): string {
    return `${STATE_SCHEME}://${bucket}`
  },

  // validateConfig must RETURN { ok, errors } — never throw.
  // Check env vars that prove credentials are available at startup.
  // Called by `clawops doctor`; must be fast (no network calls unless necessary).
  async validateConfig(): Promise<ValidationResult> {
    const errors: string[] = []

    // TODO_PROVIDER: check the env vars that prove credentials are configured.
    // Example for a provider with two alternative env var sources:
    const hasPrimary   = Boolean(process.env['TODO_PRIMARY_ENV_VAR'])
    const hasSecondary = Boolean(process.env['TODO_SECONDARY_ENV_VAR'])

    if (!hasPrimary && !hasSecondary) {
      errors.push(
        'No TODO_NAME credentials found. ' +
        'Set TODO_PRIMARY_ENV_VAR or run `TODO_CLI_LOGIN_COMMAND`.',
      )
    }

    return { ok: errors.length === 0, errors }
  },
}

export default TODO_NAMEAdapter
