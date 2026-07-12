/**
 * Browser address bar — back/forward/reload, a security-tinted lock glyph,
 * an editable URL field with history autocomplete, a bookmark star +
 * bookmarks menu, and a zoom/find popover. Ported from
 * `docs/design/browser-tab.design.jsx` `AddressBar`, including the PICKING
 * banner (capture mode) and the "observed" chip (observe mode). The actual
 * element-picking behavior behind the banner is PRD 403.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { useBrowserState, type BrowserTab } from '../../../state/browser'
import { IconBtn } from './browser-primitives'

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

const MAX_SUGGESTIONS = 6

export function AddressBar({ tab }: { tab: BrowserTab }) {
  const navigate = useBrowserState((s) => s.navigate)
  const back = useBrowserState((s) => s.back)
  const forward = useBrowserState((s) => s.forward)
  const reload = useBrowserState((s) => s.reload)
  const mode = useBrowserState((s) => s.mode)
  const setMode = useBrowserState((s) => s.setMode)

  const bookmarks = useBrowserState((s) => s.bookmarks)
  const hydrateBookmarks = useBrowserState((s) => s.hydrateBookmarks)
  const toggleBookmark = useBrowserState((s) => s.toggleBookmark)

  const historyEntries = useBrowserState((s) => s.historyEntries)
  const refreshHistory = useBrowserState((s) => s.refreshHistory)

  const openFind = useBrowserState((s) => s.openFind)
  const zoomIn = useBrowserState((s) => s.zoomIn)
  const zoomOut = useBrowserState((s) => s.zoomOut)
  const zoomReset = useBrowserState((s) => s.zoomReset)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(stripScheme(tab.url))
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(stripScheme(tab.url))
  }, [tab.url, editing])

  useEffect(() => {
    hydrateBookmarks()
  }, [hydrateBookmarks])

  useEffect(() => {
    if (editing) refreshHistory()
  }, [editing, refreshHistory])

  useEffect(() => {
    if (mode !== 'capture') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode('browse')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode, setMode])

  const isBookmarked = bookmarks.some((b) => b.url === tab.url)

  const suggestions = useMemo(() => {
    if (!editing) return []
    const q = draft.trim().toLowerCase()
    const seen = new Set<string>()
    const out: { url: string; title: string }[] = []
    // Prefix match over the most recent 200 entries — no ranking engine.
    // historyEntries is already most-recent-first (main process unshifts on visit),
    // so an empty query just takes the first MAX_SUGGESTIONS distinct entries.
    for (const h of historyEntries.slice(0, 200)) {
      if (seen.has(h.url)) continue
      const matches = !q || stripScheme(h.url).toLowerCase().startsWith(q) || h.title.toLowerCase().startsWith(q)
      if (!matches) continue
      seen.add(h.url)
      out.push({ url: h.url, title: h.title })
      if (out.length >= MAX_SUGGESTIONS) break
    }
    return out
  }, [draft, editing, historyEntries])

  const dropdownOpen = (editing && suggestions.length > 0) || bookmarksOpen

  useEffect(() => {
    const viewId = tab.viewId
    if (!viewId) return
    if (dropdownOpen) {
      window.api.browser.hide(viewId).catch(() => {})
    } else {
      window.api.browser.show(viewId).catch(() => {})
    }
    return () => {
      if (dropdownOpen && viewId) window.api.browser.show(viewId).catch(() => {})
    }
  }, [dropdownOpen, tab.viewId])

  const commit = (url?: string) => {
    setEditing(false)
    const trimmed = (url ?? draft).trim()
    if (trimmed) navigate(tab.id, trimmed)
  }

  const zoomPct = Math.round(tab.zoomFactor * 100)

  return (
    <div className="relative flex flex-shrink-0 items-center gap-1.5 border-b border-line bg-bg px-3.5 py-2">
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
        <div className="relative flex-1">
          <div className="flex h-[34px] items-center gap-2 rounded-lg border border-line bg-bg-hi px-3 font-mono text-[13px] text-fg">
            <span className={`inline-flex ${tab.isSecure ? 'text-sage' : 'text-fg-faint'}`}>
              <AlmanacIcon name="lock" size={13} />
            </span>
            <span className="text-fg-faint">https://</span>
            <input
              value={editing ? draft : stripScheme(tab.url)}
              onFocus={() => setEditing(true)}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => window.setTimeout(() => setEditing(false), 120)}
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
            <button
              type="button"
              title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
              onClick={() => toggleBookmark(tab.id)}
              className={`inline-flex ${isBookmarked ? 'text-butter' : 'text-fg-faint hover:text-fg'}`}
            >
              <AlmanacIcon name="star" size={14} />
            </button>
            {mode === 'observe' && (
              <span className="inline-flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-accent">
                <span className="inline-flex animate-pulse">
                  <AlmanacIcon name="eye" size={13} />
                </span>
                observed
              </span>
            )}
          </div>
          {editing && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-[38px] z-10 overflow-hidden rounded-lg border border-line bg-bg-elev font-sans text-[12.5px] shadow-lg">
              {suggestions.map((s) => (
                <li key={s.url}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      commit(s.url)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-dim hover:bg-bg-hi hover:text-fg"
                  >
                    <AlmanacIcon name="history" size={12} className="flex-shrink-0 text-fg-faint" />
                    <span className="truncate">{s.title || stripScheme(s.url)}</span>
                    <span className="ml-auto flex-shrink-0 truncate text-[11px] text-fg-faint">{stripScheme(s.url)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="w-1.5" />
      <div className="relative">
        <IconBtn name="book" title="Bookmarks" active={bookmarksOpen} onClick={() => setBookmarksOpen((v) => !v)} />
        {bookmarksOpen && (
          <ul className="absolute right-0 top-[38px] z-10 max-h-72 w-72 overflow-auto rounded-lg border border-line bg-bg-elev font-sans text-[12.5px] shadow-lg">
            {bookmarks.length === 0 && <li className="px-3 py-2 text-fg-faint">No bookmarks yet — click the star to add one.</li>}
            {bookmarks.map((b) => (
              <li key={b.url}>
                <button
                  type="button"
                  onClick={() => {
                    navigate(tab.id, b.url)
                    setBookmarksOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-dim hover:bg-bg-hi hover:text-fg"
                >
                  <AlmanacIcon name="star" size={12} className="flex-shrink-0 text-butter" />
                  <span className="truncate">{b.title || stripScheme(b.url)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="relative">
        <IconBtn name="usage" title="Zoom / find" active={zoomMenuOpen} onClick={() => setZoomMenuOpen((v) => !v)} />
        {zoomMenuOpen && (
          <div className="absolute right-0 top-[38px] z-10 w-48 rounded-lg border border-line bg-bg-elev p-2.5 font-sans text-[12.5px] shadow-lg">
            <div className="mb-2 flex items-center justify-between gap-1.5">
              <IconBtn name="minus" title="Zoom out" size={13} onClick={() => zoomOut(tab.id)} />
              <button
                type="button"
                title="Reset zoom"
                onClick={() => zoomReset(tab.id)}
                className="flex-1 rounded-md border border-line py-1 text-center font-mono text-[12px] text-fg-dim hover:text-fg"
              >
                {zoomPct}%
              </button>
              <IconBtn name="plus" title="Zoom in" size={13} onClick={() => zoomIn(tab.id)} />
            </div>
            <button
              type="button"
              onClick={() => {
                setZoomMenuOpen(false)
                openFind(tab.id)
              }}
              className="flex w-full items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-fg-dim hover:text-fg"
            >
              <AlmanacIcon name="search" size={13} />
              Find in page
              <span className="ml-auto font-mono text-[11px] text-fg-faint">⌘F</span>
            </button>
          </div>
        )}
      </div>
      <IconBtn name="terminal" title="DevTools" />
      <IconBtn name="settings" title="Page settings" />
    </div>
  )
}
