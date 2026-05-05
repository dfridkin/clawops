import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'down',
    description: 'Stop the stack (does not destroy resources)',
  },
  args: {
    destroy: { type: 'boolean', description: 'Also destroy all provisioned resources' },
  },
  async run() {
    throw new Error('clawops down: not yet implemented (M1)')
  },
})
