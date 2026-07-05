/**
 * Tiny floating controls overlay for the Terminal pane.
 *
 * Renders a gear button in the top-right of the terminal area; click reveals
 * a popover with theme (Dark / Light / Paper) and font-size +/- controls.
 * Settings persist to localStorage and broadcast on a `sm:terminal:settings`
 * window event so live xterm instances can update their theme/font on the fly
 * without a remount (xterm v5 supports `term.options.theme = …` live).
 *
 * Kept in a separate file from Terminal.tsx so the gear UI doesn't have to
 * sit inside the xterm's effect-heavy render path.
 */

import { useEffect, useRef, useState } from 'react'
import type { ITheme } from '@xterm/xterm'

export type TerminalThemeName = 'dark' | 'light' | 'paper'

export interface TerminalSettings {
  theme: TerminalThemeName
  fontSize: number
}

const STORAGE_KEY = 'sm.terminal.settings'
const EVENT_NAME = 'sm:terminal:settings'

export const TERMINAL_FONT_MIN = 10
export const TERMINAL_FONT_MAX = 22
export const TERMINAL_FONT_DEFAULT = 13

const DEFAULT_SETTINGS: TerminalSettings = {
  theme: 'dark',
  fontSize: TERMINAL_FONT_DEFAULT,
}

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<TerminalSettings>
    return {
      theme: (parsed.theme === 'light' || parsed.theme === 'paper' || parsed.theme === 'dark')
        ? parsed.theme
        : DEFAULT_SETTINGS.theme,
      fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= TERMINAL_FONT_MIN && parsed.fontSize <= TERMINAL_FONT_MAX
        ? parsed.fontSize
        : DEFAULT_SETTINGS.fontSize,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveTerminalSettings(s: TerminalSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent<TerminalSettings>(EVENT_NAME, { detail: s }))
}

/** Subscribe a live xterm instance to settings changes. */
export function onTerminalSettingsChange(handler: (s: TerminalSettings) => void): () => void {
  const fn = (e: Event) => {
    const ce = e as CustomEvent<TerminalSettings>
    handler(ce.detail)
  }
  window.addEventListener(EVENT_NAME, fn)
  return () => window.removeEventListener(EVENT_NAME, fn)
}

// ────────────────────────────────────────────────────────────────────
// xterm theme objects
// ────────────────────────────────────────────────────────────────────

export const TERMINAL_THEMES: Record<TerminalThemeName, ITheme> = {
  // Classic dark (the pre-Almanac default). Black background, light foreground.
  dark: {
    background: '#0b0d10',
    foreground: '#e6e8ec',
    cursor: '#d97757',
    selectionBackground: '#3a4250',
    black: '#1a1f27',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#e6e8ec',
    brightBlack: '#545c68',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  // VS Code-style light theme — white bg, dark text. Works on any wrapper.
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: '#cce5ff',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#a45a16',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#9a6700',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#1f2328',
  },
  // Paper-warm — matches the Almanac chrome. The redesigned palette I shipped
  // in v0.13.0 and the user asked to dethrone as default. 2026-07-05: several
  // ANSI colors (esp. the brights) were below WCAG AA 4.5:1 against the cream
  // background — bad enough that live CLI output using those codes (very
  // common: warnings/info in bright yellow/cyan/etc.) was unreadable. Every
  // color below is retuned to >=4.5:1 against #f6efe1, same hue family.
  // NOTE FOR REVIEW: this is a contrast-only patch, not a full pass — revisit
  // once the broader Almanac-wide reskin (design import) is actually built,
  // in case the shared palette tokens change again.
  paper: {
    background: '#f6efe1',
    foreground: '#2a221a',
    cursor: '#a7532f',
    selectionBackground: '#e0d3b8',
    black: '#2a221a',
    red: '#b8443c',
    green: '#5c6f3a',
    yellow: '#8e641a',
    blue: '#3a6ea5',
    magenta: '#8a4a8c',
    cyan: '#38767e',
    white: '#5b4a36',
    brightBlack: '#796b54',
    brightRed: '#b8493f',
    brightGreen: '#65714a',
    brightYellow: '#8c641e',
    brightBlue: '#416ea1',
    brightMagenta: '#925494',
    brightCyan: '#3e757d',
    brightWhite: '#2a221a',
  },
}

// ────────────────────────────────────────────────────────────────────
// UI: gear button + popover
// ────────────────────────────────────────────────────────────────────

export function TerminalControls() {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<TerminalSettings>(() => loadTerminalSettings())
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Click-outside dismissal.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const update = (patch: Partial<TerminalSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveTerminalSettings(next)
      return next
    })
  }

  const bumpFont = (delta: number) => {
    const next = Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, settings.fontSize + delta))
    update({ fontSize: next })
  }

  return (
    <div className="absolute top-2 right-2 z-20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Terminal settings"
        title="Terminal settings"
        className="w-7 h-7 grid place-items-center rounded-md border border-line bg-bg-elev/80 text-fg-dim hover:text-fg hover:bg-bg-hi backdrop-blur-sm transition-colors"
      >
        <Gear />
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Terminal settings"
          className="absolute top-9 right-0 w-[240px] bg-bg-elev border border-line rounded-lg shadow-xl p-3 text-fg"
        >
          <div className="text-[10px] uppercase tracking-wider text-fg-faint mb-1.5">Theme</div>
          <div className="grid grid-cols-3 gap-1 mb-3">
            {(['dark', 'light', 'paper'] as TerminalThemeName[]).map((t) => (
              <button
                key={t}
                onClick={() => update({ theme: t })}
                aria-pressed={settings.theme === t}
                className={`px-2 py-1.5 rounded text-[11px] font-medium border transition-colors ${
                  settings.theme === t
                    ? 'bg-bg-hi border-accent text-fg'
                    : 'bg-bg border-line text-fg-dim hover:text-fg hover:border-fg-faint'
                }`}
              >
                <ThemeSwatch theme={t} />
                <div className="mt-1 capitalize">{t}</div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-fg-faint">Font size</span>
            <span className="font-mono text-[11px] text-fg-dim">{settings.fontSize}px</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => bumpFont(-1)}
              disabled={settings.fontSize <= TERMINAL_FONT_MIN}
              aria-label="Decrease font size"
              className="flex-1 py-1 rounded border border-line bg-bg text-fg-dim hover:text-fg hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
            >
              −
            </button>
            <button
              onClick={() => update({ fontSize: TERMINAL_FONT_DEFAULT })}
              className="flex-1 py-1 rounded border border-line bg-bg text-[11px] text-fg-dim hover:text-fg hover:border-fg-faint"
            >
              reset
            </button>
            <button
              onClick={() => bumpFont(1)}
              disabled={settings.fontSize >= TERMINAL_FONT_MAX}
              aria-label="Increase font size"
              className="flex-1 py-1 rounded border border-line bg-bg text-fg-dim hover:text-fg hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
            >
              +
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Gear() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4 12H1M23 12h-3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  )
}

function ThemeSwatch({ theme }: { theme: TerminalThemeName }) {
  const palette = TERMINAL_THEMES[theme]
  return (
    <div
      aria-hidden
      className="w-full h-3.5 rounded border"
      style={{
        background: palette.background,
        borderColor: 'rgba(0,0,0,0.15)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', top: 2, left: 3, width: '40%', height: 1.5, background: palette.foreground }} />
      <div style={{ position: 'absolute', top: 6, left: 3, width: '25%', height: 1.5, background: palette.green ?? palette.foreground }} />
      <div style={{ position: 'absolute', top: 10, left: 3, width: '55%', height: 1.5, background: palette.cyan ?? palette.foreground }} />
    </div>
  )
}
