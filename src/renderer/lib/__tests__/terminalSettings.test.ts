// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  loadTerminalSettings,
  saveTerminalSettings,
  mountTerminalSettings,
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_THEMES,
  type TerminalSettings,
} from '../terminalSettings'
import { toast } from '../../state/toast'

function installApi(overrides: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config: overrides }
}

function fakeTerm() {
  return { options: {} as { theme?: unknown; fontSize?: number } }
}

afterEach(() => {
  delete (globalThis as any).window?.api
})

describe('terminalSettings', () => {
  it('loadTerminalSettings returns the default when no file exists', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson: vi.fn() })
    expect(await loadTerminalSettings()).toEqual(DEFAULT_TERMINAL_SETTINGS)
  })

  it('loadTerminalSettings sanitizes an invalid persisted theme/fontSize', async () => {
    installApi({
      readJson: vi.fn().mockResolvedValue({ exists: true, data: { terminal: { theme: 'neon', fontSize: 999 } } }),
      writeJson: vi.fn(),
    })
    expect(await loadTerminalSettings()).toEqual(DEFAULT_TERMINAL_SETTINGS)
  })

  it('saveTerminalSettings writes via IPC and broadcasts the live-update event', async () => {
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson })
    const heard = vi.fn()
    window.addEventListener('sm:terminal:settings', heard)
    const s: TerminalSettings = { theme: 'paper', fontSize: 16 }
    await saveTerminalSettings(s)
    window.removeEventListener('sm:terminal:settings', heard)

    expect(writeJson).toHaveBeenCalledWith('~/.claude/session-manager/ui-settings-prefs.json', { terminal: s })
    expect(heard).toHaveBeenCalledTimes(1)
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual(s)
  })

  it('saveTerminalSettings toasts on a write failure but still broadcasts (never swallows the error)', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson: vi.fn().mockRejectedValue(new Error('disk full')) })
    const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const heard = vi.fn()
    window.addEventListener('sm:terminal:settings', heard)
    await saveTerminalSettings({ theme: 'light', fontSize: 14 })
    window.removeEventListener('sm:terminal:settings', heard)

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Couldn't save"))
    expect(heard).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('mountTerminalSettings applies the loaded value once it resolves', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: true, data: { terminal: { theme: 'paper', fontSize: 17 } } }), writeJson: vi.fn() })
    const term = fakeTerm()
    const off = mountTerminalSettings(term as any)
    await vi.waitFor(() => expect(term.options.fontSize).toBe(17))
    expect(term.options.theme).toEqual(TERMINAL_THEMES.paper)
    off()
  })

  it('a live update that arrives before the initial load resolves wins — the late initial load must not undo it (regression)', async () => {
    let resolveRead: (v: unknown) => void = () => {}
    installApi({ readJson: vi.fn().mockReturnValue(new Promise((r) => { resolveRead = r })), writeJson: vi.fn() })
    const term = fakeTerm()
    const off = mountTerminalSettings(term as any)

    // A live broadcast (e.g. from TerminalAppearanceCard in another window)
    // arrives while this mount's own initial load is still in flight.
    window.dispatchEvent(new CustomEvent('sm:terminal:settings', { detail: { theme: 'light', fontSize: 20 } as TerminalSettings }))
    expect(term.options.theme).toEqual(TERMINAL_THEMES.light)
    expect(term.options.fontSize).toBe(20)

    // The slower initial load now resolves with an OLDER value — it must not
    // overwrite the live update that already landed.
    resolveRead({ exists: true, data: { terminal: { theme: 'paper', fontSize: 13 } } })
    await new Promise((r) => setTimeout(r, 0))
    expect(term.options.theme).toEqual(TERMINAL_THEMES.light)
    expect(term.options.fontSize).toBe(20)

    off()
  })

  it('the initial load does not apply after mountTerminalSettings has been unsubscribed', async () => {
    let resolveRead: (v: unknown) => void = () => {}
    installApi({ readJson: vi.fn().mockReturnValue(new Promise((r) => { resolveRead = r })), writeJson: vi.fn() })
    const term = fakeTerm()
    const off = mountTerminalSettings(term as any)
    off()

    resolveRead({ exists: true, data: { terminal: { theme: 'paper', fontSize: 17 } } })
    await new Promise((r) => setTimeout(r, 0))
    expect(term.options.theme).toBeUndefined()
    expect(term.options.fontSize).toBeUndefined()
  })
})
