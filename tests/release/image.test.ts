// What the published image must contain for clawops to work inside it.
//
// node:*-slim ships neither, and both failures are silent until something real is attempted:
// `clawops init` dies on a missing ssh-keygen, and every HTTPS call — the Pulumi CLI download,
// every cloud API — fails to verify with no CA bundle. Both were found by running the image
// rather than reading it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf-8')

describe('the image clawops publishes', () => {
  it('installs ssh-keygen, which clawops init needs to make a usable key', () => {
    expect(dockerfile).toMatch(/openssh-client/)
  })

  it('installs a CA bundle, without which the container can reach no HTTPS endpoint', () => {
    expect(dockerfile).toMatch(/ca-certificates/)
  })

  it('starts the MCP server rather than the CLI', () => {
    expect(dockerfile).toMatch(/ENTRYPOINT \["clawops", "mcp", "serve"\]/)
  })
})
