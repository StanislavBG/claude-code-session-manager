/**
 * Terminal appearance — theme + font size for EVERY xterm surface in the app.
 *
 * ## Scope (this is the part that used to be unclear)
 *
 * There is exactly ONE terminal appearance setting, and it is **app-wide on
 * this machine**. It is not per-project, not per-session/Epic, and not per
 * Terminal tab. Changing it repaints every live xterm instance at once:
 *
 *   - `Terminal.tsx`             — the project Terminal tabs
 *   - `epics/EpicTerminalPane`   — an Epic's Terminal view of its session
 *   - `InlineConsentTerminal`    — the inline permission-prompt terminal
 *
 * It also does not reach anything that is *not* an xterm: the app chrome
 * (sidebar/footer/cards) has no theme switch at all, and the code editor has
 * its own separate `paper`/`dark` preference in `state/editorPrefs.ts`
 * (Editor tab → Display popover). Three different things called "theme"; this
 * module owns only the terminal one.
 *
 * ## Where it lives
 *
 * `localStorage['sm.terminal.settings']` — a renderer-only preference, never
 * written to `~/.claude/` and never part of any project's
 * `session-manager-operations/`. Saving broadcasts a `sm:terminal:settings`
 * window event so live xterm instances update in place (xterm v5 supports
 * `term.options.theme = …` without a remount) rather than being torn down.
 *
 * ## Where it is edited
 *
 * The Home tab's "Terminal appearance" card (`tabs/home/TerminalAppearanceCard`)
 * is the only editor. It used to be a floating gear popover pinned inside the
 * Terminal pane, which read as a setting for *that* session — the one thing it
 * has never been. Home is the app-wide face, so a machine-wide preference
 * belongs there; don't re-add a per-pane copy.
 */

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

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  theme: 'dark',
  fontSize: TERMINAL_FONT_DEFAULT,
}

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_TERMINAL_SETTINGS
    const parsed = JSON.parse(raw) as Partial<TerminalSettings>
    return {
      theme: (parsed.theme === 'light' || parsed.theme === 'paper' || parsed.theme === 'dark')
        ? parsed.theme
        : DEFAULT_TERMINAL_SETTINGS.theme,
      fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= TERMINAL_FONT_MIN && parsed.fontSize <= TERMINAL_FONT_MAX
        ? parsed.fontSize
        : DEFAULT_TERMINAL_SETTINGS.fontSize,
    }
  } catch {
    return DEFAULT_TERMINAL_SETTINGS
  }
}

export function saveTerminalSettings(s: TerminalSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch { /* quota / private mode — ignore */ }
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
