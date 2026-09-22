import { describe, it, expect, afterEach, vi } from 'vitest'

function installApi(overrides: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config: overrides }
}

/**
 * `rawSessionModel.ts` hydrates from disk as a module-level side effect (its
 * `void hydrate()` call), so each test needs a fresh module instance —
 * `vi.resetModules()` + a dynamic import — to observe hydration in isolation.
 */
async function freshModule() {
  vi.resetModules()
  return import('../rawSessionModel')
}

afterEach(() => {
  delete (globalThis as any).window?.api
})

describe('rawSessionModel', () => {
  it('getRawSessionModel() returns the default synchronously before hydration resolves', async () => {
    let resolveRead: (v: unknown) => void = () => {}
    const readJson = vi.fn().mockReturnValue(new Promise((r) => { resolveRead = r }))
    installApi({ readJson, writeJson: vi.fn() })
    const { getRawSessionModel } = await freshModule()
    expect(getRawSessionModel()).toBe('opus')
    resolveRead({ exists: false })
  })

  it('hydrates the cache from disk once the read resolves', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { rawSessionModel: 'sonnet' } })
    installApi({ readJson, writeJson: vi.fn() })
    const { getRawSessionModel } = await freshModule()
    await vi.waitFor(() => expect(getRawSessionModel()).toBe('sonnet'))
    expect(readJson).toHaveBeenCalled()
  })

  it('ignores a malformed persisted value and stays at the default', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { rawSessionModel: 'not a model; rm -rf' } })
    installApi({ readJson, writeJson: vi.fn() })
    const { getRawSessionModel } = await freshModule()
    await Promise.resolve()
    await Promise.resolve()
    expect(getRawSessionModel()).toBe('opus')
  })

  it('setRawSessionModel updates the cache and persists via writeUiSettingsPrefs', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson: vi.fn().mockResolvedValue(undefined) })
    const { getRawSessionModel, setRawSessionModel } = await freshModule()
    const writeJson = (globalThis as any).window.api.config.writeJson
    setRawSessionModel('haiku')
    expect(getRawSessionModel()).toBe('haiku')
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-settings-prefs.json',
      expect.objectContaining({ rawSessionModel: 'haiku' }),
    ))
  })
})
