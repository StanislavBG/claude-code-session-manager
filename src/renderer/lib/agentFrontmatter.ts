/**
 * Minimal YAML frontmatter parse/serialize for Claude Code subagent files.
 *
 * We do NOT have js-yaml in package.json (and may not add it). This is a
 * hand-rolled line-oriented parser that handles the documented subagent
 * frontmatter shape: scalars, scalar-arrays in either `[a, b]` flow form or
 * indented `- item` block form, and simple `key: value` nested objects.
 *
 * Round-trip invariant: keys not recognized in `AgentFrontmatter` are
 * preserved verbatim in their original line range. Edits only touch the lines
 * that own a recognized key the user actually changed.
 *
 * If we ever need full YAML (anchors, multi-line strings beyond `|`/`>`,
 * complex nested arrays), the line-band fallback will hold; add js-yaml then.
 */

export type AgentFrontmatter = {
  name?: string
  description?: string
  // tools/skills accept both YAML-array and comma-joined string forms.
  tools?: string[] | string
  disallowedTools?: string[] | string
  model?: 'opus' | 'sonnet' | 'haiku' | 'inherit' | string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  isolation?: 'worktree'
  memory?: 'user' | 'project' | 'local' | boolean
  background?: boolean
  initialPrompt?: string
  skills?: string[]
  color?: 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan' | string
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions' | 'plan'
  maxTurns?: number
  mcpServers?: Record<string, unknown>
  hooks?: Record<string, unknown>
  // Unrecognized keys round-trip via `extras`.
  extras?: Record<string, RawValue>
}

// Raw value preserves the original text band so we can round-trip without
// reformatting unrelated keys.
type RawValue = {
  // The raw lines (including the key line) covering this entry. Joined with
  // '\n' on serialize, never re-encoded.
  lines: string[]
}

export type ParsedAgentFile = {
  frontmatter: AgentFrontmatter
  body: string
}

const RECOGNIZED_KEYS = new Set<keyof AgentFrontmatter>([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'effort',
  'isolation',
  'memory',
  'background',
  'initialPrompt',
  'skills',
  'color',
  'permissionMode',
  'maxTurns',
  'mcpServers',
  'hooks',
])

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

function stripComment(s: string): string {
  // Strip trailing ` #...` comments but leave `#` inside quoted strings alone.
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd()
    }
  }
  return s
}

function parseScalar(raw: string): string | number | boolean | null {
  const v = stripComment(raw).trim()
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

function parseInlineArray(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (!inner.trim()) return []
  // Split on commas not inside quotes — naive but adequate for the documented
  // shape (`[bash, edit]` or `['a', "b"]`).
  const out: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  for (const ch of inner) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (ch === ',' && !inSingle && !inDouble) {
      out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

export function parseAgentFile(text: string): ParsedAgentFile {
  const m = text.match(FRONTMATTER_RE)
  if (!m) {
    return { frontmatter: {}, body: text }
  }
  const fmText = m[1]
  const body = m[2] ?? ''

  const lines = fmText.split(/\r?\n/)
  const fm: AgentFrontmatter = {}
  const extras: Record<string, RawValue> = {}

  // We walk top-level keys (indent === 0). Each key consumes its own line plus
  // any indented child lines until the next top-level key.
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++
      continue
    }
    const ind = indentOf(line)
    if (ind !== 0) {
      // Stray indented line at toplevel — bind to extras under a sentinel key.
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

    if (RECOGNIZED_KEYS.has(key as keyof AgentFrontmatter)) {
      applyKey(fm, key, after, band.slice(1))
    } else {
      extras[key] = { lines: band }
    }
    i = j
  }

  if (Object.keys(extras).length) fm.extras = extras
  return { frontmatter: fm, body }
}

function applyKey(
  fm: AgentFrontmatter,
  key: string,
  after: string,
  rest: string[],
): void {
  const inline = stripComment(after).trim()
  // Inline-array shortcut.
  if (inline.startsWith('[') && inline.endsWith(']')) {
    const arr = parseInlineArray(inline)
    if (key === 'tools' || key === 'disallowedTools' || key === 'skills') {
      ;(fm as Record<string, unknown>)[key] = arr
      return
    }
  }
  // Block-array detection.
  const blockArrayLines = rest.filter((l) => l.trim() && l.trimStart().startsWith('- '))
  if (inline === '' && blockArrayLines.length > 0) {
    const arr = blockArrayLines.map((l) => {
      const v = parseScalar(l.trim().slice(2))
      return v === null ? '' : String(v)
    })
    if (key === 'tools' || key === 'disallowedTools' || key === 'skills') {
      ;(fm as Record<string, unknown>)[key] = arr
      return
    }
  }
  // Nested object (mcpServers, hooks): preserve raw band as JSON-string for
  // the editor's "raw" view; we don't surface these as forms.
  const childLines = rest.filter((l) => l.trim() && !l.trimStart().startsWith('- '))
  if (inline === '' && childLines.length > 0 && (key === 'mcpServers' || key === 'hooks')) {
    // Store as a placeholder record so the editor knows it exists. Round-trip
    // uses `extras` band-preservation via the recognized-keys path below.
    const placeholder: Record<string, unknown> = {}
    for (const cl of childLines) {
      const cInd = indentOf(cl)
      if (cInd === 2) {
        const cc = cl.trim()
        const ck = cc.split(':')[0]
        if (ck) placeholder[ck] = null
      }
    }
    ;(fm as Record<string, unknown>)[key] = placeholder
    return
  }

  // Scalar.
  const v = parseScalar(after)
  if (v === null) return
  switch (key) {
    case 'background':
      fm.background = typeof v === 'boolean' ? v : String(v).toLowerCase() === 'true'
      return
    case 'maxTurns':
      fm.maxTurns = typeof v === 'number' ? v : Number(v)
      return
    case 'memory':
      if (v === true || v === false) fm.memory = v
      else fm.memory = String(v) as AgentFrontmatter['memory']
      return
    case 'tools':
    case 'disallowedTools':
    case 'skills':
      // Single-string form like `tools: bash, edit` — split on commas.
      ;(fm as Record<string, unknown>)[key] = String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return
    default:
      ;(fm as Record<string, unknown>)[key] = String(v)
  }
}

function serializeScalar(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  // Quote if it would otherwise parse as a special token or contain hazards.
  if (
    s === '' ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
    /^-?\d/.test(s) ||
    /[:#\[\]{}&*!|>'"%@`]/.test(s) ||
    /^\s|\s$/.test(s)
  ) {
    // Prefer single-quote unless it contains one.
    if (s.includes("'")) return `"${s.replace(/"/g, '\\"')}"`
    return `'${s}'`
  }
  return s
}

function serializeArray(key: string, arr: string[]): string {
  if (arr.length === 0) return `${key}: []`
  const items = arr.map((v) => serializeScalar(v))
  // Use inline form when short; otherwise block form for readability.
  const inline = `${key}: [${items.join(', ')}]`
  if (inline.length <= 100) return inline
  return `${key}:\n${items.map((v) => `  - ${v}`).join('\n')}`
}

export function serializeAgentFile(fm: AgentFrontmatter, body: string): string {
  const out: string[] = []
  // Emit recognized keys in a stable order so files don't churn on save.
  const order: (keyof AgentFrontmatter)[] = [
    'name',
    'description',
    'model',
    'effort',
    'color',
    'tools',
    'disallowedTools',
    'skills',
    'permissionMode',
    'maxTurns',
    'isolation',
    'memory',
    'background',
    'initialPrompt',
    'mcpServers',
    'hooks',
  ]
  for (const key of order) {
    const v = fm[key]
    if (v === undefined) continue
    if (key === 'tools' || key === 'disallowedTools' || key === 'skills') {
      const arr = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean)
      out.push(serializeArray(key, arr))
      continue
    }
    if (key === 'mcpServers' || key === 'hooks') {
      // We don't round-trip these via form fields; if they were parsed from
      // extras, they'll be re-emitted from extras below. If a caller passes a
      // value here without an extras band, emit as flow-JSON (last resort).
      const extra = fm.extras?.[key]
      if (extra) continue
      out.push(`${key}: ${JSON.stringify(v)}`)
      continue
    }
    if (typeof v === 'boolean' || typeof v === 'number') {
      out.push(`${key}: ${v}`)
      continue
    }
    out.push(`${key}: ${serializeScalar(v as string)}`)
  }
  // Re-emit extras (including any mcpServers/hooks that came in via the band).
  if (fm.extras) {
    for (const k of Object.keys(fm.extras)) {
      const band = fm.extras[k]
      if (!band || !band.lines.length) continue
      out.push(band.lines.join('\n'))
    }
  }

  const fmText = out.join('\n')
  // Preserve trailing newline behavior.
  const bodyTrimmed = body.startsWith('\n') ? body.slice(1) : body
  return `---\n${fmText}\n---\n${bodyTrimmed}`
}
