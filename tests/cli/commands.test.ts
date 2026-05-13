// Command registry smoke test (Issue 13).
// Verifies every command module can be imported and exports a valid citty command.
// Uses explicit static imports (Vitest/Vite cannot statically analyse template-literal dynamic imports).

import { describe, it, expect } from 'vitest'
import initCmd from '../../src/cli/commands/init.js'
import upCmd from '../../src/cli/commands/up.js'
import downCmd from '../../src/cli/commands/down.js'
import statusCmd from '../../src/cli/commands/status.js'
import planCmd from '../../src/cli/commands/plan.js'
import applyCmd from '../../src/cli/commands/apply.js'
import destroyCmd from '../../src/cli/commands/destroy.js'
import sshCmd from '../../src/cli/commands/ssh.js'
import tunnelCmd from '../../src/cli/commands/tunnel.js'
import logsCmd from '../../src/cli/commands/logs.js'
import configCmd from '../../src/cli/commands/config.js'
import agentsCmd from '../../src/cli/commands/agents.js'
import gatewayCmd from '../../src/cli/commands/gateway.js'
import backupCmd from '../../src/cli/commands/backup.js'
import stacksCmd from '../../src/cli/commands/stacks.js'
import doctorCmd from '../../src/cli/commands/doctor.js'
import mcpCmd from '../../src/cli/commands/mcp.js'

const commands = [
  { name: 'init', cmd: initCmd },
  { name: 'up', cmd: upCmd },
  { name: 'down', cmd: downCmd },
  { name: 'status', cmd: statusCmd },
  { name: 'plan', cmd: planCmd },
  { name: 'apply', cmd: applyCmd },
  { name: 'destroy', cmd: destroyCmd },
  { name: 'ssh', cmd: sshCmd },
  { name: 'tunnel', cmd: tunnelCmd },
  { name: 'logs', cmd: logsCmd },
  { name: 'config', cmd: configCmd },
  { name: 'agents', cmd: agentsCmd },
  { name: 'gateway', cmd: gatewayCmd },
  { name: 'backup', cmd: backupCmd },
  { name: 'stacks', cmd: stacksCmd },
  { name: 'doctor', cmd: doctorCmd },
  { name: 'mcp', cmd: mcpCmd },
] as const

describe('command registry', () => {
  for (const { name, cmd } of commands) {
    it(`${name} exports a valid command object`, () => {
      expect(cmd).toBeDefined()
      expect(cmd.meta).toBeDefined()
      // meta is Resolvable<CommandMeta>; our commands always use plain objects
      const meta = cmd.meta as { name: string }
      expect(meta.name).toBe(name)
      // Commands with subCommands may omit run(); citty handles the no-subcommand case
      expect(typeof cmd.run === 'function' || cmd.subCommands != null).toBe(true)
    })
  }
})
