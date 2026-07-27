// Bare file-path mentions in assistant chat text (e.g. "docs/README.md" or
// "src/foo.ts:42:8") have no markdown link syntax, so `marked` renders them as
// plain text — unlike a real `[text](url)` link (handled by handleChatLinkClick).
// This module post-processes the already-rendered DOM (see TerminalChat.tsx's
// Turn()) to make those tokens clickable, mirroring Terminal.tsx's xterm
// ILinkProvider for the raw-terminal surface. Regex duplicated verbatim from
// Terminal.tsx's FILE_LINK_RE — not shared, per this PRD's scope (a small
// duplicated constant over a forced cross-cutting refactor).
export const FILE_LINK_RE = /(?:^|[\s(])((?:\.{1,2}\/)?[\w./-]+\.[A-Za-z]\w*(?::(\d+))?(?::(\d+))?)/g

/** data attribute a linkified span carries; read back by handleChatLinkClick. */
export const FILE_LINK_ATTR = 'data-file-link-text'

/**
 * Walks text nodes under `root` and wraps file-path-like tokens in a
 * `<span data-file-link-text="...">`, skipping text already inside an <a>,
 * <code>, or <pre> — a token that's already a real link (post-709) or inside
 * a code span/block must not be double-wrapped or corrupted. Operates on the
 * parsed DOM (not the raw markdown string) so real markdown syntax and code
 * block contents are never regex-mangled.
 */
export function linkifyFilePaths(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('a, code, pre')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const textNodes: Text[] = []
  let n: Node | null
  // eslint-disable-next-line no-cond-assign
  while ((n = walker.nextNode())) textNodes.push(n as Text)

  for (const node of textNodes) {
    const text = node.textContent ?? ''
    FILE_LINK_RE.lastIndex = 0
    const matches = [...text.matchAll(FILE_LINK_RE)]
    if (matches.length === 0) continue

    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const m of matches) {
      const full = m[0]
      const pathPart = m[1]
      const matchStart = m.index ?? 0
      const pathStart = matchStart + (full.length - pathPart.length)
      if (pathStart < cursor) continue // overlapping match guard, shouldn't happen with this regex
      if (pathStart > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, pathStart)))
      const span = document.createElement('span')
      span.className = 'chat-file-link'
      span.setAttribute(FILE_LINK_ATTR, pathPart)
      span.textContent = pathPart
      frag.appendChild(span)
      cursor = pathStart + pathPart.length
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
    node.parentNode?.replaceChild(frag, node)
  }
}

/**
 * Resolves a matched token (e.g. "src/foo.ts:42:8") into an absolute path plus
 * optional line/col, same stripping logic as Terminal.tsx:103-107.
 */
export function resolveFileLinkTarget(
  raw: string,
  cwd: string,
): { absPath: string; line?: number; col?: number } {
  const lineColMatch = raw.match(/(?::(\d+))?(?::(\d+))?$/)
  const filePath = raw.replace(/(?::\d+)+$/, '')
  const line = lineColMatch?.[1] ? parseInt(lineColMatch[1], 10) : undefined
  const col = lineColMatch?.[2] ? parseInt(lineColMatch[2], 10) : undefined
  const absPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
  return { absPath, line, col }
}
