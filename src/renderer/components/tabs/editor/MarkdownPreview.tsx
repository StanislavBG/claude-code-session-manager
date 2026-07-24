/**
 * MarkdownPreview — renders the live buffer as sanitized HTML on a "page".
 *
 * marked (GFM) → DOMPurify → a centered Google-Docs-style page canvas. No
 * iframe, no scripts: a `<script>` or `onerror=` in the markdown is stripped by
 * DOMPurify before it ever reaches the DOM. http(s) links open in the OS
 * browser; in-page anchors are left alone.
 *
 * Headings get stable slug ids so the DocOutline panel can scroll to them.
 * Typography lives in `.markdown-body` in styles.css (mirrors `.tiptap-content`)
 * — the `prose` Tailwind classes are NOT available (no typography plugin).
 */

import { useMemo, useRef, forwardRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { SelectionInfo } from './useDocEdit'

marked.setOptions({ gfm: true, breaks: false })

const MIN_SELECTION_LEN = 3
const MAX_SELECTION_LEN = 8000

interface Props {
  text: string
  /** When true, render flush (no page card) — used inside the split view. */
  flush?: boolean
  /** Widen the page's reading measure ~55% (Display popover → "Wide measure"). */
  wideMeasure?: boolean
  /** Document Experience (PRD 639): a non-collapsed, in-range selection was
   *  released inside `.markdown-body`. Owned by EditorView via useDocEdit —
   *  this component only reports raw selection geometry/text. */
  onSelect?: (info: SelectionInfo) => void
  /** A mouseup happened inside `.markdown-body` with no valid selection
   *  (plain click / collapsed selection) — treated as "dismiss the popover". */
  onDismissSelection?: () => void
}

/** Turn heading text into a URL-safe slug for anchor ids. */
export function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

/** A heading extracted from markdown source, for the outline panel. */
export interface Heading {
  level: number
  text: string
  slug: string
}

/** Parse heading tokens (depth + text) from markdown — O(n) single lex pass. */
export function extractHeadings(src: string): Heading[] {
  const out: Heading[] = []
  const seen = new Map<string, number>()
  try {
    for (const tok of marked.lexer(src)) {
      if (tok.type === 'heading') {
        const base = slugify(tok.text)
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        out.push({ level: tok.depth, text: tok.text, slug: n ? `${base}-${n}` : base })
      }
    }
  } catch { /* malformed markdown — return what we have */ }
  return out
}

function render(src: string): string {
  // Re-derive the same slugs render-side so anchor ids match the outline.
  const seen = new Map<string, number>()
  const renderer = new marked.Renderer()
  renderer.heading = ({ tokens, depth }) => {
    const txt = tokens.map((t) => ('text' in t ? (t as { text: string }).text : '')).join('')
    const base = slugify(txt)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const slug = n ? `${base}-${n}` : base
    const inner = marked.parseInline(txt, { async: false }) as string
    return `<h${depth} id="${slug}">${inner}</h${depth}>\n`
  }
  const raw = marked.parse(src, { async: false, renderer }) as string
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel', 'id'] })
}

export const MarkdownPreview = forwardRef<HTMLDivElement, Props>(function MarkdownPreview(
  { text, flush, wideMeasure, onSelect, onDismissSelection }, ref,
) {
  const html = useMemo(() => render(text), [text])
  const maxW = wideMeasure ? 'max-w-[74rem]' : 'max-w-3xl'
  const bodyRef = useRef<HTMLDivElement>(null)

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault()
      window.api.shell.open({ as: 'external', url: href }).catch(() => { /* ignore */ })
    }
    // in-page (#anchor) and relative links fall through harmlessly.
  }

  const onMouseUp = () => {
    if (!onSelect && !onDismissSelection) return
    const sel = window.getSelection()
    const anchorNode = sel?.anchorNode ?? null
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !anchorNode || !bodyRef.current?.contains(anchorNode)) {
      onDismissSelection?.()
      return
    }
    const text = sel.toString()
    if (text.length < MIN_SELECTION_LEN || text.length > MAX_SELECTION_LEN) {
      onDismissSelection?.()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    onSelect?.({ text, rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right } })
  }

  return (
    <div ref={ref} className="h-full overflow-auto bg-bg" onMouseUp={onMouseUp}>
      <div
        ref={bodyRef}
        className={
          flush
            ? `markdown-body px-6 py-4 mx-auto ${maxW} text-fg text-sm leading-relaxed`
            : `markdown-body mx-auto my-8 ${maxW} bg-bg-hi shadow-md rounded px-14 py-12 text-fg text-sm leading-relaxed`
        }
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
})
