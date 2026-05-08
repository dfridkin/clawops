import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let logs: string[] = []
let errors: string[] = []
let warns: string[] = []

beforeEach(() => {
  logs = []
  errors = []
  warns = []
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation((...args) => { warns.push(args.join(' ')) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('success()', () => {
  it('calls console.log with the message', async () => {
    const { success } = await import('../../src/output/human.js')
    success('deploy complete')
    expect(logs.join('')).toContain('deploy complete')
  })

  it('output contains a checkmark indicator', async () => {
    const { success } = await import('../../src/output/human.js')
    success('ok')
    expect(logs.join('')).toMatch(/✓/)
  })
})

describe('failure()', () => {
  it('calls console.error with the message', async () => {
    const { failure } = await import('../../src/output/human.js')
    failure('something went wrong')
    expect(errors.join('')).toContain('something went wrong')
  })

  it('output contains a cross indicator', async () => {
    const { failure } = await import('../../src/output/human.js')
    failure('bad')
    expect(errors.join('')).toMatch(/✗/)
  })
})

describe('warn()', () => {
  it('calls console.warn with the message', async () => {
    const { warn } = await import('../../src/output/human.js')
    warn('low disk')
    expect(warns.join('')).toContain('low disk')
  })
})

describe('info()', () => {
  it('calls console.log with the message', async () => {
    const { info } = await import('../../src/output/human.js')
    info('gateway up')
    expect(logs.join('')).toContain('gateway up')
  })
})
