// resolveConn: where every tool and command finds the host for a stack.

import { describe, it, expect, vi } from 'vitest'
import { resolveConn } from '../../src/transport/conn.js'
import { makeFakeContext } from '../helpers/context.js'

describe('resolveConn', () => {
  it('says why a stack\'s state could not be read, not Pulumi\'s exit code', async () => {
    // What an MCP server started without AWS_PROFILE got back from every tool on a real AWS
    // stack: the first line of a subprocess dump.
    const ctx = makeFakeContext()
    Object.assign(ctx, {
      stackName: 'prod',
      getStack: vi.fn().mockRejectedValue(new Error(
        'code: -2\n stdout: \n stderr: error: could not list bucket: AccessDenied: Access Denied\n',
      )),
    })

    const err = await resolveConn(ctx).then(() => undefined, (e: unknown) => e as Error)
    expect(err?.message).toContain('Could not read the state of stack "prod"')
    expect(err?.message).toContain('could not list bucket: AccessDenied')
    expect(err?.message).toContain('env block of its client config')
    expect(err?.message).not.toMatch(/^code: -2/)
  })
})
