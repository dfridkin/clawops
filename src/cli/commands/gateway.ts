import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'gateway',
    description: 'Manage the OpenClaw gateway daemon (status | restart | update)',
  },
  args: {
    channel: { type: 'string', description: 'Update channel: stable | dev | <version>' },
  },
  async run() {
    throw new Error('clawops gateway: not yet implemented (M2)')
  },
})
