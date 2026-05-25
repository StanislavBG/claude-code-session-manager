/**
 * Minimal YAML frontmatter parser for the prompt seed library.
 *
 * Only handles the 5 known scalar keys (id, title, category, sendMode,
 * description) plus a plain-text body. No js-yaml dependency — same approach
 * as agentFrontmatter.ts.
 *
 * Returns null and console.errors on any parse failure so import-time errors
 * can never crash the renderer.
 */

export type SendMode = 'paste' | 'auto-fire'

export interface Prompt {
  /** e.g. "security/owasp-top-10-staged-diff" (category/slug) */
  id: string
  title: string
  /** Human label e.g. "Security", "Code Review" */
  category: string
  /** Default send mode — user can override in the TweakModal */
  sendMode: SendMode
  /** One-line summary for list view */
  description: string
  /** Plain-text prompt body (everything after the closing ---) */
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const REQUIRED_KEYS = ['id', 'title', 'category', 'sendMode', 'description'] as const

export function parsePromptMarkdown(raw: string): Prompt | null {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) {
    console.error('[promptFrontmatter] no frontmatter block found')
    return null
  }

  const fmText = m[1]
  const body = (m[2] ?? '').trim()

  // Parse scalar key: value pairs.  Only top-level lines are considered;
  // indented lines are ignored (none expected in our shape).
  const fm: Record<string, string> = {}
  for (const line of fmText.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 0 || line.startsWith(' ') || line.startsWith('\t')) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key) fm[key] = value
  }

  // Validate required keys.
  for (const k of REQUIRED_KEYS) {
    if (!fm[k]) {
      console.error(
        `[promptFrontmatter] missing required key "${k}" in: ${raw.slice(0, 120).replace(/\n/g, '\\n')}`,
      )
      return null
    }
  }

  const sendMode: SendMode = fm.sendMode === 'auto-fire' ? 'auto-fire' : 'paste'

  return {
    id: fm.id,
    title: fm.title,
    category: fm.category,
    sendMode,
    description: fm.description,
    body,
  }
}
