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

  it('serializes two overlapping writes so the later one never reads a stale snapshot (cross-feature TOCTOU)', async () => {
    let store: Record<string, unknown> = {}
    const readJson = vi.fn(async () => ({ exists: Object.keys(store).length > 0, data: { ...store } }))
    const writeResolvers: Array<() => void> = []
    const writeJson = vi.fn((_path: string, data: unknown) => new Promise<void>((resolve) => {
      writeResolvers.push(() => {
        store = { ...(data as Record<string, unknown>) }
        resolve()
      })
    }))
    installApi({ readJson, writeJson })

    // rawSessionModel.ts and terminalSettings.ts both write through this
    // module — issuing their writes back-to-back must not let the second
    // one's read-modify-write cycle start before the first one's write lands.
    const p1 = writeUiSettingsPrefs({ rawSessionModel: 'sonnet' })
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledTimes(1))

    const p2 = writeUiSettingsPrefs({ terminal: { theme: 'paper', fontSize: 18 } })
    // p2 must be queued behind p1, not racing its read against p1's write.
    await new Promise((r) => setTimeout(r, 0))
    expect(writeJson).toHaveBeenCalledTimes(1)

    writeResolvers[0]()
    await p1
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledTimes(2))
    // p2's read-modify-write must have picked up p1's already-applied field.
    expect(writeJson.mock.calls[1][1]).toEqual({
      rawSessionModel: 'sonnet',
      terminal: { theme: 'paper', fontSize: 18 },
    })

    writeResolvers[1]()
    await p2
    expect(store).toEqual({
      rawSessionModel: 'sonnet',
      terminal: { theme: 'paper', fontSize: 18 },
    })
  })
})
