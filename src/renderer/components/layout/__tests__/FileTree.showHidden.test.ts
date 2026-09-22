// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { loadShowHidden, saveShowHidden } from '../FileTree'

function installApi(overrides: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config: overrides }
}

afterEach(() => {
  delete (globalThis as any).window?.api
})

describe('FileTree showHidden hydrate', () => {
  it('defaults to true when never set', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson: vi.fn() })
    expect(await loadShowHidden()).toBe(true)
  })

  it('honors an explicitly stored false', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: true, data: { fileTreeShowHidden: false } }), writeJson: vi.fn() })
    expect(await loadShowHidden()).toBe(false)
  })

  it('honors an explicitly stored true', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: true, data: { fileTreeShowHidden: true } }), writeJson: vi.fn() })
    expect(await loadShowHidden()).toBe(true)
  })

  it('saveShowHidden persists through the machine-wide ui-settings-prefs file', async () => {
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson })
    saveShowHidden(false)
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-settings-prefs.json',
      expect.objectContaining({ fileTreeShowHidden: false }),
    ))
  })
})
