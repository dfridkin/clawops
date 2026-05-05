import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'agents',
    description: 'Manage OpenClaw agents (list | restart | logs)',
  },
  args: {
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run() {
    throw new Error('clawops agents: not yet implemented (M2)')
  },
})
