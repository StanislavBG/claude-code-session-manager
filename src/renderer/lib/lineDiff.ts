export type DiffLineType = 'add' | 'remove' | 'context'

export interface DiffLine {
  type: DiffLineType
  text: string
}

export interface LineDiffResult {
  lines: DiffLine[]
  added: number
  removed: number
}

/**
 * Line-level diff via a classic LCS table. O(n*m) time/space, where n/m are
 * the old/new line counts — acceptable here because diff payloads reaching
 * this function are already capped at MAX_DIFF_STR (4096 chars,
 * toolUseClassify.cjs) before they leave the main process, so n/m are at
 * most a few hundred lines.
 *
 * `oldText === undefined` (a Write tool_use, which carries no previous
 * content) renders every line of `newText` as added.
 */
// A caller-supplied string ending in "\n" splits into a trailing "" element
// (e.g. "a\nb\n".split('\n') -> ['a','b','']) that doesn't correspond to a
// real line — drop it so a lone trailing newline on only one side of the
// diff doesn't produce a spurious add/remove of an empty line.
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop()
  return lines
}

export function computeLineDiff(oldText: string | undefined, newText: string | undefined): LineDiffResult {
  const newLines = newText != null ? splitLines(newText) : []

  if (oldText == null) {
    const lines: DiffLine[] = newLines.map((text) => ({ type: 'add' as const, text }))
    return { lines, added: newLines.length, removed: 0 }
  }

  const oldLines = splitLines(oldText)
  const n = oldLines.length
  const m = newLines.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: 'context', text: oldLines[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: 'remove', text: oldLines[i] })
      removed++
      i++
    } else {
      lines.push({ type: 'add', text: newLines[j] })
      added++
      j++
    }
  }
  while (i < n) {
    lines.push({ type: 'remove', text: oldLines[i] })
    removed++
    i++
  }
  while (j < m) {
    lines.push({ type: 'add', text: newLines[j] })
    added++
    j++
  }

  return { lines, added, removed }
}
