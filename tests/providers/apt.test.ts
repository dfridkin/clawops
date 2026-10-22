// apt_update, run in bash with apt-get, sleep and rm stubbed as functions — a shell function
// shadows the command of the same name, so nothing touches the machine running the test.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { APT_UPDATE_FN } from '../../src/providers/apt.js'
import { makeStartupScript } from '../../src/providers/startup.js'
import { renderScript } from '../../src/providers/local/bootstrap.js'

/** Runs apt_update under `set -euo pipefail` with apt-get failing the first `fails` times. */
function run(fails: number): { code: number | null; calls: string[]; stderr: string } {
  const script = `set -euo pipefail
n=0
apt-get() { n=$((n + 1)); echo "apt-get $*" >> "$LOG"; [ "$n" -gt ${fails} ] || return 100; }
sleep() { echo "sleep $*" >> "$LOG"; }
rm() { echo "rm $*" >> "$LOG"; }
${APT_UPDATE_FN}
apt_update
echo "after" >> "$LOG"`
  const log = `/dev/fd/3`
  const r = spawnSync('bash', ['-c', `exec 3>&1 1>&2; ${script.replace(/"\$LOG"/g, log)}`], { encoding: 'utf-8' })
  return { code: r.status, calls: r.stdout.trim().split('\n').filter(Boolean), stderr: r.stderr }
}

describe('apt_update', () => {
  it('runs apt-get update once when it succeeds', () => {
    const r = run(0)
    expect(r.code).toBe(0)
    expect(r.calls).toEqual(['apt-get -o Acquire::Retries=3 update -q', 'after'])
  })

  it('retries past a mirror mid-sync, bypassing caches and discarding partial downloads', () => {
    const r = run(2)
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([
      'apt-get -o Acquire::Retries=3 update -q',
      'rm -rf /var/lib/apt/lists/partial/*',
      'sleep 30',
      'apt-get -o Acquire::Retries=3 -o Acquire::http::No-Cache=true update -q',
      'rm -rf /var/lib/apt/lists/partial/*',
      'sleep 60',
      'apt-get -o Acquire::Retries=3 -o Acquire::http::No-Cache=true update -q',
      'after',
    ])
    expect(r.stderr).toContain('apt-get update failed (attempt 1 of 3); retrying in 30s')
  })

  it('fails the script after the third failure, without a fourth try or a last sleep', () => {
    const r = run(3)
    expect(r.code).not.toBe(0)
    expect(r.calls.filter((c) => c.startsWith('apt-get'))).toHaveLength(3)
    expect(r.calls.filter((c) => c.startsWith('sleep'))).toEqual(['sleep 30', 'sleep 60'])
    expect(r.calls).not.toContain('after')
  })
})

describe('the bootstrap scripts', () => {
  const scripts = {
    'cloud startup': makeStartupScript({ openclawVersion: 'latest', os: 'ubuntu' }),
    'local bootstrap': renderScript('latest'),
  }
  for (const [name, script] of Object.entries(scripts)) {
    it(`${name}: defines apt_update, calls it before each install, and never a bare apt-get update`, () => {
      expect(script).toContain(APT_UPDATE_FN)
      expect(script.indexOf(APT_UPDATE_FN)).toBeLessThan(script.search(/^\s*apt_update$/m))
      expect(script.match(/^\s*apt_update$/gm)).toHaveLength(2)
      expect(script).not.toMatch(/^\s*apt-get update/m)
      expect(script).not.toMatch(/^\s*apt-get install/m)
    })
  }
})
