import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Initialise clawops: choose provider, configure state backend, generate SSH key',
  },
  args: {
    provider: { type: 'string', description: 'Cloud provider (aws|gcp|azure|local)' },
    state: { type: 'string', description: 'State backend URL (e.g. s3://my-bucket/clawops)' },
    'non-interactive': { type: 'boolean', description: 'Suppress all prompts (requires flags)' },
  },
  async run() {
    throw new Error('clawops init: not yet implemented (M1)')
  },
})
