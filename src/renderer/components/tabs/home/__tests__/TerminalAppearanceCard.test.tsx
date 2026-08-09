// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TerminalAppearanceCard } from '../TerminalAppearanceCard'
import { loadTerminalSettings, TERMINAL_FONT_DEFAULT } from '../../../../lib/terminalSettings'

/**
 * The terminal theme + font size are ONE app-wide preference shared by every
 * xterm in the app. They used to be edited from a gear popover pinned inside
 * the Terminal pane, which framed a machine-wide setting as a property of the
 * session on screen. This card is the replacement, and it has to both (a) say
 * what it reaches and (b) still drive the same store + live-update broadcast
 * the xterm instances subscribe to.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(createElement(TerminalAppearanceCard)) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

const click = (sel: string) => act(() => (container.querySelector(sel) as HTMLButtonElement).click())

describe('TerminalAppearanceCard', () => {
  it('states its real scope: every terminal, not this session, and not the app chrome or editor', () => {
    const text = container.textContent ?? ''
    expect(text).toContain('every terminal in the app at once')
    expect(text).toContain('not per project, per session, or per tab')
    expect(text).toContain('sm.terminal.settings')
    // The two other things called "theme" are named so they can't be confused.
    expect(text).toContain('app chrome')
    expect(text).toContain('Editor')
  })

  it('persists a theme change to the shared store', () => {
    expect(loadTerminalSettings().theme).toBe('dark')
    click('[data-testid="terminal-theme-paper"]')
    expect(loadTerminalSettings().theme).toBe('paper')
    expect(container.querySelector('[data-testid="terminal-theme-paper"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('broadcasts the change so live xterm instances repaint without a remount', () => {
    const heard = vi.fn()
    window.addEventListener('sm:terminal:settings', heard)
    click('[data-testid="terminal-theme-light"]')
    window.removeEventListener('sm:terminal:settings', heard)

    expect(heard).toHaveBeenCalledTimes(1)
    expect((heard.mock.calls[0][0] as CustomEvent).detail.theme).toBe('light')
  })

  it('bumps, clamps, and resets the font size', () => {
    const inc = () => click('[aria-label="Increase font size"]')
    const dec = () => click('[aria-label="Decrease font size"]')

    inc()
    expect(loadTerminalSettings().fontSize).toBe(TERMINAL_FONT_DEFAULT + 1)

    for (let i = 0; i < 40; i++) inc()
    expect(loadTerminalSettings().fontSize).toBe(22)
    expect((container.querySelector('[aria-label="Increase font size"]') as HTMLButtonElement).disabled).toBe(true)

    for (let i = 0; i < 40; i++) dec()
    expect(loadTerminalSettings().fontSize).toBe(10)
    expect((container.querySelector('[aria-label="Decrease font size"]') as HTMLButtonElement).disabled).toBe(true)

    act(() => (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'reset') as HTMLButtonElement).click())
    expect(loadTerminalSettings().fontSize).toBe(TERMINAL_FONT_DEFAULT)
  })
})
