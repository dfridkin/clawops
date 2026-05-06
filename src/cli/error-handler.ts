// Top-level error handler — maps ClawopsError subclasses to exit codes.
// Called from the main catch block in src/cli/index.ts.

import process from 'node:process'
import { ClawopsError } from '../errors/index.js'
import { failure } from '../output/human.js'

export function handleError(err: unknown): never {
  if (err instanceof ClawopsError) {
    failure(err.message)
    process.exit(err.exitCode)
  }

  if (err instanceof Error) {
    failure(`Unexpected error: ${err.message}`)
    if (process.env['DEBUG']) {
      process.stderr.write(err.stack ?? '' + '\n')
    }
    process.exit(1)
  }

  failure(`Unknown error: ${String(err)}`)
  process.exit(1)
}
