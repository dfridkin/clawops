import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'stacks',
    description: 'Manage clawops stacks (list | delete)',
  },
  args: {
    json: { type: 'boolean', description: 'Emit JSON' },
    yes: { type: 'boolean', description: 'Skip confirmation on delete' },
  },
  async run() {
    throw new Error('clawops stacks: not yet implemented (M3)')
  },
})
