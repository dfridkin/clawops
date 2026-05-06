import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, warn } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check system prerequisites and configuration',
  },
  async run() {
    const checks: Array<{ label: string; ok: boolean; note?: string }> = []

    // Node.js version check
    const nodeVersion = process.version
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10)
    checks.push({
      label: `Node.js ${nodeVersion}`,
      ok: nodeMajor >= 20,
      note: nodeMajor < 20 ? 'requires >=20' : undefined,
    })

    // Cloud credentials presence
    const credChecks: Array<{ label: string; env: string }> = [
      { label: 'AWS_PROFILE', env: 'AWS_PROFILE' },
      { label: 'GOOGLE_APPLICATION_CREDENTIALS', env: 'GOOGLE_APPLICATION_CREDENTIALS' },
      { label: 'AZURE_CLIENT_ID', env: 'AZURE_CLIENT_ID' },
    ]

    let anyCredential = false
    for (const { label, env } of credChecks) {
      const present = Boolean(process.env[env])
      if (present) anyCredential = true
      checks.push({ label, ok: present })
    }

    process.stdout.write('\nclawops doctor\n\n')
    for (const c of checks) {
      const note = c.note ? `  (${c.note})` : ''
      if (c.ok) {
        success(`${c.label}${note}`)
      } else {
        failure(`${c.label}${note}`)
      }
    }

    if (!anyCredential) {
      process.stdout.write('\n')
      warn(
        'No cloud credentials detected.\n' +
          '     Set AWS_PROFILE, GOOGLE_APPLICATION_CREDENTIALS, or AZURE_CLIENT_ID.',
      )
    }
    process.stdout.write('\n')

    const nodeOk = checks.find((c) => c.label.startsWith('Node'))?.ok ?? false
    if (!nodeOk) process.exit(1)
  },
})
