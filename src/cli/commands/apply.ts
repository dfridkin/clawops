import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'apply',
    description: 'Apply a Maker plan JSON produced by `clawops plan`',
  },
  args: {
    yes: { type: 'boolean', description: 'Skip confirmation prompt' },
  },
  async run() {
    throw new Error('clawops apply: not yet implemented (M6)')
  },
})
