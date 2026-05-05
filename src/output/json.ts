// JSON output helpers — emits { ok, data, error } to stdout.
// Used when --json flag is set.

import process from 'node:process'

export interface JsonOutput<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export function printJson<T>(output: JsonOutput<T>): void {
  process.stdout.write(JSON.stringify(output, null, 2) + '\n')
}

export function jsonOk<T>(data: T): JsonOutput<T> {
  return { ok: true, data }
}

export function jsonError(error: string): JsonOutput<never> {
  return { ok: false, error }
}
