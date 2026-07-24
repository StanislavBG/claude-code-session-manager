/**
 * applySpanEdit — pure buffer-splice helper for the Document Experience
 * inline rewrite flow (PRD 639). `before` is the text the popover captured
 * from the *rendered* markdown preview, not the raw markdown source, so an
 * exact match can miss even when the underlying content is unchanged (e.g.
 * a wrapped source line joins into one rendered sentence). Falls back to a
 * whitespace-normalized match before giving up.
 */

export type ApplySpanEditResult =
  | { ok: true; next: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' }

/** O(n) scan counting non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  for (;;) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) break
    count++
    idx = found + needle.length
  }
  return count
}

interface WhitespaceMap {
  norm: string
  /** norm[k] originated at starts[k] in the source string (inclusive). */
  starts: number[]
  /** norm[k] originated up to ends[k] in the source string (exclusive). */
  ends: number[]
}

/** Collapse each run of whitespace to a single space, tracking the original
 *  offsets each collapsed/kept character came from so a match found in the
 *  normalized string can be mapped back to source offsets. */
function normalizeWithMap(s: string): WhitespaceMap {
  let norm = ''
  const starts: number[] = []
  const ends: number[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      const start = i
      while (i < s.length && /\s/.test(s[i])) i++
      norm += ' '
      starts.push(start)
      ends.push(i)
    } else {
      norm += c
      starts.push(i)
      ends.push(i + 1)
      i++
    }
  }
  return { norm, starts, ends }
}

export function applySpanEdit(buffer: string, before: string, after: string): ApplySpanEditResult {
  const exactCount = countOccurrences(buffer, before)
  if (exactCount === 1) {
    const idx = buffer.indexOf(before)
    return { ok: true, next: buffer.slice(0, idx) + after + buffer.slice(idx + before.length) }
  }
  if (exactCount >= 2) return { ok: false, reason: 'ambiguous' }

  // exactCount === 0 — the buffer may have changed under us, or `before` is
  // the rendered selection whose whitespace doesn't match the source verbatim.
  const bufMap = normalizeWithMap(buffer)
  const normBefore = normalizeWithMap(before).norm.trim()
  if (!normBefore) return { ok: false, reason: 'not-found' }

  const normCount = countOccurrences(bufMap.norm, normBefore)
  if (normCount !== 1) return { ok: false, reason: 'not-found' }

  const normStart = bufMap.norm.indexOf(normBefore)
  const normEnd = normStart + normBefore.length
  const origStart = bufMap.starts[normStart]
  const origEnd = bufMap.ends[normEnd - 1]
  return { ok: true, next: buffer.slice(0, origStart) + after + buffer.slice(origEnd) }
}
