import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { loadTerminalSettings, onTerminalSettingsChange, TERMINAL_THEMES } from '../TerminalControls'
import { writeInChunks } from '../Terminal'
import { getRawSessionModel } from '../../lib/rawSessionModel'
import { shellQuote } from '../../lib/presets'
import { canFit } from '../../lib/terminalFit'
import { useEpicTerminal } from '../../state/epicTerminal'
import { toast } from '../../state/toast'

interface Props {
  epicId: string
  cwd: string
  /** The Epic's claudeSessionId — pty.cjs's PtyManager is keyed by an
   *  arbitrary string, so this reuses that same map without a SessionTab. */
  sessionId: string
  onReturnToChat: () => void
}

/**
 * In-pane xterm + PTY for an Epic's Terminal mode (PRD 831). Deliberately NOT
 * a <Terminal tabId cwd> mount: that component is wired to useSessions' tabs
 * array (isDormant/back-to-chat/startupCommand), and TerminalStage only
 * renders EpicsWorkspace when that array is empty — adding an Epic session as
 * a SessionTab would kick the workspace out from under itself. This pane
 * reuses Terminal.tsx's xterm setup (fit/theme/chunked writes) but owns its
 * own independent spawn/dispose lifecycle keyed directly by claudeSessionId.
 */
export function EpicTerminalPane({ epicId, cwd, sessionId, onReturnToChat }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const spawnedRef = useRef(false)
  const [exited, setExited] = useState<{ code: number | null } | null>(null)
  const setAttached = useEpicTerminal((s) => s.setAttached)

  // Attached the instant this pane mounts (before the pty round-trip
  // resolves) so chat.ts's send() guard blocks immediately on mode switch.
  useEffect(() => {
    setAttached(epicId, true)
    return () => setAttached(epicId, false)
  }, [epicId, setAttached])

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
    const offData = window.api.pty.onData(sessionId, (data) => term.write(data))
    const offExit = window.api.pty.onExit(sessionId, ({ exitCode }) => {
      term.write(`\r\n\x1b[38;5;240m[session exited code=${exitCode}]\x1b[0m\r\n`)
      setAttached(epicId, false)
      setExited({ code: exitCode ?? null })
    })
    term.onData((data) => writeInChunks(sessionId, data))
    term.onResize(({ cols, rows }) => window.api.pty.resize({ tabId: sessionId, cols, rows }))

    window.api.pty
      .spawn({ tabId: sessionId, cwd, cols, rows })
      .then(({ reattached }) => {
        const model = getRawSessionModel()
        const cmd = `claude --dangerously-skip-permissions --resume ${shellQuote(sessionId)} --model ${model}\r`
        setTimeout(() => writeInChunks(sessionId, cmd), reattached ? 150 : 1500)
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        term.write(`\r\n\x1b[31mfailed to start terminal: ${msg}\x1b[0m\r\n`)
        toast.error(`Terminal failed to start: ${msg}`)
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
      // Idempotent no-op if the process already exited on its own.
      window.api.pty.kill(sessionId)
    }
  }, [sessionId, cwd, epicId, setAttached])

  if (exited) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-fg-faint"
        data-testid="epic-terminal-exited"
      >
        <p>Terminal session exited{exited.code !== null ? ` (code ${exited.code})` : ''}.</p>
        <button
          type="button"
          onClick={onReturnToChat}
          data-testid="epic-terminal-back-to-chat"
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/90"
        >
          Back to Chat
        </button>
      </div>
    )
  }

  return (
    <div
      ref={hostRef}
      data-testid="epic-terminal-host"
      onMouseDown={() => xtermRef.current?.focus()}
      className="h-full w-full bg-bg"
    />
  )
}
