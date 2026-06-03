/**
 * DocOutline — Google-Docs-style document outline for markdown. Lists headings
 * (indented by level) parsed from the live buffer; clicking scrolls the linked
 * preview container to the matching anchor id.
 *
 * The preview is a sibling div (not an iframe), so we scroll by querying the
 * anchor inside the shared scroll container handed in via `scrollRef`.
 */

import { useMemo } from 'react'
import { extractHeadings } from './MarkdownPreview'

interface Props {
  text: string
  scrollRef: React.RefObject<HTMLDivElement>
}

export function DocOutline({ text, scrollRef }: Props) {
  const headings = useMemo(() => extractHeadings(text), [text])

  if (headings.length === 0) {
    return (
      <div className="w-56 shrink-0 border-r border-line bg-bg-elev p-3 text-[11px] text-fg-faint">
        no headings
      </div>
    )
  }

  const go = (slug: string) => {
    const root = scrollRef.current
    if (!root) return
    const el = root.querySelector(`#${CSS.escape(slug)}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const minLevel = Math.min(...headings.map((h) => h.level))

  return (
    <div className="w-56 shrink-0 border-r border-line bg-bg-elev overflow-auto">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-fg-faint border-b border-line">Outline</div>
      <nav className="py-1">
        {headings.map((h, i) => (
          <button
            key={i}
            onClick={() => go(h.slug)}
            className="block w-full text-left px-3 py-1 text-[11px] text-fg-dim hover:text-fg hover:bg-bg-hi truncate"
            style={{ paddingLeft: `${0.75 + (h.level - minLevel) * 0.75}rem` }}
            title={h.text}
          >
            {h.text}
          </button>
        ))}
      </nav>
    </div>
  )
}
