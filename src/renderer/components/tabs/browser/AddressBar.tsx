/**
 * Browser address bar — back/forward/reload, a security-tinted lock glyph,
 * an editable URL field, and right-side zoom/devtools/settings stubs. Ported
 * from `docs/design/browser-tab.design.jsx` `AddressBar`, including the
 * PICKING banner (capture mode) and the "observed" chip (observe mode). The
 * actual element-picking behavior behind the banner is PRD 403.
 */
import { useEffect, useState } from 'react'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { useBrowserState, type BrowserTab } from '../../../state/browser'
import { IconBtn } from './browser-primitives'

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

export function AddressBar({ tab }: { tab: BrowserTab }) {
  const navigate = useBrowserState((s) => s.navigate)
  const back = useBrowserState((s) => s.back)
  const forward = useBrowserState((s) => s.forward)
  const reload = useBrowserState((s) => s.reload)
  const mode = useBrowserState((s) => s.mode)
  const setMode = useBrowserState((s) => s.setMode)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(stripScheme(tab.url))

  useEffect(() => {
    if (!editing) setDraft(stripScheme(tab.url))
  }, [tab.url, editing])

  useEffect(() => {
    if (mode !== 'capture') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode('browse')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode, setMode])

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed) navigate(tab.id, trimmed)
  }

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-line bg-bg px-3.5 py-2">
      <IconBtn name="arrowleft" title="Back" disabled={!tab.canGoBack} onClick={() => back(tab.id)} />
      <IconBtn name="arrowright" title="Forward" disabled={!tab.canGoForward} onClick={() => forward(tab.id)} />
      <IconBtn name="reload" title="Reload" onClick={() => reload(tab.id)} />
      <div className="w-1.5" />
      {mode === 'capture' ? (
        <div className="flex h-[34px] flex-1 items-center gap-2.5 rounded-lg border border-accent-muted bg-accent-muted/30 px-3 font-sans text-[13px] font-semibold text-accent">
          <span className="inline-flex animate-pulse text-accent">
            <AlmanacIcon name="target" size={15} />
          </span>
          PICKING — hover to highlight, click to select · ⌘-click for multi
          <button
            type="button"
            onClick={() => setMode('browse')}
            className="ml-auto rounded-md border border-accent-muted bg-bg px-2.5 py-0.5 font-mono text-[11px] font-semibold text-accent"
          >
            Esc
          </button>
        </div>
      ) : (
        <div className="flex h-[34px] flex-1 items-center gap-2 rounded-lg border border-line bg-bg-hi px-3 font-mono text-[13px] text-fg">
          <span className={`inline-flex ${tab.isSecure ? 'text-sage' : 'text-fg-faint'}`}>
            <AlmanacIcon name="lock" size={13} />
          </span>
          <span className="text-fg-faint">https://</span>
          <input
            value={editing ? draft : stripScheme(tab.url)}
            onFocus={() => setEditing(true)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              else if (e.key === 'Escape') {
                setDraft(stripScheme(tab.url))
                setEditing(false)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            className="flex-1 bg-transparent outline-none"
            spellCheck={false}
          />
          {mode === 'observe' && (
            <span className="ml-auto inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-accent">
              <span className="inline-flex animate-pulse">
                <AlmanacIcon name="eye" size={13} />
              </span>
              observed
            </span>
          )}
        </div>
      )}
      <div className="w-1.5" />
      <IconBtn name="usage" title="Zoom / find" />
      <IconBtn name="terminal" title="DevTools" />
      <IconBtn name="settings" title="Page settings" />
    </div>
  )
}
