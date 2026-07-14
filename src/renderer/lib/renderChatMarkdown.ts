import { marked } from 'marked'
import DOMPurify from 'dompurify'

// `breaks: true` makes a single newline within a paragraph render as `<br>`
// instead of a soft break that browsers collapse to a space. Claude's own
// markdown output frequently uses lines like "✓ item one\n✓ item two" that
// are NOT valid GFM list syntax (no `-`/`*`/digit marker), so without this
// option marked emits one <p> and the newlines vanish in rendered HTML,
// making the lines run together (issue #3). Real `- item` lists are
// unaffected — marked's GFM list parsing already splits those into <li>
// regardless of this flag.
export function renderChatMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { async: false, breaks: true }) as string)
}
