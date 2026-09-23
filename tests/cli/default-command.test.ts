// What clawops does when it is given nothing.
//
// A CLI that is also an MCP server gets started both ways: a person types it, and a machine
// pipes protocol at it. Glama's directory build started it the second way three times, got the
// help text where it wanted a handshake, and withheld the listing each time.

import { describe, it, expect } from 'vitest'
import { resolveArgv } from '../../src/cli/default-command.js'

describe('resolveArgv', () => {
  it('serves MCP when given nothing and stdin is a pipe', () => {
    expect(resolveArgv([], false)).toEqual(['mcp', 'serve'])
  })

  it('prints help when given nothing at a terminal', () => {
    expect(resolveArgv([], true)).toEqual([])
  })

  /*
   * The stdin check, not an stdout check. `clawops | less` has a pipe on stdout and a terminal
   * on stdin: a person asking for help, and they still get it.
   */
  it('leaves a real command alone, terminal or not', () => {
    expect(resolveArgv(['status'], false)).toEqual(['status'])
    expect(resolveArgv(['status'], true)).toEqual(['status'])
    expect(resolveArgv(['mcp', 'serve', '--read-only'], false)).toEqual(['mcp', 'serve', '--read-only'])
  })

  // A flag with no command is a malformed invocation, and still reports as one.
  it('does not rescue a flag with no command', () => {
    expect(resolveArgv(['--json'], false)).toEqual(['--json'])
    expect(resolveArgv(['--stack', 'prod'], false)).toEqual(['--stack', 'prod'])
  })

  it('returns a copy rather than the caller\'s array', () => {
    const argv = ['status']
    expect(resolveArgv(argv, true)).not.toBe(argv)
  })
})
