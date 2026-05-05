import { defineCommand, runMain } from 'citty'

import initCmd from './commands/init'
import upCmd from './commands/up'
import downCmd from './commands/down'
import statusCmd from './commands/status'
import planCmd from './commands/plan'
import applyCmd from './commands/apply'
import destroyCmd from './commands/destroy'
import sshCmd from './commands/ssh'
import tunnelCmd from './commands/tunnel'
import logsCmd from './commands/logs'
import configCmd from './commands/config'
import agentsCmd from './commands/agents'
import gatewayCmd from './commands/gateway'
import backupCmd from './commands/backup'
import stacksCmd from './commands/stacks'
import doctorCmd from './commands/doctor'
import mcpCmd from './commands/mcp'

const main = defineCommand({
  meta: {
    name: 'clawops',
    description: 'Deploy and manage self-hosted OpenClaw instances across clouds',
    version: '0.2.0',
  },
  args: {
    stack: { type: 'string', description: 'Target named stack (default from config)' },
    provider: { type: 'string', description: 'Override provider (aws|gcp|azure|local)' },
    json: { type: 'boolean', description: 'Emit JSON to stdout' },
    quiet: { type: 'boolean', description: 'Suppress non-error output' },
    profile: { type: 'string', description: 'Auth profile from ~/.clawops/config.json' },
    'dry-run': { type: 'boolean', description: 'Preview without applying (mutating commands)' },
    yes: { type: 'boolean', description: 'Skip interactive confirmations (CI mode)' },
  },
  subCommands: {
    init: initCmd,
    up: upCmd,
    down: downCmd,
    status: statusCmd,
    plan: planCmd,
    apply: applyCmd,
    destroy: destroyCmd,
    ssh: sshCmd,
    tunnel: tunnelCmd,
    logs: logsCmd,
    config: configCmd,
    agents: agentsCmd,
    gateway: gatewayCmd,
    backup: backupCmd,
    stacks: stacksCmd,
    doctor: doctorCmd,
    mcp: mcpCmd,
  },
})

await runMain(main)
