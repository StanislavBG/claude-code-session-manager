/**
 * changedLines — what Claude changed in a document, relative to a baseline.
 *
 * Pure, dependency-free helpers behind DocumentEditorPane's `changedFrom` prop:
 *   - changedLines: 1-based lines of `value` that a line LCS diff marks as added
 *     or modified (a removed line has no line left in `value`, so no mark).
 *     Markdown mode draws a honey left rule on each.
 *   - changedBlocks: the blank-line-separated blocks of `value` whose text is
 *     not a block of the baseline. Document mode highlights the top-level
 *     Tiptap nodes whose text matches one (via blockKey on both sides).
 */

function splitLines(s: string): string[] {
  return s.length === 0 ? [] : s.split('\n')
}

/** 1-based line numbers in `value` that are added or modified vs `baseline`. */
export function changedLines(baseline: string, value: string): number[] {
  const a = splitLines(baseline)
  const b = splitLines(value)
  // Trim the common prefix / suffix so the DP only covers the edited middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const n = endA - start
  const m = endB - start
  if (m === 0) return []
  const out: number[] = []
  if (n === 0) {
    for (let j = start; j < endB; j++) out.push(j + 1)
    return out
  }
  // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB).
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[start + i] === b[start + j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (j < m) {
    if (i < n && a[start + i] === b[start + j]) { i++; j++ }
    else if (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++
    else { out.push(start + j + 1); j++ }
  }
  return out
}

function splitBlocks(s: string): string[] {
  return s.split(/\n[ \t]*\n/).map((b) => b.trim()).filter((b) => b.length > 0)
}

/** Blank-line-separated blocks of `value` (trimmed) whose text is not a block of `baseline`. */
export function changedBlocks(baseline: string, value: string): string[] {
  const before = new Set(splitBlocks(baseline))
  return splitBlocks(value).filter((b) => !before.has(b))
}

/** One markdown line → its rendered text (heading/list/quote markers and inline syntax dropped). */
export function stripMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}(`{3,}|~{3,}).*$/, '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(>\s?)+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|\*|`)/g, '')
    .trim()
}

/**
 * Whitespace-free comparison key, so a markdown block and a Tiptap node's
 * textContent (which concatenates child text with no separators) line up.
 */
export function blockKey(text: string, isMarkdown: boolean): string {
  const t = isMarkdown ? text.split('\n').map(stripMarkdown).join('') : text
  return t.replace(/\s+/g, '')
}
