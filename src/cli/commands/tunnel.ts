import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'tunnel',
    description: 'Forward the OpenClaw gateway port to localhost',
  },
  args: {
    port: { type: 'string', description: 'Local port to forward to (default: 18789)' },
    'no-open': { type: 'boolean', description: 'Do not open browser after tunnel is ready' },
  },
  async run() {
    throw new Error('clawops tunnel: not yet implemented (M2)')
  },
})
