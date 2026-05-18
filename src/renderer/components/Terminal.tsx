import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useSessions } from '../state/sessions'
import { toast } from '../state/toast'

interface Props {
  tabId: string
  cwd: string
}

// Main-side zod cap is 64 KiB; 60 KiB leaves headroom for IPC envelope overhead.
const PTY_WRITE_CHUNK_SIZE = 60 * 1024
function writeInChunks(tabId: string, data: string) {
  for (let i = 0; i < data.length; i += PTY_WRITE_CHUNK_SIZE) {
    window.api.pty.write({ tabId, data: data.slice(i, i + PTY_WRITE_CHUNK_SIZE) })
  }
}

export function Terminal({ tabId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const spawnedRef = useRef(false)

  useEffect(() => {
    console.log('[Terminal] mount effect running, tabId=', tabId, 'cwd=', cwd, 'alreadySpawned=', spawnedRef.current)
    if (!hostRef.current || spawnedRef.current) return
    spawnedRef.current = true

    const term = new XTerm({
      fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
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
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(hostRef.current)
    fit.fit()
    term.focus()

    // Ctrl+Shift+C copies selection.
    // Ctrl+V / Ctrl+Shift+V both paste: image first (saved to a temp PNG and
    // typed in as a path so claude can read it), text otherwise.
    // Returning false stops xterm from forwarding the keystroke to the PTY.
    // Alt+drag selects text even when the running program (e.g. claude) has
    // mouse tracking enabled — that's an xterm built-in, no wiring needed.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {})
          return false
        }
      }
      const isPaste = e.ctrlKey && (e.key === 'v' || e.key === 'V')
      if (isPaste) {
        ;(async () => {
          try {
            const img = await window.api.clipboard.pasteImage()
            if (img.ok) {
              writeInChunks(tabId, img.path + ' ')
              toast.info(`Pasted image: ${img.path.split('/').pop()}`)
              return
            }
            const text = await navigator.clipboard.readText()
            if (text) writeInChunks(tabId, text)
          } catch {
            /* clipboard unavailable — ignore */
          }
        })()
        return false
      }
      return true
    })
    xtermRef.current = term
    fitRef.current = fit

    const { cols, rows } = term
    const offData = window.api.pty.onData(tabId, (data) => term.write(data))
    const offExit = window.api.pty.onExit(tabId, ({ exitCode }) => {
      term.write(`\r\n\x1b[38;5;240m[session exited code=${exitCode}]\x1b[0m\r\n`)
      useSessions.getState().setTabExited(tabId, exitCode)
    })

    term.onData((data) => writeInChunks(tabId, data))
    term.onResize(({ cols, rows }) => window.api.pty.resize({ tabId, cols, rows }))

    console.log('[Terminal] calling pty.spawn', { tabId, cwd, cols, rows })
    window.api.pty
      .spawn({ tabId, cwd, cols, rows })
      .then(({ pid, reattached }) => {
        console.log('[Terminal] pty.spawn resolved, pid=', pid, 'tabId=', tabId, 'reattached=', reattached)
        useSessions.getState().setTabRunning(tabId, pid)
        // Auto-run the per-tab startup command in the fresh shell. Presets that
        // embed --session-id pin the transcript UUID to this tab so live tabs
        // can map deterministically. The shell buffers input so writing ahead
        // of the first prompt is safe. startupCommand=null means "bare shell".
        // Skip on reattach: the shell + claude are already running from the
        // previous renderer-load, so re-writing the startup command would
        // type it as input into the live claude session.
        if (reattached) return
        const { startupCommand } = useSessions.getState().tabs.find((t) => t.id === tabId) ?? {}
        if (startupCommand) {
          setTimeout(() => {
            writeInChunks(tabId, `${startupCommand}\n`)
          }, 350)
        }
      })
      .catch((err) => {
        console.error('[Terminal] pty.spawn rejected for tabId=', tabId, err)
        term.write(`\r\n\x1b[31mfailed to spawn: ${err.message}\x1b[0m\r\n`)
        toast.error(`Terminal failed to start: ${err.message ?? 'spawn failed'}`)
        useSessions.getState().setTabExited(tabId, -1)
      })

    const onWinResize = () => fit.fit()
    window.addEventListener('resize', onWinResize)

    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(hostRef.current)

    return () => {
      window.removeEventListener('resize', onWinResize)
      ro.disconnect()
      offData()
      offExit()
      term.dispose()
    }
  }, [tabId, cwd])

  return (
    <div
      ref={hostRef}
      onMouseDown={() => xtermRef.current?.focus()}
      className="h-full w-full bg-bg"
    />
  )
}
