/**
 * Cmd/Ctrl+F find-in-page bar (PRD 402). Rendered as a chrome sibling above
 * the webview-column placeholder — the native WebContentsView sits above
 * this DOM (see Browser.tsx), so it can't be a floating overlay; it pushes
 * the column down instead, same trick as the record-mode banner.
 */
import { useEffect, useRef } from 'react'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { useBrowserState, type BrowserTab } from '../../../state/browser'

export function FindBar({ tab }: { tab: BrowserTab }) {
  const findText = useBrowserState((s) => s.findText)
  const findMatches = useBrowserState((s) => s.findMatches)
  const setFindText = useBrowserState((s) => s.setFindText)
  const findNext = useBrowserState((s) => s.findNext)
  const findPrev = useBrowserState((s) => s.findPrev)
  const closeFind = useBrowserState((s) => s.closeFind)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-line bg-bg-elev px-3.5 py-1.5 font-sans text-[12.5px]">
      <span className="inline-flex text-fg-faint">
        <AlmanacIcon name="search" size={14} />
      </span>
      <input
        ref={inputRef}
        value={findText}
        onChange={(e) => setFindText(tab.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) findPrev(tab.id)
            else findNext(tab.id)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            closeFind(tab.id)
          }
        }}
        placeholder="Find in page"
        className="w-56 bg-transparent text-fg outline-none"
        spellCheck={false}
      />
      <span className="min-w-[3.5em] text-fg-faint">
        {findText ? `${findMatches?.matches ? findMatches.activeMatchOrdinal : 0}/${findMatches?.matches ?? 0}` : ''}
      </span>
      <button
        type="button"
        title="Previous match"
        disabled={!findText}
        onClick={() => findPrev(tab.id)}
        className="ml-auto grid h-6 w-6 place-items-center rounded text-fg-dim hover:text-fg disabled:cursor-default disabled:text-rule"
      >
        <AlmanacIcon name="chevron" size={13} className="rotate-180" />
      </button>
      <button
        type="button"
        title="Next match"
        disabled={!findText}
        onClick={() => findNext(tab.id)}
        className="grid h-6 w-6 place-items-center rounded text-fg-dim hover:text-fg disabled:cursor-default disabled:text-rule"
      >
        <AlmanacIcon name="chevron" size={13} />
      </button>
      <button
        type="button"
        title="Close (Esc)"
        onClick={() => closeFind(tab.id)}
        className="grid h-6 w-6 place-items-center rounded text-fg-dim hover:text-fg"
      >
        <AlmanacIcon name="x" size={13} />
      </button>
    </div>
  )
}
