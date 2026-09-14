import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  accountFromProfile, azureCliAccount, azureConfigDir, resolveSubscriptionId,
} from '../../../src/providers/azure/cli-auth.js'

const PROFILE = {
  subscriptions: [
    { id: 'sub-one', name: 'Pay-As-You-Go', isDefault: false, user: { name: 'a@b.c' } },
    { id: 'sub-two', name: 'Production', isDefault: true, user: { name: 'a@b.c' } },
  ],
}

const VARS = ['AZURE_CONFIG_DIR', 'ARM_SUBSCRIPTION_ID', 'AZURE_SUBSCRIPTION_ID', 'HOME'] as const
const saved: Record<string, string | undefined> = {}
let dir: string

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v]
    if (v !== 'HOME') delete process.env[v]
  }
  dir = mkdtempSync(path.join(tmpdir(), 'azure-cfg-'))
  process.env['AZURE_CONFIG_DIR'] = dir
})
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  rmSync(dir, { recursive: true, force: true })
})

function writeProfile(body: unknown | string) {
  writeFileSync(
    path.join(dir, 'azureProfile.json'),
    typeof body === 'string' ? body : JSON.stringify(body),
  )
}

describe('accountFromProfile', () => {
  it('picks the default subscription', () => {
    expect(accountFromProfile(JSON.stringify(PROFILE))).toMatchObject({
      subscriptionId: 'sub-two',
      name: 'Production',
      user: 'a@b.c',
    })
  })

  it('falls back to the first when none is flagged, as the CLI does', () => {
    const none = { subscriptions: PROFILE.subscriptions.map((s) => ({ ...s, isDefault: false })) }
    expect(accountFromProfile(JSON.stringify(none))?.subscriptionId).toBe('sub-one')
  })

  it('strips the BOM the Azure CLI writes', () => {
    // az writes this file UTF-8 with a BOM, which JSON.parse rejects outright.
    expect(accountFromProfile('﻿' + JSON.stringify(PROFILE))?.subscriptionId).toBe('sub-two')
  })

  it('treats an empty subscription list as not logged in', () => {
    // This is what `az logout` leaves behind.
    expect(accountFromProfile(JSON.stringify({ subscriptions: [] }))).toBeUndefined()
  })

  it('ignores an entry with no id', () => {
    expect(accountFromProfile(JSON.stringify({ subscriptions: [{ name: 'x' }] }))).toBeUndefined()
  })

  it('returns undefined for a file that is not JSON', () => {
    expect(accountFromProfile('not json')).toBeUndefined()
  })

  it('survives a missing user block', () => {
    const noUser = { subscriptions: [{ id: 'sub-one', name: 'x', isDefault: true }] }
    expect(accountFromProfile(JSON.stringify(noUser))).toEqual({
      subscriptionId: 'sub-one',
      name: 'x',
    })
  })
})

describe('azureCliAccount', () => {
  it('reads the profile from AZURE_CONFIG_DIR', () => {
    writeProfile(PROFILE)
    expect(azureCliAccount()?.subscriptionId).toBe('sub-two')
  })

  it('is undefined when there is no profile at all', () => {
    expect(azureCliAccount()).toBeUndefined()
  })

  it('is undefined, not an error, when the file is unreadable', () => {
    writeProfile('{ broken')
    expect(() => azureCliAccount()).not.toThrow()
    expect(azureCliAccount()).toBeUndefined()
  })

  it('honours AZURE_CONFIG_DIR over HOME', () => {
    writeProfile(PROFILE)
    expect(azureConfigDir()).toBe(dir)
  })
})

describe('resolveSubscriptionId', () => {
  it('prefers ARM_SUBSCRIPTION_ID, which Pulumi reads first', () => {
    writeProfile(PROFILE)
    process.env['ARM_SUBSCRIPTION_ID'] = 'from-arm'
    process.env['AZURE_SUBSCRIPTION_ID'] = 'from-azure'
    expect(resolveSubscriptionId()).toBe('from-arm')
  })

  it('then AZURE_SUBSCRIPTION_ID', () => {
    writeProfile(PROFILE)
    process.env['AZURE_SUBSCRIPTION_ID'] = 'from-azure'
    expect(resolveSubscriptionId()).toBe('from-azure')
  })

  it('then the CLI default, so doctor reports what apply will use', () => {
    writeProfile(PROFILE)
    expect(resolveSubscriptionId()).toBe('sub-two')
  })

  it('is undefined when nothing names one', () => {
    expect(resolveSubscriptionId()).toBeUndefined()
  })
})
