import { defineCommand } from 'citty'
import process from 'node:process'
import { accessSync, constants } from 'node:fs'
import { execSync } from 'node:child_process'
import { info, REPO_URL } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'

const ISSUES_URL = `${REPO_URL}/issues/new`
const BODY_CAP = 2000

// __CLI_VERSION__ is replaced at build time by tsup define; fallback for
// ts-node / pnpm dev paths where the define isn't applied.
declare const __CLI_VERSION__: string
const VERSION: string = typeof __CLI_VERSION__ !== 'undefined'
  ? __CLI_VERSION__
  : 'dev'

async function collectContext(): Promise<string> {
  const nodeVersion = process.version
  const os = `${process.platform} ${process.arch}`

  let provider = 'unknown'
  let stackCount = 0
  let sshKey = 'unknown'

  try {
    const { getConfig } = await import('../../config/store.js')
    const config = getConfig()
    if (config) {
      const stacks = Object.values(config.stacks)
      stackCount = stacks.length
      provider = stacks[0]?.provider ?? 'none'
      const keyPath = config.ssh.keyPath.replace(/^~/, process.env['HOME'] ?? '~')
      try {
        accessSync(keyPath, constants.R_OK)
        sshKey = 'present'
      } catch {
        sshKey = 'missing'
      }
    } else {
      provider = 'not configured'
      sshKey = 'not configured'
    }
  } catch {
    // config unavailable — best effort
  }

  return [
    `**clawops version:** ${VERSION}`,
    `**Node:** ${nodeVersion}`,
    `**OS:** ${os}`,
    `**Provider:** ${provider}`,
    `**Stacks:** ${stackCount}`,
    `**SSH key:** ${sshKey}`,
  ].join('\n')
}

function buildIssueUrl(title: string, command: string, context: string): string {
  const body = [
    context,
    '',
    '**Description:**',
    title,
    '',
    command ? `**Command:**\n\`${command}\`` : '',
    '',
    '**Steps to reproduce:**',
    '<!-- Please describe what you did -->\n',
  ]
    .filter((l) => l !== undefined)
    .join('\n')
    .slice(0, BODY_CAP)

  const params = new URLSearchParams({ title, body })
  return `${ISSUES_URL}?${params.toString()}`
}

function openBrowser(url: string): boolean {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execSync(`${cmd} "${url}"`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export default defineCommand({
  meta: {
    name: 'bug',
    description: 'Open a pre-filled GitHub issue with system context from clawops doctor',
  },
  args: {
    json: { type: 'boolean', description: 'Emit issue URL as JSON without opening a browser' },
  },
  async run({ args }) {
    const context = await collectContext()

    let title = ''
    let command = ''

    if (!args.json) {
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        title = (await rl.question('Describe the issue in one line: ')).trim()
        command = (await rl.question('Which command triggered it? (optional): ')).trim()
      } finally {
        rl.close()
      }
    }

    const url = buildIssueUrl(title, command, context)

    if (args.json) {
      printJson(jsonOk({ url }))
      return
    }

    process.stdout.write('\n')
    info(`Opening: ${url}`)
    process.stdout.write('\n')

    const opened = openBrowser(url)
    if (!opened) {
      process.stdout.write(`Open this URL to file the issue:\n${url}\n`)
    }
  },
})
