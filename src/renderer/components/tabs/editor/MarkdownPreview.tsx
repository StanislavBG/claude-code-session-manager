/**
 * MarkdownPreview — renders the live buffer as sanitized HTML.
 *
 * marked (GFM) → DOMPurify → prose container. No iframe, no scripts: a
 * `<script>` or `onerror=` in the markdown is stripped by DOMPurify before it
 * ever reaches the DOM. http(s) links open in the OS browser; in-page anchors
 * are left alone.
 */

import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

interface Props {
  text: string
}

function render(src: string): string {
  const raw = marked.parse(src, { async: false }) as string
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] })
}

export function MarkdownPreview({ text }: Props) {
  const html = useMemo(() => render(text), [text])

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault()
      window.api.app.openExternal(href).catch(() => { /* ignore */ })
    }
    // in-page (#anchor) and relative links fall through harmlessly.
  }

  return (
    <div className="h-full overflow-auto">
      <div
        className="markdown-body p-6 prose prose-invert max-w-3xl mx-auto text-fg text-sm leading-relaxed"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
