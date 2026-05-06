// Local provider state store unit tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  readLocalState,
  writeLocalState,
  localStateToConnectionInfo,
  stateDir,
  statePath,
  type LocalState,
} from '../../../src/providers/local/state.js'

const SAMPLE_STATE: LocalState = {
  instanceId: 'local:192.168.1.10',
  publicIp: '192.168.1.10',
  gatewayUrl: 'http://192.168.1.10:18789',
  sshHost: '192.168.1.10',
  sshPort: 22,
  sshUser: 'root',
  region: 'local',
  provisionedAt: '2026-05-06T12:00:00.000Z',
  privateKeyPath: '/home/user/.clawops/id_ed25519',
  knownHostsPath: '/home/user/.clawops/known_hosts',
}

describe('stateDir() / statePath()', () => {
  let tmpDir: string
  let prevHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-state-test-'))
    prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
    else process.env['CLAWOPS_HOME'] = prevHome
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stateDir() is inside CLAWOPS_HOME', () => {
    expect(stateDir()).toBe(path.join(tmpDir, 'state'))
  })

  it('statePath() adds <stackName>.json', () => {
    expect(statePath('my-stack')).toBe(path.join(tmpDir, 'state', 'my-stack.json'))
  })
})

describe('readLocalState() / writeLocalState()', () => {
  let tmpDir: string
  let prevHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-state-test-'))
    prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
    else process.env['CLAWOPS_HOME'] = prevHome
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when state file does not exist', () => {
    expect(readLocalState('nonexistent')).toBeNull()
  })

  it('round-trips state through write + read', () => {
    writeLocalState('test-stack', SAMPLE_STATE)
    const loaded = readLocalState('test-stack')
    expect(loaded).toEqual(SAMPLE_STATE)
  })

  it('creates the state directory if it does not exist', () => {
    expect(existsSync(stateDir())).toBe(false)
    writeLocalState('test-stack', SAMPLE_STATE)
    expect(existsSync(stateDir())).toBe(true)
  })

  it('writes a JSON file with pretty-printing', () => {
    writeLocalState('test-stack', SAMPLE_STATE)
    const raw = readFileSync(statePath('test-stack'), 'utf-8')
    // pretty-printed = has newlines and indentation
    expect(raw).toContain('\n')
    expect(raw).toContain('  ')
  })

  it('overwrites existing state atomically', () => {
    writeLocalState('test-stack', SAMPLE_STATE)
    const updated: LocalState = { ...SAMPLE_STATE, publicIp: '10.0.0.99', sshHost: '10.0.0.99' }
    writeLocalState('test-stack', updated)
    const loaded = readLocalState('test-stack')
    expect(loaded?.publicIp).toBe('10.0.0.99')
  })
})

describe('localStateToConnectionInfo()', () => {
  it('maps LocalState fields to ConnectionInfo', () => {
    const conn = localStateToConnectionInfo(SAMPLE_STATE)
    expect(conn.host).toBe('192.168.1.10')
    expect(conn.port).toBe(22)
    expect(conn.user).toBe('root')
    expect(conn.privateKeyPath).toBe('/home/user/.clawops/id_ed25519')
    expect(conn.knownHostsPath).toBe('/home/user/.clawops/known_hosts')
  })
})
