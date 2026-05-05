import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'plan',
    description: 'Generate a Maker deploy plan without applying it',
  },
  args: {
    provider: { type: 'string', description: 'Cloud provider' },
    out: { type: 'string', description: 'Write plan to this path (default: stdout)' },
  },
  async run() {
    throw new Error('clawops plan: not yet implemented (M6)')
  },
})
