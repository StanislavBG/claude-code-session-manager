import { describe, it, expect, afterEach, vi } from 'vitest'
import { readAppPrefs, writeAppPrefs, APP_PREFS_FILE } from '../appPrefs'

function installApi(overrides: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config: overrides }
}

afterEach(() => {
  delete (globalThis as any).window?.api
})

describe('appPrefs', () => {
  it('readAppPrefs returns {} when the file does not exist', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: false })
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readAppPrefs()).toEqual({})
    expect(readJson).toHaveBeenCalledWith(APP_PREFS_FILE)
  })

  it('readAppPrefs returns {} when window.api is unavailable', async () => {
    delete (globalThis as any).window?.api
    expect(await readAppPrefs()).toEqual({})
  })

  it('readAppPrefs returns the persisted data when the file exists', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { openToHomeOnLaunch: true } })
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readAppPrefs()).toEqual({ openToHomeOnLaunch: true })
  })

  it('readAppPrefs returns {} when the read throws', async () => {
    const readJson = vi.fn().mockRejectedValue(new Error('boom'))
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readAppPrefs()).toEqual({})
  })

  it('writeAppPrefs merges the patch with existing prefs and writes via config.writeJson', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { somethingElse: 1 } })
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson, writeJson })
    await writeAppPrefs({ openToHomeOnLaunch: true })
    expect(writeJson).toHaveBeenCalledWith(APP_PREFS_FILE, { somethingElse: 1, openToHomeOnLaunch: true })
  })

  it('writeAppPrefs propagates a write failure to the caller (no silent swallow)', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: false })
    const writeJson = vi.fn().mockRejectedValue(new Error('disk full'))
    installApi({ readJson, writeJson })
    await expect(writeAppPrefs({ openToHomeOnLaunch: true })).rejects.toThrow('disk full')
  })
})
