import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'config',
    description: 'Manage OpenClaw gateway configuration (get | set | unset)',
  },
  args: {
    restart: { type: 'boolean', description: 'Restart gateway after set/unset' },
  },
  async run() {
    throw new Error('clawops config: not yet implemented (M2)')
  },
})
