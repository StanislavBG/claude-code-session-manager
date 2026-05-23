/**
 * DocumentViewer — read-only preview pane for a single file.
 *
 * MVP: text-based files render in a `<pre>` block with light markdown
 * formatting for `.md`. Image files render via a blob URL (we don't have a
 * `local-file://` protocol handler yet, so images are loaded as base64 via the
 * existing files:read IPC and rendered as a data URL).
 *
 * Deviations from Unleashed's DocumentViewer:
 *   - No PDF support (pdfjs is a heavy dep — left to a future cycle).
 *   - Code rendering is plain `<pre>` (Monaco isn't a fit for read-only and
 *     adding a syntax-highlight lib was out of scope). Sufficient for MVP.
 *   - Markdown is a small inline renderer (no GFM tables, etc.).
 */

import { useEffect, useMemo, useState } from 'react'

interface DocumentViewerProps {
  filePath: string
  onClose: () => void
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])

function getExt(name: string): string {
  return name.toLowerCase().split('.').pop() || ''
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

export function DocumentViewer({ filePath, onClose }: DocumentViewerProps) {
  const [text, setText] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  const ext = useMemo(() => getExt(filePath), [filePath])
  const isImage = IMAGE_EXTS.has(ext)
  const isMarkdown = ext === 'md' || ext === 'mdx' || ext === 'markdown'

  useEffect(() => {
    let cancelled = false
    setError(null)
    setText('')
    setImageUrl(null)
    setLoading(true)

    const load = async () => {
      if (isImage) {
        // Images: rendered via OS file protocol won't load inside the renderer
        // because of our CSP, so we fall back to data URL. SVG is treated as
        // text and rendered directly.
        if (ext === 'svg') {
          const result = await window.api.files.read(filePath)
          if (cancelled) return
          if (!result.ok) setError(result.error ?? 'failed to read')
          else setText(result.text)
          setLoading(false)
          return
        }
        // For raster images, use the file:// URL — Electron's renderer
        // permits file: under our CSP since we set img-src 'self' data: blob:.
        // file: URLs are equivalent to 'self' here. If that's blocked in the
        // future, switch to base64 via a binary-read IPC.
        if (cancelled) return
        setImageUrl(`file://${filePath}`)
        setLoading(false)
        return
      }
      const result = await window.api.files.read(filePath)
      if (cancelled) return
      if (!result.ok) setError(result.error ?? 'failed to read')
      else setText(result.text)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [filePath, isImage, ext])

  const name = basename(filePath)

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header */}
      <div className="flex items-center px-3 h-8 border-b border-line shrink-0 bg-bg-elev">
        <span className="text-xs font-medium text-fg truncate">{name}</span>
        <span className="ml-3 text-[10px] text-fg-faint truncate">{filePath}</span>
        <div className="flex-1" />
        <button
          onClick={() => window.api.files.openExternal(filePath)}
          className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded mr-1"
          title="Open in default app"
        >
          Open
        </button>
        <button
          onClick={() => window.api.files.showInFinder(filePath)}
          className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded mr-1"
          title="Reveal in OS"
        >
          Reveal
        </button>
        <button
          onClick={onClose}
          className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded"
          title="Close preview"
        >
          Close
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="p-6 text-xs text-fg-faint">loading…</div>
        )}
        {error && (
          <div className="p-6 text-xs text-red-400">{error}</div>
        )}
        {!loading && !error && isImage && ext === 'svg' && (
          <div className="p-6" dangerouslySetInnerHTML={{ __html: text }} />
        )}
        {!loading && !error && isImage && ext !== 'svg' && imageUrl && (
          <div className="p-6 flex items-center justify-center">
            <img
              src={imageUrl}
              alt={name}
              className="max-w-full max-h-full object-contain"
              draggable={false}
            />
          </div>
        )}
        {!loading && !error && !isImage && isMarkdown && (
          <div
            className="p-6 prose prose-invert max-w-3xl mx-auto text-fg text-sm leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        )}
        {!loading && !error && !isImage && !isMarkdown && (
          <pre className="p-4 text-xs font-mono text-fg whitespace-pre-wrap leading-relaxed">
            {text}
          </pre>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------
// Minimal markdown renderer — handles headers, bold/italic, lists, code
// blocks, inline code, blockquotes, hr, links. Not GFM-complete.
// -------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function renderMarkdown(src: string): string {
  let html = escapeHtml(src)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    return `<pre style="background:#12151a;border:1px solid #242a33;border-radius:6px;padding:0.75em;overflow-x:auto;font-size:0.85em;"><code>${code}</code></pre>`
  })
  html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.06);padding:0.1em 0.35em;border-radius:3px;font-size:0.9em;color:#d97757;">$1</code>')
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>')
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>')
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#d97757;text-decoration:underline;">$1</a>')
  html = html.replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid #d97757;padding-left:0.75em;color:#8a93a0;margin:0.5em 0;">$1</blockquote>')
  html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid #242a33;margin:1em 0;" />')
  html = html.replace(/\n\n/g, '</p><p>')
  html = `<p>${html}</p>`
  html = html.replace(/<p><\/p>/g, '')
  return html
}
