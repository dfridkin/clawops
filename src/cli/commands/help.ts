import { defineCommand } from 'citty'
import { chalk } from '../../output/human.js'

const COMMANDS = [
  ['setup',   'Interactive first-run wizard — configure, deploy, and wire AI apps'],
  ['init',    'Write config and generate SSH key pair (non-interactive)'],
  ['up',      'Provision or update a stack'],
  ['down',    'Destroy a local-provider stack (requires --yes)'],
  ['destroy', 'Destroy a cloud-provider stack with confirmation prompt (requires --yes)'],
  ['status',  'Show stack outputs: IP, gateway URL, region, provisioned time'],
  ['plan',    'Generate a deploy-plan JSON artifact (dry-run safe)'],
  ['apply',   'Apply a previously reviewed plan file'],
  ['ssh',     'Interactive SSH session or run a remote command (--command)'],
  ['logs',    'Stream OpenClaw logs (-f, --tail N, --since 5m)'],
  ['tunnel',  'Port-forward gateway UI to localhost over SSH'],
  ['config',  'Get / set / validate remote OpenClaw config values'],
  ['agents',  'List or restart OpenClaw agents'],
  ['gateway', 'Restart the OpenClaw gateway service'],
  ['backup',  'Create or restore an OpenClaw state backup'],
  ['stacks',  'List named stacks and their state'],
  ['doctor',  'Check Node version, config, SSH key, provider credentials, and Pulumi home'],
  ['mcp',     'MCP server operations (mcp serve | mcp install)'],
  ['help',    'Show this help message'],
] as const

const GLOBAL_FLAGS = [
  ['--stack <name>',    'Target named stack (overrides config default)'],
  ['--provider <name>', 'Override provider  (aws | gcp | azure | local)'],
  ['--json',            'Emit JSON to stdout'],
  ['--quiet',           'Suppress non-error output'],
  ['--dry-run',         'Preview without applying (mutating commands)'],
  ['--yes',             'Skip interactive confirmations (CI mode)'],
] as const

export default defineCommand({
  meta: {
    name: 'help',
    description: 'Show available commands and global flags',
  },
  args: {},
  run() {
    const bold = chalk.bold
    const dim = chalk.dim
    const cyan = chalk.cyan

    const cmdWidth = Math.max(...COMMANDS.map(([c]) => c.length))
    const flagWidth = Math.max(...GLOBAL_FLAGS.map(([f]) => f.length))

    process.stdout.write(`\n${bold('clawops')} — Deploy and manage self-hosted OpenClaw instances\n\n`)
    process.stdout.write(`${bold('Usage:')}  clawops <command> [flags]\n\n`)

    process.stdout.write(`${bold('Commands:')}\n`)
    for (const [cmd, desc] of COMMANDS) {
      process.stdout.write(`  ${cyan(cmd.padEnd(cmdWidth))}  ${desc}\n`)
    }

    process.stdout.write(`\n${bold('Global flags:')}\n`)
    for (const [flag, desc] of GLOBAL_FLAGS) {
      process.stdout.write(`  ${flag.padEnd(flagWidth)}  ${dim(desc)}\n`)
    }

    process.stdout.write(`\n${dim('Run `clawops <command> --help` for command-specific flags.')}\n\n`)
  },
})
