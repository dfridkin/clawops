import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Provision and deploy an OpenClaw stack',
  },
  args: {
    provider: { type: 'string', description: 'Cloud provider (aws|gcp|azure|local)' },
    region: { type: 'string', description: 'Cloud region' },
    'instance-type': { type: 'string', description: 'Instance size alias (micro|small|medium|large|gpu)' },
    'dry-run': { type: 'boolean', description: 'Preview without applying' },
    'no-wait': { type: 'boolean', description: 'Return immediately without waiting for healthy state' },
    'openclaw-version': { type: 'string', description: "semver or 'stable'/'dev'" },
  },
  async run() {
    throw new Error('clawops up: not yet implemented (M1)')
  },
})
