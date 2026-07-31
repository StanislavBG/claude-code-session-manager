import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm, type ILinkProvider, type IBufferRange } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useSessions } from '../state/sessions'
import { useEditor } from '../state/editor'
import { toast } from '../state/toast'
import { loadTerminalSettings, onTerminalSettingsChange, TERMINAL_THEMES } from './TerminalControls'
import { TerminalChat } from './TerminalChat'
import { fetchTerminalDigest } from '../lib/terminalDigest'
import { PasteThumbnail } from './PasteThumbnail'
import { canFit } from '../lib/terminalFit'
import { WORKBENCH_REFIT_EVENT } from '../lib/workbenchRefit'

// Matches plausible source-path tokens: optional ./ or ../ prefix, dotted name
// with extension, optional :line[:col] suffix. Word-boundary on the front
// stops `package.json` mid-sentence being captured with leading word chars.
// Examples that should match:
//   src/main/index.cjs       src/main/index.cjs:633        ./foo.ts:42:8
// Examples that should NOT match:
//   www.example.com (no extension after final dot is rejected by \.[A-Za-z]\w+)
const FILE_LINK_RE = /(?:^|[\s(])((?:\.{1,2}\/)?[\w./-]+\.[A-Za-z]\w*(?::(\d+))?(?::(\d+))?)/g

interface Props {
  tabId: string
  cwd: string
}

// Main-side zod cap is 64 KiB; 60 KiB leaves headroom for IPC envelope overhead.
// Exported so EpicTerminalPane.tsx (the Epic Terminal-mode PTY, PRD 831)
// reuses the same chunking instead of forking a second copy.
export const PTY_WRITE_CHUNK_SIZE = 60 * 1024
export function writeInChunks(tabId: string, data: string) {
  for (let i = 0; i < data.length; i += PTY_WRITE_CHUNK_SIZE) {
    window.api.pty.write({ tabId, data: data.slice(i, i + PTY_WRITE_CHUNK_SIZE) })
  }
}

export function Terminal({ tabId, cwd }: Props) {
  const isDormant = useSessions((s) => s.tabs.find((t) => t.id === tabId)?.status === 'dormant')
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const spawnedRef = useRef(false)
  const [pastedImage, setPastedImage] = useState<string | null>(null)

  useEffect(() => {
    console.log('[Terminal] mount effect running, tabId=', tabId, 'cwd=', cwd, 'alreadySpawned=', spawnedRef.current)
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

    // Live theme + font updates from the TerminalControls popover. xterm v5
    // accepts assignment to `term.options.*` without remount, but font size
    // changes need a refit so the existing rows reflow.
    const offSettings = onTerminalSettingsChange((s) => {
      term.options.theme = TERMINAL_THEMES[s.theme]
      term.options.fontSize = s.fontSize
      guardedFit()
    })
    // WebLinksAddon with an explicit handler: by default the addon underlines
    // URLs but the click hits the xterm <div> and dies (setWindowOpenHandler
    // only fires on window.open()). Routing through the new app:open-external
    // IPC opens the URL in the OS default browser via shell.openExternal,
    // with main-side filter rejecting non-http(s) schemes.
    term.loadAddon(new WebLinksAddon((_event, url) => {
      window.api.shell.open({ as: 'external', url }).catch(() => {
        toast.error(`Couldn't open URL: ${url}`)
      })
    }))
    // Custom link provider for file paths like src/foo.ts:42:8 — opens in
    // the user's editor at the right line. Resolves relative paths against
    // the tab's cwd in the main process via fs.access + validatePath.
    const fileLinkProvider: ILinkProvider = {
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const links: Array<{ range: IBufferRange; text: string; activate: () => void }> = []
        for (const m of line.matchAll(FILE_LINK_RE)) {
          const full = m[0]
          const pathPart = m[1]
          const lineStr = m[2]
          const colStr = m[3]
          // Offset of pathPart within full: full may have one leading whitespace/paren char.
          const xtermStart = (m.index ?? 0) + (full.length - pathPart.length) + 1 // xterm is 1-indexed
          const xtermEnd = xtermStart + pathPart.length - 1
          links.push({
            range: { start: { x: xtermStart, y }, end: { x: xtermEnd, y } },
            text: pathPart,
            activate: () => {
              // Open the file in the IN-APP Editor scene (not an external
              // editor): keeps the user in the cockpit. URLs are handled by the
              // WebLinksAddon above and still open in the OS browser. The line
              // (foo.ts:42) is preserved so the editor reveals it. The
              // 'sm:open-editor' event lets App route to the editor scene since
              // Terminal has no navigate of its own.
              const filePath = pathPart.replace(/(?::\d+)+$/, '')
              const ln = lineStr ? parseInt(lineStr, 10) : undefined
              const col = colStr ? parseInt(colStr, 10) : undefined
              const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
              useEditor.getState().openFile(absPath, { line: ln, col })
              window.dispatchEvent(new CustomEvent('sm:open-editor'))
            },
          })
        }
        callback(links)
      },
    }
    term.registerLinkProvider(fileLinkProvider)
    term.open(hostRef.current)
    guardedFit()
    term.focus()

    // Ctrl+Shift+C copies selection.
    // Ctrl+V / Ctrl+Shift+V both paste: image first (saved to a temp PNG and
    // typed in as a path so claude can read it), text otherwise.
    // Returning false stops xterm from forwarding the keystroke to the PTY.
    // Alt+drag selects text even when the running program (e.g. claude) has
    // mouse tracking enabled — that's an xterm built-in, no wiring needed.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Smart Ctrl-C: if there's a selection, copy + clear it; otherwise fall
      // through to PTY as SIGINT (gnome-terminal / iTerm2 behavior). Reserved
      // shortcut Ctrl-Shift-C below still copies unconditionally.
      if (e.ctrlKey && !e.shiftKey && !e.metaKey && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {})
          term.clearSelection()
          return false
        }
        // No selection — let Ctrl-C reach the PTY (return true below).
      }
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
              setPastedImage(img.path)
              return
            }
            const pasted = await window.api.clipboard.pasteText()
            if (pasted.ok && pasted.text) writeInChunks(tabId, pasted.text)
          } catch {
            /* clipboard unavailable — ignore */
          }
        })()
        return false
      }
      return true
    })
    xtermRef.current = term

    const { cols, rows } = term
    const offData = window.api.pty.onData(tabId, (data) => term.write(data))
    const offExit = window.api.pty.onExit(tabId, ({ exitCode }) => {
      term.write(`\r\n\x1b[38;5;240m[session exited code=${exitCode}]\x1b[0m\r\n`)
      useSessions.getState().setTabExited(tabId, exitCode)
    })

    term.onData((data) => writeInChunks(tabId, data))
    term.onResize(({ cols, rows }) => window.api.pty.resize({ tabId, cols, rows }))

    // Best-effort: write a readable digest of the prior transcript before the
    // pty spawns/reattaches, so a reload doesn't read as data loss even though
    // the live PTY bytes that used to fill this scrollback can't be replayed
    // (see pty.cjs's reattach comment). Never blocks or fails the spawn below.
    fetchTerminalDigest({ tabId, cwd })
      .then((digest) => {
        if (digest) term.write(digest)
      })
      .catch(() => { /* best-effort only */ })
      .finally(() => {
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
            // A caller (e.g. TerminalChat's "Grant consent" button) can queue a
            // one-shot command to auto-type once this PTY is ready — reattach
            // means the session is already live, so it's typed almost
            // immediately; a fresh spawn chains after the startup command with
            // extra margin for the interactive `claude` CLI itself to boot
            // (best-effort timing, same tradeoff already accepted by the
            // startupCommand buffering above).
            const pending = useSessions.getState().consumeRawCommand(tabId)
            if (pending) {
              setTimeout(() => { writeInChunks(tabId, `${pending}\r`) }, reattached ? 150 : 1500)
            }
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
      })

    const onWinResize = () => guardedFit()
    window.addEventListener('resize', onWinResize)

    // Window resize alone misses dockview-driven geometry changes (group
    // resize, split, drop) and the RecordingStatus banner's layout shift —
    // Workbench.tsx dispatches this event for both.
    window.addEventListener(WORKBENCH_REFIT_EVENT, onWinResize)

    const ro = new ResizeObserver(() => guardedFit())
    ro.observe(hostRef.current)

    return () => {
      window.removeEventListener('resize', onWinResize)
      window.removeEventListener(WORKBENCH_REFIT_EVENT, onWinResize)
      ro.disconnect()
      offData()
      offExit()
      offSettings()
      term.dispose()
    }
  }, [tabId, cwd])

  // Dormant tab → chat experience (default). Raw xterm only spawns once the
  // user opens a raw session (wakeTab) — see TerminalChat's "Open raw session".
  if (isDormant) {
    return <TerminalChat tabId={tabId} cwd={cwd} />
  }

  return (
    <div className="relative h-full w-full">
      <button
        type="button"
        onClick={() => useSessions.getState().sleepTab(tabId)}
        title="Kill this session and return to chat"
        className="absolute top-2 right-11 z-20 rounded border border-white/10 bg-bg-elev/80 px-2 py-1 text-xs text-fg-muted backdrop-blur-sm hover:bg-white/5 hover:text-fg"
      >
        ← Back to chat
      </button>
      {pastedImage && (
        <div className="absolute bottom-2 left-2 z-20">
          <PasteThumbnail key={pastedImage} path={pastedImage} onDismiss={() => setPastedImage(null)} />
        </div>
      )}
      <div
        ref={hostRef}
        onMouseDown={() => xtermRef.current?.focus()}
        className="h-full w-full bg-bg"
      />
    </div>
  )
}
