import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_TERMINAL_SETTINGS, TERMINAL_THEMES } from '../../lib/terminalSettings'
import { canFit } from '../../lib/terminalFit'
import { useToast } from '../../state/toast'
import { Badge } from '../ui/Badge'
import { PillButton, SectionLabel } from './remoteUi'

interface Props {
  peerId: string
  machineName: string
  cwd: string
  onClose: () => void
}

const HEIGHT_PX = 260

/**
 * xterm whose pty runs on a paired remote Session Manager, driven over
 * window.api.remoteClient (cmd:pty:* out, event:pty:* in). Not a TAB/Epic.
 */
export function RemoteTerminalPanel({ peerId, machineName, cwd, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const killRef = useRef<(() => void) | null>(null)
  const showToast = useToast((s) => s.show)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const tabId = crypto.randomUUID()
    let alive = true
    let exitedNow = false
    let killed = false

    const fail = (what: string, err: unknown) => {
      if (!alive) return
      showToast('error', `Remote terminal ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const send = (type: string, payload: unknown) =>
      window.api.remoteClient.send(peerId, type, payload)

    const term = new XTerm({
      fontFamily: '"IBM Plex Mono", JetBrains Mono, ui-monospace, Menlo, monospace',
      fontSize: DEFAULT_TERMINAL_SETTINGS.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: TERMINAL_THEMES[DEFAULT_TERMINAL_SETTINGS.theme],
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const guardedFit = () => {
      if (!canFit(host.clientWidth, host.clientHeight)) return
      try { fit.fit() } catch { /* ignore */ }
    }
    term.open(host)
    guardedFit()
    term.focus()

    const offEvent = window.api.remoteClient.onEvent((ev) => {
      if (ev.peerId !== peerId) return
      const p = (ev.payload ?? {}) as { tabId?: string; data?: string; exitCode?: number }
      if (p.tabId !== tabId) return
      if (ev.type === 'event:pty:data') {
        if (typeof p.data === 'string') term.write(p.data)
      } else if (ev.type === 'event:pty:exit') {
        exitedNow = true
        term.options.disableStdin = true
        term.write(`\r\n\x1b[38;5;240m[remote session exited code=${p.exitCode ?? '?'}]\x1b[0m\r\n`)
        setExited(true)
      }
    })

    const dData = term.onData((data) => {
      if (exitedNow) return
      send('cmd:pty:write', { tabId, data }).catch((e) => fail('write', e))
    })
    const dResize = term.onResize(({ cols, rows }) => {
      if (exitedNow) return
      send('cmd:pty:resize', { tabId, cols, rows }).catch((e) => fail('resize', e))
    })

    send('cmd:pty:spawn', { tabId, cwd, cols: term.cols, rows: term.rows })
      .catch((e) => fail('spawn', e))

    killRef.current = () => {
      if (killed) return
      killed = true
      send('cmd:pty:kill', { tabId }).catch((e) => fail('kill', e))
    }

    const onWinResize = () => guardedFit()
    window.addEventListener('resize', onWinResize)
    const ro = new ResizeObserver(() => guardedFit())
    ro.observe(host)

    return () => {
      window.removeEventListener('resize', onWinResize)
      ro.disconnect()
      offEvent()
      dData.dispose()
      dResize.dispose()
      killRef.current?.()
      killRef.current = null
      alive = false
      term.dispose()
    }
  }, [peerId, cwd, showToast])

  const handleClose = () => {
    killRef.current?.()
    onClose()
  }

  return (
    <div data-testid="remote-terminal-panel" className="bg-bg-hi border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-[18px] pt-3.5 pb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <SectionLabel>Remote terminal</SectionLabel>
          <Badge tone="accent"><span data-testid="remote-terminal-badge">Remote: {machineName}</span></Badge>
          {exited && <Badge tone="dim">exited</Badge>}
        </div>
        <PillButton kind="ghost" onClick={handleClose} testId="remote-terminal-close">Close</PillButton>
      </div>
      <div
        ref={hostRef}
        data-testid="remote-terminal-host"
        className="w-full bg-bg"
        style={{ height: HEIGHT_PX }}
      />
    </div>
  )
}
