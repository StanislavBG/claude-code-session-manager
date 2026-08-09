import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { loadTerminalSettings, onTerminalSettingsChange, TERMINAL_THEMES } from '../lib/terminalSettings'
import { writeInChunks } from './Terminal'
import { canFit } from '../lib/terminalFit'
import { transcriptExists } from '../lib/transcriptExists'
import { toast } from '../state/toast'

interface Props {
  sessionId: string
  cwd: string
  /** Slash command (or other line) auto-typed into the ALREADY-RUNNING claude
   *  REPL living in this session's PTY once it's ready — e.g. '/design
   *  consent'. This component never launches claude itself; the caller is
   *  responsible for ensuring a claude REPL is attached to `sessionId`. */
  command: string
  onGranted: () => void
  onClose: () => void
}

// Phrasing distinct from chatRunner.cjs's MCP_CONSENT_DENIAL_MARKERS
// ("hasn't granted this", "run /design consent", "requires consent", ...).
// Best-effort substring heuristic over known CLI success phrasing for the
// interactive `/design consent` confirmation flow.
const CONSENT_GRANTED_MARKERS = [
  'consent granted',
  'access granted',
  "you've granted",
  'you have granted',
  'connected to claude design',
  'successfully connected',
]

export function hasConsentGranted(text: string): boolean {
  if (typeof text !== 'string' || !text) return false
  const lower = text.toLowerCase()
  return CONSENT_GRANTED_MARKERS.some((marker) => lower.includes(marker))
}

const HEIGHT_PX = 220

/**
 * Short-lived inline PTY widget (PRD: inline-consent-terminal, step 1 of 2) —
 * a small xterm mount for granting MCP consent without tearing a chat tab
 * down into a full-screen interactive Terminal (the old wakeTab() path).
 * Reuses the exact PTY spawn/attach plumbing EpicTerminalPane.tsx uses to
 * prove the same PtyManager can be mounted anywhere, just sized small here.
 */
export function InlineConsentTerminal({ sessionId, cwd, command, onGranted, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const spawnedRef = useRef(false)
  const grantedRef = useRef(false)

  useEffect(() => {
    if (!hostRef.current || spawnedRef.current) return
    spawnedRef.current = true

    const initial = loadTerminalSettings()
    const term = new XTerm({
      fontFamily: '"IBM Plex Mono", JetBrains Mono, ui-monospace, Menlo, monospace',
      fontSize: initial.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: TERMINAL_THEMES[initial.theme],
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    const guardedFit = () => {
      const el = hostRef.current
      if (!el || !canFit(el.clientWidth, el.clientHeight)) return
      try { fit.fit() } catch { /* ignore */ }
    }
    const offSettings = onTerminalSettingsChange((s) => {
      term.options.theme = TERMINAL_THEMES[s.theme]
      term.options.fontSize = s.fontSize
      guardedFit()
    })

    term.open(hostRef.current)
    guardedFit()
    term.focus()
    xtermRef.current = term

    const { cols, rows } = term
    const offData = window.api.pty.onData(sessionId, (data) => {
      term.write(data)
      if (!grantedRef.current && hasConsentGranted(data)) {
        grantedRef.current = true
        onGranted()
      }
    })
    const offExit = window.api.pty.onExit(sessionId, ({ exitCode }) => {
      term.write(`\r\n\x1b[38;5;240m[session exited code=${exitCode}]\x1b[0m\r\n`)
    })
    term.onData((data) => writeInChunks(sessionId, data))
    term.onResize(({ cols, rows }) => window.api.pty.resize({ tabId: sessionId, cols, rows }))

    window.api.pty
      .spawn({ tabId: sessionId, cwd, cols, rows })
      .then(async ({ reattached }) => {
        // Reattached to a surviving PTY (renderer reload / remount) — the
        // command may already have been typed once; retyping would inject it
        // again into a live REPL. Same guard as EpicTerminalPane.tsx.
        if (reattached) return
        // No transcript yet means no claude REPL has run in this session at
        // all — there's nothing to send the consent command to.
        const resume = await transcriptExists(cwd, sessionId).catch(() => true)
        if (!resume) return
        setTimeout(() => writeInChunks(sessionId, `${command}\r`), 1500)
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        term.write(`\r\n\x1b[31mfailed to start inline terminal: ${msg}\x1b[0m\r\n`)
        toast.error(`Consent terminal failed to start: ${msg}`)
      })

    const onWinResize = () => guardedFit()
    window.addEventListener('resize', onWinResize)
    const ro = new ResizeObserver(() => guardedFit())
    ro.observe(hostRef.current)

    return () => {
      window.removeEventListener('resize', onWinResize)
      ro.disconnect()
      offData()
      offExit()
      offSettings()
      term.dispose()
      // The PTY is deliberately LEFT RUNNING — closing this widget must not
      // kill the underlying session. A subsequent headless chat resume
      // against the same sessionId needs a clean, fully-exited interactive
      // process, not one this widget SIGTERM'd out from under it.
    }
  }, [sessionId, cwd, command, onGranted])

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-bg-subtle px-2 py-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint">Consent terminal</span>
        <button
          type="button"
          onClick={onClose}
          data-testid="inline-consent-terminal-close"
          className="rounded px-2 py-0.5 text-xs font-semibold text-fg-faint hover:bg-white/10"
        >
          Close
        </button>
      </div>
      <div
        ref={hostRef}
        data-testid="inline-consent-terminal-host"
        onMouseDown={() => xtermRef.current?.focus()}
        className="w-full bg-bg"
        style={{ height: HEIGHT_PX }}
      />
    </div>
  )
}
