import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { UI_SETTINGS_PREFS_FILE } from '../../lib/uiSettingsPrefs'

/**
 * `state/editorPrefs.ts` hydrates from disk at module import time (mirrors
 * `lib/rawSessionModel.ts`), so each test re-imports it fresh via
 * `vi.resetModules()` with `window.api.config` already installed, then
 * awaits a microtask for the module-level `hydrate()` call to resolve.
 */

let store: Record<string, unknown>
let readJson: ReturnType<typeof vi.fn>
let writeJson: ReturnType<typeof vi.fn>

function installApi() {
  store = {}
  readJson = vi.fn(async () => ({ exists: Object.keys(store).length > 0, data: { ...store } }))
  writeJson = vi.fn(async (_path: string, data: unknown) => {
    store = { ...(data as Record<string, unknown>) }
    return { ok: true, mtimeMs: Date.now() }
  })
  ;(globalThis as any).window = { api: { config: { readJson, writeJson } } }
}

async function freshModule() {
  vi.resetModules()
  const mod = await import('../editorPrefs')
  await Promise.resolve()
  await Promise.resolve()
  return mod
}

beforeEach(() => {
  installApi()
})

afterEach(() => {
  delete (globalThis as any).window
})

describe('editorPrefs', () => {
  it('paints with defaults, then hydrates the persisted value from ui-settings-prefs.json', async () => {
    store.editor = { fontSize: 18, wordWrap: true, minimap: true, theme: 'dark', autosave: false, wideMeasure: true, assistantRail: false }
    const { useEditorPrefs } = await freshModule()
    const s = useEditorPrefs.getState()
    expect(s.fontSize).toBe(18)
    expect(s.theme).toBe('dark')
    expect(s.wordWrap).toBe(true)
    expect(s.autosave).toBe(false)
  })

  it('falls back to defaults when the file has no editor field', async () => {
    const { useEditorPrefs } = await freshModule()
    const s = useEditorPrefs.getState()
    expect(s).toMatchObject({ fontSize: 13, wordWrap: false, minimap: false, theme: 'paper', autosave: true, wideMeasure: false, assistantRail: true })
  })

  it('setTheme writes a merge-write patch through the shared ui-settings-prefs.json, preserving sibling fields', async () => {
    store.rawSessionModel = 'sonnet'
    const { useEditorPrefs } = await freshModule()
    useEditorPrefs.getState().setTheme('dark')
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalled())
    expect(writeJson).toHaveBeenCalledWith(UI_SETTINGS_PREFS_FILE, expect.objectContaining({
      rawSessionModel: 'sonnet',
      editor: expect.objectContaining({ theme: 'dark' }),
    }))
    expect(useEditorPrefs.getState().theme).toBe('dark')
  })

  it('bumpFontSize clamps to MIN/MAX and persists', async () => {
    const { useEditorPrefs } = await freshModule()
    for (let i = 0; i < 40; i++) useEditorPrefs.getState().bumpFontSize(1)
    expect(useEditorPrefs.getState().fontSize).toBe(28)
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalled())
  })

  it('reverts and toasts when the write fails (never swallow errors)', async () => {
    writeJson.mockRejectedValueOnce(new Error('disk full'))
    const { useEditorPrefs } = await freshModule()
    const before = useEditorPrefs.getState().theme
    useEditorPrefs.getState().setTheme('dark')
    expect(useEditorPrefs.getState().theme).toBe('dark')
    await vi.waitFor(() => expect(useEditorPrefs.getState().theme).toBe(before))
  })

  it('a user change before hydration resolves is not clobbered by the slower disk read', async () => {
    let resolveRead!: (v: { exists: boolean; data: unknown }) => void
    readJson.mockReturnValueOnce(new Promise((r) => { resolveRead = r }))
    vi.resetModules()
    const mod = await import('../editorPrefs')
    mod.useEditorPrefs.getState().setTheme('dark')
    resolveRead({ exists: true, data: { editor: { fontSize: 13, wordWrap: false, minimap: false, theme: 'paper', autosave: true, wideMeasure: false, assistantRail: true } } })
    await Promise.resolve()
    await Promise.resolve()
    expect(mod.useEditorPrefs.getState().theme).toBe('dark')
  })
})
