import { describe, it, expect, afterEach, vi } from 'vitest'
import { useUiChromePrefs } from '../uiChromePrefs'

function installApi(overrides: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config: overrides }
}

const DEFAULTS = {
  sidebarWidth: 252,
  sidebarCollapsed: false,
  collapsedGroups: [],
  learningPanelCollapsed: false,
  tourCompletedAt: null,
  density: 'roomy',
}

afterEach(() => {
  delete (globalThis as any).window?.api
  useUiChromePrefs.setState({ ...DEFAULTS, hydrated: false } as any)
})

describe('uiChromePrefs', () => {
  it('starts with the default values before hydration', () => {
    const s = useUiChromePrefs.getState()
    expect(s.hydrated).toBe(false)
    expect(s.sidebarWidth).toBe(252)
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.collapsedGroups).toEqual([])
    expect(s.learningPanelCollapsed).toBe(false)
    expect(s.tourCompletedAt).toBeNull()
    expect(s.density).toBe('roomy')
  })

  it('hydrate() populates from disk when the file exists', async () => {
    const readJson = vi.fn().mockResolvedValue({
      exists: true,
      data: {
        sidebarWidth: 300,
        sidebarCollapsed: true,
        collapsedGroups: ['Tools'],
        learningPanelCollapsed: true,
        tourCompletedAt: 12345,
        density: 'compact',
      },
    })
    installApi({ readJson, writeJson: vi.fn() })
    await useUiChromePrefs.getState().hydrate()
    expect(readJson).toHaveBeenCalledWith('~/.claude/session-manager/ui-chrome-prefs.json')
    const s = useUiChromePrefs.getState()
    expect(s.hydrated).toBe(true)
    expect(s.sidebarWidth).toBe(300)
    expect(s.sidebarCollapsed).toBe(true)
    expect(s.collapsedGroups).toEqual(['Tools'])
    expect(s.learningPanelCollapsed).toBe(true)
    expect(s.tourCompletedAt).toBe(12345)
    expect(s.density).toBe('compact')
  })

  it('hydrate() falls back to defaults when the file does not exist', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson: vi.fn() })
    await useUiChromePrefs.getState().hydrate()
    expect(useUiChromePrefs.getState().hydrated).toBe(true)
    expect(useUiChromePrefs.getState().sidebarWidth).toBe(252)
  })

  it('hydrate() marks hydrated even when the read throws', async () => {
    installApi({ readJson: vi.fn().mockRejectedValue(new Error('boom')), writeJson: vi.fn() })
    await useUiChromePrefs.getState().hydrate()
    expect(useUiChromePrefs.getState().hydrated).toBe(true)
  })

  it('setSidebarWidth clamps to [180, 480] and persists via writeJson', () => {
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson: vi.fn(), writeJson })
    useUiChromePrefs.getState().setSidebarWidth(999)
    expect(useUiChromePrefs.getState().sidebarWidth).toBe(480)
    expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-chrome-prefs.json',
      expect.objectContaining({ sidebarWidth: 480 }),
    )
  })

  it('setDensity updates state and persists', () => {
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson: vi.fn(), writeJson })
    useUiChromePrefs.getState().setDensity('compact')
    expect(useUiChromePrefs.getState().density).toBe('compact')
    expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-chrome-prefs.json',
      expect.objectContaining({ density: 'compact' }),
    )
  })

  it('setTourCompletedAt persists a timestamp or null', () => {
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson: vi.fn(), writeJson })
    useUiChromePrefs.getState().setTourCompletedAt(555)
    expect(useUiChromePrefs.getState().tourCompletedAt).toBe(555)
    useUiChromePrefs.getState().setTourCompletedAt(null)
    expect(useUiChromePrefs.getState().tourCompletedAt).toBeNull()
  })

  it('dedupes concurrent hydrate() calls into a single readJson() round trip', async () => {
    let resolveRead: (v: unknown) => void = () => {}
    const readJson = vi.fn().mockReturnValue(new Promise((r) => { resolveRead = r }))
    installApi({ readJson, writeJson: vi.fn() })

    const p1 = useUiChromePrefs.getState().hydrate()
    const p2 = useUiChromePrefs.getState().hydrate()
    expect(readJson).toHaveBeenCalledTimes(1)

    resolveRead({ exists: true, data: { sidebarWidth: 300 } })
    await Promise.all([p1, p2])
    expect(useUiChromePrefs.getState().sidebarWidth).toBe(300)
  })

  it('defers a setter fired before hydration resolves, persisting the merged (not default) state', async () => {
    let resolveRead: (v: unknown) => void = () => {}
    const readJson = vi.fn().mockReturnValue(new Promise((r) => { resolveRead = r }))
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson, writeJson })

    const hydrating = useUiChromePrefs.getState().hydrate()
    // Fires while the read is still in flight — must not persist defaults
    // for the other, not-yet-loaded fields.
    useUiChromePrefs.getState().setDensity('compact')
    expect(writeJson).not.toHaveBeenCalled()

    resolveRead({ exists: true, data: { collapsedGroups: ['Tools'] } })
    await hydrating

    expect(writeJson).toHaveBeenCalledTimes(1)
    expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-chrome-prefs.json',
      expect.objectContaining({ collapsedGroups: ['Tools'], density: 'compact' }),
    )
  })
})
