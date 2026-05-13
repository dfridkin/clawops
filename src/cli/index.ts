import { defineCommand, runMain } from 'citty'

import initCmd from './commands/init.js'
import upCmd from './commands/up.js'
import downCmd from './commands/down.js'
import statusCmd from './commands/status.js'
import planCmd from './commands/plan.js'
import applyCmd from './commands/apply.js'
import destroyCmd from './commands/destroy.js'
import sshCmd from './commands/ssh.js'
import tunnelCmd from './commands/tunnel.js'
import logsCmd from './commands/logs.js'
import configCmd from './commands/config.js'
import agentsCmd from './commands/agents.js'
import gatewayCmd from './commands/gateway.js'
import backupCmd from './commands/backup.js'
import stacksCmd from './commands/stacks.js'
import doctorCmd from './commands/doctor.js'
import mcpCmd from './commands/mcp.js'
import setupCmd from './commands/setup.js'
import secretCmd from './commands/secret.js'
import helpCmd from './commands/help.js'
import { handleError } from './error-handler.js'

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
    setup: setupCmd,
    secret: secretCmd,
    help: helpCmd,
  },
})

try {
  await runMain(main)
} catch (err) {
  handleError(err)
}
