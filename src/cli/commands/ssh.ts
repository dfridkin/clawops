import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'ssh',
    description: 'Open an SSH session to the stack instance',
  },
  async run() {
    throw new Error('clawops ssh: not yet implemented (M1)')
  },
})
