// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TerminalAppearanceCard } from '../TerminalAppearanceCard'
import { TERMINAL_FONT_DEFAULT } from '../../../../lib/terminalSettings'

/**
 * The terminal theme + font size are ONE app-wide preference shared by every
 * xterm in the app. They used to be edited from a gear popover pinned inside
 * the Terminal pane, which framed a machine-wide setting as a property of the
 * session on screen. This card is the replacement, and it has to both (a) say
 * what it reaches and (b) still drive the same disk-backed file + live-update
 * broadcast the xterm instances subscribe to.
 */

let container: HTMLDivElement
let root: Root
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
  ;(globalThis as any).window.api = { config: { readJson, writeJson } }
}

async function mountAndHydrate() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(TerminalAppearanceCard))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  installApi()
  await mountAndHydrate()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as any).window?.api
})

const click = async (sel: string) => {
  await act(async () => {
    ;(container.querySelector(sel) as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const currentTheme = () => (store.terminal as { theme: string } | undefined)?.theme
const currentFontSize = () => (store.terminal as { fontSize: number } | undefined)?.fontSize

describe('TerminalAppearanceCard', () => {
  it('states its real scope: every terminal, not this session, and not the app chrome or editor', () => {
    const text = container.textContent ?? ''
    expect(text).toContain('every terminal in the app at once')
    expect(text).toContain('not per project, per session, or per tab')
    expect(text).toContain('ui-settings-prefs.json')
    // The two other things called "theme" are named so they can't be confused.
    expect(text).toContain('app chrome')
    expect(text).toContain('Editor')
  })

  it('persists a theme change via the IPC config path', async () => {
    expect(currentTheme()).toBeUndefined()
    await click('[data-testid="terminal-theme-paper"]')
    expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-settings-prefs.json',
      expect.objectContaining({ terminal: expect.objectContaining({ theme: 'paper' }) }),
    )
    expect(currentTheme()).toBe('paper')
    expect(container.querySelector('[data-testid="terminal-theme-paper"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('broadcasts the change so live xterm instances repaint without a remount', async () => {
    const heard = vi.fn()
    window.addEventListener('sm:terminal:settings', heard)
    await click('[data-testid="terminal-theme-light"]')
    window.removeEventListener('sm:terminal:settings', heard)

    expect(heard).toHaveBeenCalledTimes(1)
    expect((heard.mock.calls[0][0] as CustomEvent).detail.theme).toBe('light')
  })

  it('bumps, clamps, and resets the font size', async () => {
    const inc = () => click('[aria-label="Increase font size"]')
    const dec = () => click('[aria-label="Decrease font size"]')

    await inc()
    expect(currentFontSize()).toBe(TERMINAL_FONT_DEFAULT + 1)

    for (let i = 0; i < 40; i++) await inc()
    expect(currentFontSize()).toBe(22)
    expect((container.querySelector('[aria-label="Increase font size"]') as HTMLButtonElement).disabled).toBe(true)

    for (let i = 0; i < 40; i++) await dec()
    expect(currentFontSize()).toBe(10)
    expect((container.querySelector('[aria-label="Decrease font size"]') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      ;(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'reset') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(currentFontSize()).toBe(TERMINAL_FONT_DEFAULT)
  })

  it('paints with the default settings, then applies the persisted value once hydration resolves', async () => {
    act(() => root.unmount())
    container.remove()
    installApi()
    store.terminal = { theme: 'light', fontSize: 18 }
    await mountAndHydrate()
    expect(container.querySelector('[data-testid="terminal-theme-light"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('18px')
  })
})
