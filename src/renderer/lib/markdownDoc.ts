/**
 * Frontmatter split/join for the Doc Editor WYSIWYG mode.
 *
 * Hand-rolled, matching the approach in agentFrontmatter.ts and
 * prdFrontmatter.ts — no additional YAML library.
 *
 * The key invariant: Tiptap never sees the frontmatter block. We split it
 * off before handing the body to Tiptap, and rejoin via verbatim concat on
 * serialize. The `data` field is parsed for display only (frontmatter chip).
 */

export interface SplitDoc {
  /** Raw `---\n...\n---\n` block including delimiters and trailing newline. Empty string if none. */
  frontmatter: string
  /** Everything after the closing delimiter. */
  body: string
  /** Shallowly parsed key→value pairs from the frontmatter block. Read-only. */
  data: Record<string, unknown>
}

// Same regex as agentFrontmatter.ts / prdFrontmatter.ts.
const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/

function parseData(block: string): Record<string, unknown> {
  // Strip delimiters to get just the inner YAML text.
  const inner = block.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '')
  const result: Record<string, unknown> = {}
  for (const line of inner.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim()
    if (key && !key.startsWith('#')) result[key] = val || true
  }
  return result
}

export function splitFrontmatter(raw: string): SplitDoc {
  try {
    const m = raw.match(FRONTMATTER_RE)
    if (!m) return { frontmatter: '', body: raw, data: {} }
    const frontmatter = m[1]
    const body = m[2] ?? ''
    const data = parseData(frontmatter)
    return { frontmatter, body, data }
  } catch {
    // Malformed input — treat entire content as body.
    return { frontmatter: '', body: raw, data: {} }
  }
}

/** Verbatim concat — never re-serializes YAML so key order is preserved. */
export function joinFrontmatter(split: SplitDoc, newBody: string): string {
  return split.frontmatter + newBody
}
