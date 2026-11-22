/**
 * DocOutline — Google-Docs-style document outline for markdown. Lists headings
 * (indented by level) parsed from the live buffer; clicking scrolls the linked
 * rendered container to the matching heading.
 *
 * The rendered view is a sibling div (not an iframe), so we scroll by finding
 * the heading inside the container handed in via `scrollRef` and scrolling only
 * the nearest scroller inside it (scrollWithin), never its ancestors. The
 * heading is found by its slug anchor id (MarkdownPreview) or, when the surface
 * emits no ids (the Tiptap Document view), by its position among h1–h6.
 *
 * `onJump` replaces the DOM scroll entirely — the Markdown (Monaco) view uses it
 * to reveal the heading's source line. `showStats` adds the design's
 * `THIS FILE  N lines · N words · ~N tokens in context` footer.
 */

import { useMemo } from 'react'
import { extractHeadings, type Heading } from './MarkdownPreview'
import { scrollWithin } from '../../../lib/scrollWithin'
import { countWords, estimateTokens } from './EditorStatusBar'

interface Props {
  text: string
  scrollRef: React.RefObject<HTMLDivElement>
  /** Override the jump: receives the heading and its index in document order. */
  onJump?: (heading: Heading, index: number) => void
  /** Render the THIS FILE metrics footer. */
  showStats?: boolean
}

/** Nearest ancestor of `el` (up to and including `root`) that actually scrolls. */
function scrollerFor(el: HTMLElement, root: HTMLElement): HTMLElement {
  for (let n: HTMLElement | null = el.parentElement; n && n !== root; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return root
}

function FileStats({ text }: { text: string }) {
  const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
  return (
    <div className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-fg-dim" data-testid="doc-outline-stats">
      <div className="text-[10px] uppercase tracking-wide text-fg-faint mb-1">This file</div>
      <div>{lines.toLocaleString()} lines · {countWords(text).toLocaleString()} words</div>
      <div>~{estimateTokens(text).toLocaleString()} tokens in context</div>
    </div>
  )
}

export function DocOutline({ text, scrollRef, onJump, showStats }: Props) {
  const headings = useMemo(() => extractHeadings(text), [text])

  if (headings.length === 0) {
    return (
      <div className="w-56 shrink-0 border-r border-line bg-bg-elev flex flex-col" data-testid="doc-outline">
        <div className="flex-1 p-3 text-[11px] text-fg-faint">No headings in this file.</div>
        {showStats && <FileStats text={text} />}
      </div>
    )
  }

  const go = (h: Heading, index: number) => {
    if (onJump) { onJump(h, index); return }
    const root = scrollRef.current
    if (!root) return
    const el =
      root.querySelector<HTMLElement>(`#${CSS.escape(h.slug)}`) ??
      root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')[index] ??
      null
    if (!el) return
    // Scroll ONLY the rendered view's scroller — never the editor frame above it.
    // offset 16 = the headings' scroll-margin-top (1rem) landing spot.
    scrollWithin(scrollerFor(el, root), el, { block: 'start', behavior: 'smooth', offset: 16 })
  }

  const minLevel = Math.min(...headings.map((h) => h.level))

  return (
    <div className="w-56 shrink-0 border-r border-line bg-bg-elev flex flex-col min-h-0" data-testid="doc-outline">
      <div className="flex-1 min-h-0 overflow-auto overscroll-contain">
        <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-fg-faint border-b border-line">Outline</div>
        <nav className="py-1">
          {headings.map((h, i) => (
            <button
              key={i}
              onClick={() => go(h, i)}
              className={`block w-full text-left px-3 py-1 text-[11px] hover:text-fg hover:bg-bg-hi truncate ${h.level === minLevel ? 'text-fg font-medium' : 'text-fg-dim'}`}
              style={{ paddingLeft: `${0.75 + (h.level - minLevel) * 0.75}rem` }}
              title={h.text}
            >
              {h.text}
            </button>
          ))}
        </nav>
      </div>
      {showStats && <FileStats text={text} />}
    </div>
  )
}
