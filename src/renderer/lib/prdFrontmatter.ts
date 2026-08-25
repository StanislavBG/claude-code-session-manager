/**
 * Minimal YAML frontmatter parse/serialize for scheduler PRD files.
 *
 * Mirrors agentFrontmatter.ts: hand-rolled, line-band preservation, no js-yaml.
 *
 * Documented PRD frontmatter shape (per CLAUDE.md scheduler section):
 *   - title: string (required)
 *   - cwd: string (required, absolute path)
 *   - estimateMinutes: number (required)
 *   - parallelGroup: number (optional, matches NN- slug prefix)
 *   - sourcePromptId: string (optional) — traces this PRD back to the
 *     PromptTicket.id (PRD 748) it was authored from when classified
 *     'develop' (PRD 749). Additive only; absent on every PRD authored
 *     before this field existed.
 *   - sourceTabId: string (optional) — the tab that originated this PRD, used
 *     by the scheduler (PRD 761) to route a completion status prompt back
 *     into that tab's chat queue via enqueueExternalPrompt. Additive only.
 *   - tag: 'feature' | 'bug' | 'build' (optional) — the user-selected
 *     composer tag (PRD 774; 'build' added later) carried through from the
 *     originating PromptTicket. Additive only; absent on every PRD authored
 *     before this field existed. A 'discussion' ticket never reaches PRD
 *     authoring, so that value is never parsed here even if present in a
 *     hand-edited file.
 *
 * Round-trip invariant: keys not in `PrdFrontmatter` are preserved verbatim
 * in their original line range via `extras`. Edits only touch lines that own
 * a recognized key the caller actually changed.
 */

import { TAG_LIBRARY, type EpicTag } from './tagLibrary'

// A 'discussion'-tagged ticket never reaches PRD authoring, so that value is
// excluded here even though the write-side schema (ipcSchemas.cjs's
// schedulerCreatePrd) accepts it as a WorkType in general.
const PRD_TAG_VALUES: Set<EpicTag> = new Set(TAG_LIBRARY.map((entry) => entry.tag).filter((tag) => tag !== 'discussion'))

export type PrdFrontmatter = {
  title?: string
  cwd?: string
  estimateMinutes?: number
  parallelGroup?: number
  sourcePromptId?: string
  sourceTabId?: string
  tag?: EpicTag
  // Unrecognized keys round-trip via `extras`.
  extras?: Record<string, RawValue>
  // Original raw line per recognized key. Used to preserve quote style and
  // spacing on round-trip when the in-memory value still parses to the same
  // thing. The form editor never sets this — it's only populated by
  // parsePrdFile. The serializer prefers _raw when the cached value matches.
  _raw?: Record<string, { line: string; parsed: string | number | null }>
}

// Raw value preserves the original text band so we can round-trip without
// reformatting unrelated keys.
type RawValue = {
  lines: string[]
}

export type ParsedPrdFile = {
  frontmatter: PrdFrontmatter
  body: string
}

const RECOGNIZED_KEYS = new Set<keyof PrdFrontmatter>([
  'title',
  'cwd',
  'estimateMinutes',
  'parallelGroup',
  'sourcePromptId',
  'sourceTabId',
  'tag',
])

// Emit order is stable so opening+saving without edits is byte-identical.
const EMIT_ORDER: Array<keyof PrdFrontmatter> = [
  'title',
  'cwd',
  'estimateMinutes',
  'parallelGroup',
  'sourcePromptId',
  'sourceTabId',
  'tag',
]

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n++
    else if (ch === '\t') n += 2
    else break
  }
  return n
}

function parseScalar(raw: string): string | number | boolean | null {
  // Match the main-process scheduler.cjs::parsePrdRaw — it does NOT strip
  // mid-string `#` as YAML comments, because real PRD titles like
  // "deal #1..1_000_000" contain hashes. Round-trip fidelity beats YAML
  // strictness here.
  const v = raw.trim()
  if (v === '' || v === '~' || v === 'null') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

export function parsePrdFile(text: string): ParsedPrdFile {
  const m = text.match(FRONTMATTER_RE)
  if (!m) {
    return { frontmatter: {}, body: text }
  }
  const fmText = m[1]
  const body = m[2] ?? ''

  const lines = fmText.split(/\r?\n/)
  const fm: PrdFrontmatter = {}
  const extras: Record<string, RawValue> = {}

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++
      continue
    }
    const ind = indentOf(line)
    if (ind !== 0) {
      i++
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) {
      i++
      continue
    }
    const key = line.slice(0, colon).trim()
    const after = line.slice(colon + 1)
    // Find the end of this key's band (next top-level key).
    let j = i + 1
    const band: string[] = [line]
    while (j < lines.length) {
      const nxt = lines[j]
      if (nxt.trim() === '' || nxt.trimStart().startsWith('#')) {
        band.push(nxt)
        j++
        continue
      }
      if (indentOf(nxt) === 0 && nxt.indexOf(':') >= 0) break
      band.push(nxt)
      j++
    }

    if (RECOGNIZED_KEYS.has(key as keyof PrdFrontmatter)) {
      applyKey(fm, key, after)
      // Cache the original line + parsed value so the serializer can prefer
      // the original verbatim text when the in-memory value still matches.
      const parsed = parseScalar(after)
      if (parsed !== null && (typeof parsed === 'string' || typeof parsed === 'number')) {
        if (!fm._raw) fm._raw = {}
        fm._raw[key] = { line, parsed }
      }
    } else {
      extras[key] = { lines: band }
    }
    i = j
  }

  if (Object.keys(extras).length) fm.extras = extras
  return { frontmatter: fm, body }
}

function applyKey(fm: PrdFrontmatter, key: string, after: string): void {
  const v = parseScalar(after)
  if (v === null) return
  switch (key) {
    case 'estimateMinutes':
      fm.estimateMinutes = typeof v === 'number' ? v : Number(v)
      return
    case 'parallelGroup':
      fm.parallelGroup = typeof v === 'number' ? v : Number(v)
      return
    case 'title':
      fm.title = String(v)
      return
    case 'cwd':
      fm.cwd = String(v)
      return
    case 'sourcePromptId':
      fm.sourcePromptId = String(v)
      return
    case 'sourceTabId':
      fm.sourceTabId = String(v)
      return
    case 'tag':
      if (typeof v === 'string' && PRD_TAG_VALUES.has(v as EpicTag)) fm.tag = v as EpicTag
      return
  }
}

function serializeScalar(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  // Quote only when the unquoted form would re-parse to a different value
  // under our line-oriented parser (see parseScalar). The parser is permissive
  // about brackets/braces/colons inside the value, so don't gratuitously
  // quote titles that contain them — round-trip fidelity matters more than
  // strict YAML conformance here.
  const needsQuote =
    s === '' ||
    /^(true|false|null|~)$/.test(s) ||
    /^-?\d+(\.\d+)?$/.test(s) ||
    /^\s|\s$/.test(s) ||
    s.startsWith("'") ||
    s.startsWith('"') ||
    s.includes('\n')
  if (!needsQuote) return s
  if (s.includes("'")) return `"${s.replace(/"/g, '\\"')}"`
  return `'${s}'`
}

/**
 * Serialize back to a full file (frontmatter + body).
 *
 * Round-trip rule: when a value's serialized form would re-parse identically
 * AND the input's recognized keys were already in EMIT_ORDER, the output is
 * byte-identical to the input. Extras are re-emitted from their original line
 * band so they always round-trip.
 */
export function serializePrdFile(fm: PrdFrontmatter, body: string): string {
  const out: string[] = []
  for (const key of EMIT_ORDER) {
    const v = fm[key]
    if (v === undefined || v === null || v === '') continue
    // Prefer the original line verbatim when the cached parsed value still
    // matches the in-memory value. This preserves quote style and spacing so
    // an open-then-save without edits produces a byte-identical file.
    const cached = fm._raw?.[key]
    if (cached && cached.parsed === v) {
      out.push(cached.line)
      continue
    }
    if (typeof v === 'number') {
      out.push(`${key}: ${v}`)
      continue
    }
    out.push(`${key}: ${serializeScalar(v as string)}`)
  }
  if (fm.extras) {
    for (const k of Object.keys(fm.extras)) {
      const band = fm.extras[k]
      if (!band || !band.lines.length) continue
      out.push(band.lines.join('\n'))
    }
  }

  const fmText = out.join('\n')
  // Body is emitted verbatim — the parse regex's optional trailing `\r?\n?`
  // already consumed exactly one separator newline, so re-prepending `---\n`
  // restores the original. Stripping a leading `\n` here would erase a blank
  // line the user wrote between the frontmatter and the body heading.
  return `---\n${fmText}\n---\n${body}`
}
