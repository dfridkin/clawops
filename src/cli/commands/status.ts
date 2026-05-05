import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show current stack status: gateway health, uptime, agent count',
  },
  args: {
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run() {
    throw new Error('clawops status: not yet implemented (M1)')
  },
})
