import { describe, it, expect, afterEach, vi } from 'vitest'
import { readUiSettingsPrefs, writeUiSettingsPrefs, UI_SETTINGS_PREFS_FILE } from '../uiSettingsPrefs'

function installApi(overrides: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config: overrides }
}

afterEach(() => {
  delete (globalThis as any).window?.api
})

describe('uiSettingsPrefs', () => {
  it('readUiSettingsPrefs returns {} when the file does not exist', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: false })
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readUiSettingsPrefs()).toEqual({})
    expect(readJson).toHaveBeenCalledWith(UI_SETTINGS_PREFS_FILE)
  })

  it('readUiSettingsPrefs returns {} when window.api is unavailable', async () => {
    delete (globalThis as any).window?.api
    expect(await readUiSettingsPrefs()).toEqual({})
  })

  it('readUiSettingsPrefs returns the persisted data when the file exists', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { rawSessionModel: 'sonnet' } })
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readUiSettingsPrefs()).toEqual({ rawSessionModel: 'sonnet' })
  })

  it('readUiSettingsPrefs returns {} when the read throws', async () => {
    const readJson = vi.fn().mockRejectedValue(new Error('boom'))
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readUiSettingsPrefs()).toEqual({})
  })

  it('writeUiSettingsPrefs merges the patch with existing prefs so one field never clobbers the other', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { terminal: { theme: 'dark', fontSize: 13 } } })
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson, writeJson })
    await writeUiSettingsPrefs({ rawSessionModel: 'sonnet' })
    expect(writeJson).toHaveBeenCalledWith(UI_SETTINGS_PREFS_FILE, {
      terminal: { theme: 'dark', fontSize: 13 },
      rawSessionModel: 'sonnet',
    })
  })

  it('writeUiSettingsPrefs propagates a write failure to the caller (no silent swallow)', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: false })
    const writeJson = vi.fn().mockRejectedValue(new Error('disk full'))
    installApi({ readJson, writeJson })
    await expect(writeUiSettingsPrefs({ rawSessionModel: 'sonnet' })).rejects.toThrow('disk full')
  })
})
