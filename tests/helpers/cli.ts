// CLI test helpers — pattern for testing process.exit() calls.
// Per Issue 12: spy on process.exit so tests can assert without actually exiting.

import process from 'node:process'
import { vi } from 'vitest'

/** Sentinel error thrown by the mocked process.exit. */
export class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

/**
 * Mock process.exit for the duration of a test function.
 * The mock throws ExitError instead of exiting, so the test can assert:
 *
 *   await expect(() => runCommand()).rejects.toThrow(ExitError)
 *   await expect(() => runCommand()).rejects.toMatchObject({ code: 2 })
 */
export function withMockedExit<T>(fn: () => T | Promise<T>): Promise<T> {
  const mock = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitError(typeof code === 'number' ? code : 0)
  })
  return Promise.resolve(fn()).finally(() => mock.mockRestore())
}
