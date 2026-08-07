import { marked } from 'marked'
import DOMPurify from 'dompurify'

// `breaks: true` makes a single newline within a paragraph render as `<br>`
// instead of a soft break that browsers collapse to a space. Claude's own
// markdown output frequently uses lines like "✓ item one\n✓ item two" that
// are NOT valid GFM list syntax (no `-`/`*`/digit marker), so without this
// option marked emits one <p> and the newlines vanish in rendered HTML,
// making the lines run together (issue #3). Real `- item` lists are
// unaffected — marked's GFM list parsing already splits those into <li>
// regardless of this flag. GFM tables (issue #2) parse into a real <table>
// with no extra config — `gfm` is on by default in marked. Claude can emit a
// standard GFM table to render one, e.g.:
//   | Name | Status |
//   |------|--------|
//   | build | passing |
// The table renderer below only WRAPS marked's default <table> output in a
// horizontally-scrollable container so a wide table can't force the chat column
// to overflow. Both `.prose-chat-table-wrap` (the overflow) and the
// `.prose-chat table/th/td` borders it needs live in styles.css.
//
// Wrapping — rather than reimplementing table() — is load-bearing for safety:
// the default renderer is what escapes cell content (via this.tablecell ->
// parser.parseInline), so calling it keeps marked's escaping intact and this
// override adds no unescaped interpolation of its own. `.bind()` is required
// because the default table() calls `this.tablecell`/`this.tablerow`.
// DOMPurify.sanitize() below still covers the wrapper and everything inside it.
const chatMarkdownRenderer = new marked.Renderer()
const renderTableDefault = chatMarkdownRenderer.table.bind(chatMarkdownRenderer)
chatMarkdownRenderer.table = (token) =>
  `<div class="prose-chat-table-wrap">${renderTableDefault(token)}</div>`

// Bounded cache keyed on the raw source string. `chatMarkdownRenderer` and the
// marked options above are module constants that never vary per call, so the
// source string alone is a complete cache key. A Map preserves insertion
// order, so the first key is always the oldest — eviction just deletes it.
export const CHAT_MARKDOWN_CACHE_CAP = 400

const cache = new Map<string, string>()

export function renderChatMarkdown(src: string): string {
  const cached = cache.get(src)
  if (cached !== undefined) return cached

  const html = DOMPurify.sanitize(
    marked.parse(src, { async: false, breaks: true, renderer: chatMarkdownRenderer }) as string,
  )

  cache.set(src, html)
  if (cache.size > CHAT_MARKDOWN_CACHE_CAP) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }

  return html
}

export function clearChatMarkdownCache(): void {
  cache.clear()
}
