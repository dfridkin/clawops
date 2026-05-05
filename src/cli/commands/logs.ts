import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'logs',
    description: 'Stream gateway logs from the remote instance',
  },
  args: {
    follow: { type: 'boolean', alias: 'f', description: 'Follow log output' },
    tail: { type: 'string', description: 'Number of lines to show from end' },
    since: { type: 'string', description: 'Show logs since duration (e.g. 5m, 1h)' },
  },
  async run() {
    throw new Error('clawops logs: not yet implemented (M1)')
  },
})
