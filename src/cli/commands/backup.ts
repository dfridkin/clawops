import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'backup',
    description: 'Create or restore an OpenClaw backup (create | restore)',
  },
  args: {
    out: { type: 'string', description: 'Output path for backup archive' },
  },
  async run() {
    throw new Error('clawops backup: not yet implemented (M4)')
  },
})
