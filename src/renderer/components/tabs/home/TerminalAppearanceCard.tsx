/**
 * TerminalAppearanceCard — the one editor for the app-wide terminal theme +
 * font size (`lib/terminalSettings.ts`).
 *
 * It lives on Home because that is where machine-wide state belongs. It used
 * to be a gear popover floating in the top-right of the Terminal pane, which
 * made a preference shared by every xterm in the app look like a property of
 * whichever session you happened to be looking at. The card states its own
 * reach in the copy rather than leaving the user to discover it by switching
 * tabs and finding the theme followed them.
 */

import { useState } from 'react'
import {
  TERMINAL_THEMES,
  TERMINAL_FONT_MIN,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_DEFAULT,
  loadTerminalSettings,
  saveTerminalSettings,
  type TerminalSettings,
  type TerminalThemeName,
} from '../../../lib/terminalSettings'

const THEME_ORDER: TerminalThemeName[] = ['dark', 'light', 'paper']

export function TerminalAppearanceCard() {
  const [settings, setSettings] = useState<TerminalSettings>(() => loadTerminalSettings())

  const update = (patch: Partial<TerminalSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveTerminalSettings(next)
      return next
    })
  }

  const bumpFont = (delta: number) => {
    update({ fontSize: Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, settings.fontSize + delta)) })
  }

  return (
    <section className="mb-6" data-testid="home-terminal-appearance">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 font-serif text-[22px] font-medium">Terminal appearance</h2>
        <span className="font-mono text-[12px] text-fg-faint">every terminal, this machine</span>
      </div>

      <div className="border border-line rounded-xl bg-bg-hi px-5 py-4">
        <p className="mt-0 mb-4 text-[13px] text-fg-dim leading-relaxed">
          Applies to <strong className="text-fg">every terminal in the app at once</strong> — project
          Terminal tabs, an Epic&rsquo;s Terminal view of its session, and the inline permission
          prompt. It is not per project, per session, or per tab. It does not restyle the app
          chrome (there is no app theme switch), and the code editor keeps its own separate
          paper/dark setting in the Editor tab&rsquo;s Display menu. Stored in this machine&rsquo;s
          browser storage as <code className="font-mono text-[12px]">sm.terminal.settings</code>,
          applied live without restarting a session.
        </p>

        <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0,1fr) 220px' }}>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-faint mb-1.5">Theme</div>
            <div className="grid grid-cols-3 gap-2">
              {THEME_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => update({ theme: t })}
                  aria-pressed={settings.theme === t}
                  data-testid={`terminal-theme-${t}`}
                  className={`px-2 py-2 rounded-lg text-[11px] font-medium border transition-colors ${
                    settings.theme === t
                      ? 'bg-bg border-accent text-fg'
                      : 'bg-bg border-line text-fg-dim hover:text-fg hover:border-fg-faint'
                  }`}
                >
                  <ThemeSwatch theme={t} />
                  <div className="mt-1.5 capitalize">{t}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-fg-faint">Font size</span>
              <span className="font-mono text-[11px] text-fg-dim">{settings.fontSize}px</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => bumpFont(-1)}
                disabled={settings.fontSize <= TERMINAL_FONT_MIN}
                aria-label="Decrease font size"
                className="flex-1 py-1.5 rounded border border-line bg-bg text-fg-dim hover:text-fg hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => update({ fontSize: TERMINAL_FONT_DEFAULT })}
                className="flex-1 py-1.5 rounded border border-line bg-bg text-[11px] text-fg-dim hover:text-fg hover:border-fg-faint"
              >
                reset
              </button>
              <button
                type="button"
                onClick={() => bumpFont(1)}
                disabled={settings.fontSize >= TERMINAL_FONT_MAX}
                aria-label="Increase font size"
                className="flex-1 py-1.5 rounded border border-line bg-bg text-fg-dim hover:text-fg hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
              >
                +
              </button>
            </div>
            <div
              className="mt-3 rounded border border-line px-3 py-2 font-mono"
              style={{
                background: TERMINAL_THEMES[settings.theme].background,
                color: TERMINAL_THEMES[settings.theme].foreground,
                fontSize: `${settings.fontSize}px`,
                lineHeight: 1.35,
              }}
              aria-hidden
            >
              <span style={{ color: TERMINAL_THEMES[settings.theme].green }}>$</span> claude
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ThemeSwatch({ theme }: { theme: TerminalThemeName }) {
  const palette = TERMINAL_THEMES[theme]
  return (
    <div
      aria-hidden
      className="w-full h-5 rounded border relative overflow-hidden"
      style={{ background: palette.background, borderColor: 'rgba(0,0,0,0.15)' }}
    >
      <div style={{ position: 'absolute', top: 3, left: 4, width: '40%', height: 2, background: palette.foreground }} />
      <div style={{ position: 'absolute', top: 9, left: 4, width: '25%', height: 2, background: palette.green ?? palette.foreground }} />
      <div style={{ position: 'absolute', top: 15, left: 4, width: '55%', height: 2, background: palette.cyan ?? palette.foreground }} />
    </div>
  )
}
