import { defineCommand } from 'citty'
import process from 'node:process'

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check system prerequisites and configuration',
  },
  async run() {
    const results: Array<{ label: string; ok: boolean; note?: string }> = []

    // Node.js version check
    const nodeVersion = process.version
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10)
    results.push({
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
      results.push({ label, ok: present })
    }

    // Print results
    console.log('\nclawops doctor\n')
    for (const r of results) {
      const icon = r.ok ? '✓' : '✗'
      const note = r.note ? `  (${r.note})` : ''
      console.log(`  ${icon}  ${r.label}${note}`)
    }

    if (!anyCredential) {
      console.log(
        '\n  ⚠  No cloud credentials detected.\n' +
          '     Set AWS_PROFILE, GOOGLE_APPLICATION_CREDENTIALS, or AZURE_CLIENT_ID.\n',
      )
    } else {
      console.log()
    }

    const nodeOk = results.find(r => r.label.startsWith('Node'))?.ok ?? false
    if (!nodeOk) process.exit(1)
  },
})
