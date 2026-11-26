import { describe, it, expect, afterEach, vi } from 'vitest'
import { pickDefaultEpicAgent, readLastEpicAgent, rememberEpicAgent } from '../epicAgentDefault'
import { uiPrefsPath } from '../uiPrefs'

function installApi(config: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config }
}

afterEach(() => {
  delete (globalThis as any).window?.api
})

const personas = (...names: string[]) => names.map((name) => ({ name })) as any[]

describe('pickDefaultEpicAgent', () => {
  it('chooses the last agent when present', () => {
    expect(pickDefaultEpicAgent(personas('architect', 'claude'), 'claude')).toBe('claude')
  })
  it('falls back to architect when the last agent was deleted', () => {
    expect(pickDefaultEpicAgent(personas('claude', 'architect'), 'gone')).toBe('architect')
    expect(pickDefaultEpicAgent(personas('claude', 'architect'), null)).toBe('architect')
  })
  it('falls back to the first persona when there is no architect', () => {
    expect(pickDefaultEpicAgent(personas('claude', 'builder'), 'gone')).toBe('claude')
  })
  it('returns empty string for null or empty agents', () => {
    expect(pickDefaultEpicAgent(null, 'architect')).toBe('')
    expect(pickDefaultEpicAgent([], undefined)).toBe('')
  })
})

describe('readLastEpicAgent', () => {
  it('returns the stored name', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { lastEpicAgent: 'claude' } })
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readLastEpicAgent('/p')).toBe('claude')
    expect(readJson).toHaveBeenCalledWith(uiPrefsPath('/p'))
  })
  it('returns null on missing file, number, empty string, empty cwd, and read failure', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson: vi.fn() })
    expect(await readLastEpicAgent('/p')).toBeNull()
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: true, data: { lastEpicAgent: 5 } }), writeJson: vi.fn() })
    expect(await readLastEpicAgent('/p')).toBeNull()
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: true, data: { lastEpicAgent: '' } }), writeJson: vi.fn() })
    expect(await readLastEpicAgent('/p')).toBeNull()
    expect(await readLastEpicAgent('')).toBeNull()
    installApi({ readJson: vi.fn().mockRejectedValue(new Error('boom')), writeJson: vi.fn() })
    expect(await readLastEpicAgent('/p')).toBeNull()
  })
})

describe('rememberEpicAgent', () => {
  it('writes only lastEpicAgent and keeps other fields', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { queueFilterStatus: 'done', lastEpicAgent: 'old' } })
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson, writeJson })
    await rememberEpicAgent('/p', 'claude')
    expect(writeJson).toHaveBeenCalledWith(uiPrefsPath('/p'), { queueFilterStatus: 'done', lastEpicAgent: 'claude' }, 'ui-prefs')
  })
  it('is a no-op for empty cwd or name', async () => {
    const writeJson = vi.fn()
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson })
    await rememberEpicAgent('', 'claude')
    await rememberEpicAgent('/p', '')
    expect(writeJson).not.toHaveBeenCalled()
  })
})
