import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'destroy',
    description: 'Destroy all resources in a stack (irreversible)',
  },
  args: {
    yes: { type: 'boolean', description: 'Skip confirmation prompt' },
  },
  async run() {
    throw new Error('clawops destroy: not yet implemented (M1)')
  },
})
