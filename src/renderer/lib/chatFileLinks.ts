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

// Longest plausible real-world file extension (e.g. "cjsx", "mjs", "tsx",
// "d.ts" segments) — bounds the false-positive surface without a hardcoded
// extension allowlist that would need constant upkeep.
const MAX_EXTENSION_LENGTH = 10

// An ALL-CAPS identifier with an underscore (e.g. "TOOL_PROJECTS") is a common
// JS/Python constant-naming pattern, never a real file extension. A token with
// no path separator (no "/") that ends in one of these is prose quoting a
// constant name, not a file path — FILE_LINK_RE's `\.[A-Za-z]\w*` group has no
// way to tell "path.ts" from "..TOOL_PROJECTS" (an ellipsis whose last dot the
// regex mistakes for an extension separator) without this extra check.
const ALL_CAPS_WITH_UNDERSCORE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

/**
 * Filters out FILE_LINK_RE matches that look like prose (an ALL-CAPS constant
 * name, possibly ellipsis-prefixed) rather than a real bare file-path mention.
 * A token with a path separator is trusted as-is; only extensionless-looking,
 * separator-free tokens get the extra scrutiny.
 */
function isPlausibleFilePath(pathPart: string): boolean {
  const filePath = pathPart.replace(/(?::\d+)+$/, '')
  if (filePath.includes('/')) return true
  const dot = filePath.lastIndexOf('.')
  const ext = dot === -1 ? '' : filePath.slice(dot + 1)
  if (!ext || ext.length > MAX_EXTENSION_LENGTH) return false
  if (ALL_CAPS_WITH_UNDERSCORE_RE.test(ext)) return false
  return true
}

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
    const matches = [...text.matchAll(FILE_LINK_RE)].filter((m) => isPlausibleFilePath(m[1]))
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

// Dedups and hard-caps at 3, mirroring extractUrls.ts's pattern — feeds the
// same bottom-right callout list as extracted URLs, alongside them.
const MAX_EXTRACTED_FILE_PATHS = 3

/** Extracts unique bare file-path mentions from raw (pre-render) chat text. */
export function extractFilePaths(text: string): string[] {
  FILE_LINK_RE.lastIndex = 0
  const seen = new Set<string>()
  const paths: string[] = []
  for (const m of text.matchAll(FILE_LINK_RE)) {
    const p = m[1]
    if (!isPlausibleFilePath(p)) continue
    if (!seen.has(p)) {
      seen.add(p)
      paths.push(p)
      if (paths.length >= MAX_EXTRACTED_FILE_PATHS) break
    }
  }
  return paths
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
