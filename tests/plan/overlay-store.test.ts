import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const OVERLAYS_DIR = path.join(os.homedir(), '.clawops', 'overlays')

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

async function getMod() {
  return import('../../src/plan/overlay-store.js')
}

async function getFs() {
  return import('node:fs')
}

const SAMPLE_OVERLAY = { gateway: { auth: { mode: 'token' } }, models: {} }
const SAMPLE_SECRETS = [{ name: 'API_KEY', source: 'file' as const, ref: '/home/user/.clawops/secrets/API_KEY' }]

describe('saveOverlay', () => {
  it('creates the overlays directory', async () => {
    const { mkdirSync } = await getFs()
    const { saveOverlay } = await getMod()
    saveOverlay('my-stack', SAMPLE_OVERLAY, SAMPLE_SECRETS)
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(OVERLAYS_DIR, { recursive: true })
  })

  it('writes JSON with stackName, overlay, and secrets', async () => {
    const { writeFileSync } = await getFs()
    const { saveOverlay } = await getMod()
    saveOverlay('my-stack', SAMPLE_OVERLAY, SAMPLE_SECRETS)

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce()
    const [filePath, content] = vi.mocked(writeFileSync).mock.calls[0]!
    expect(filePath).toBe(path.join(OVERLAYS_DIR, 'my-stack.json'))
    const parsed = JSON.parse(content as string)
    expect(parsed.stackName).toBe('my-stack')
    expect(parsed.overlay).toEqual(SAMPLE_OVERLAY)
    expect(parsed.secrets).toEqual(SAMPLE_SECRETS)
    expect(parsed.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })
})

describe('loadOverlay', () => {
  it('returns null when the file does not exist', async () => {
    const { existsSync } = await getFs()
    vi.mocked(existsSync).mockReturnValue(false)
    const { loadOverlay } = await getMod()
    expect(loadOverlay('missing')).toBeNull()
  })

  it('returns parsed overlay when file exists', async () => {
    const { existsSync, readFileSync } = await getFs()
    vi.mocked(existsSync).mockReturnValue(true)
    const data = { stackName: 'my-stack', savedAt: '2026-05-13T00:00:00Z', overlay: SAMPLE_OVERLAY, secrets: SAMPLE_SECRETS }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(data))
    const { loadOverlay } = await getMod()
    expect(loadOverlay('my-stack')).toEqual(data)
  })

  it('returns null when file content is invalid JSON', async () => {
    const { existsSync, readFileSync } = await getFs()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('not-json{{{')
    const { loadOverlay } = await getMod()
    expect(loadOverlay('bad')).toBeNull()
  })
})

describe('listOverlays', () => {
  it('returns empty array when overlays dir does not exist', async () => {
    const { existsSync } = await getFs()
    vi.mocked(existsSync).mockReturnValue(false)
    const { listOverlays } = await getMod()
    expect(listOverlays()).toEqual([])
  })

  it('returns parsed overlays for each JSON file', async () => {
    const { existsSync, readdirSync, readFileSync } = await getFs()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue(['prod.json', 'staging.json'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    const prod = { stackName: 'prod', savedAt: '2026-05-13T00:00:00Z', overlay: {}, secrets: [] }
    const staging = { stackName: 'staging', savedAt: '2026-05-13T00:00:00Z', overlay: {}, secrets: [] }
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(prod))
      .mockReturnValueOnce(JSON.stringify(staging))
    const { listOverlays } = await getMod()
    expect(listOverlays()).toEqual([prod, staging])
  })

  it('skips non-JSON files', async () => {
    const { existsSync, readdirSync, readFileSync } = await getFs()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue(['prod.json', '.DS_Store', 'notes.txt'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    const prod = { stackName: 'prod', savedAt: '2026-05-13T00:00:00Z', overlay: {}, secrets: [] }
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(prod))
    const { listOverlays } = await getMod()
    expect(listOverlays()).toHaveLength(1)
    expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1)
  })

  it('skips files with invalid JSON', async () => {
    const { existsSync, readdirSync, readFileSync } = await getFs()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue(['good.json', 'corrupt.json'] as unknown as ReturnType<typeof import('node:fs').readdirSync>)
    const good = { stackName: 'good', savedAt: '2026-05-13T00:00:00Z', overlay: {}, secrets: [] }
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(good))
      .mockReturnValueOnce('{{bad json}}')
    const { listOverlays } = await getMod()
    expect(listOverlays()).toEqual([good])
  })
})
