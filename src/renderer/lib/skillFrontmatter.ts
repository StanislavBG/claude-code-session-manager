/**
 * Skill enable/disable via the canonical Claude Code frontmatter flag.
 *
 * Turning a skill "off" means setting `disable-model-invocation: true` in its
 * SKILL.md frontmatter — the field the CLI actually reads to stop auto-invoking
 * a skill. (Our old per-project `project-skills.json` toggle wrote a sidecar the
 * CLI never read, so it disabled nothing.) Edits are surgical: only the one key
 * line is added/updated/removed; every other frontmatter line round-trips
 * verbatim. No YAML library — a single-key mutation doesn't need one.
 *
 * The 3a Skills detail edits the body and the description separately:
 * splitSkillDoc/joinSkillDoc cut a file into its frontmatter block and its body and
 * glue them back byte-for-byte; setSkillDescription/readSkillDescription write and
 * read the top-level `description` with the same one-entry surgery.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const KEY = 'disable-model-invocation'
const KEY_LINE_RE = /^\s*disable-model-invocation\s*:/

/** True when the skill's frontmatter disables model invocation. */
export function readSkillDisabled(text: string): boolean {
  const m = text.match(FRONTMATTER_RE)
  if (!m) return false
  for (const line of m[1].split(/\r?\n/)) {
    if (!KEY_LINE_RE.test(line)) continue
    const val = line.slice(line.indexOf(':') + 1).trim().toLowerCase()
    return val === 'true' || val === 'yes'
  }
  return false
}

/**
 * Return `text` with the disable flag set (disabled=true) or cleared
 * (disabled=false → key removed, since absence is the default-on state).
 * Returns the input unchanged when already in the requested state.
 */
function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1)
  }
  return t
}

/** Indentation (leading whitespace) width of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * Extract `name`/`description` scalars from a SKILL.md's frontmatter, folding
 * a multi-line `description: >-` block into one space-joined string. Not a
 * general YAML parser — just enough to read these two known fields.
 */
export function parseSkillMeta(text: string): { name: string | null; description: string | null; body: string } {
  const m = text.match(FRONTMATTER_RE)
  if (!m) return { name: null, description: null, body: text }

  const lines = m[1].split(/\r?\n/)
  const body = m[2] ?? ''
  let name: string | null = null
  let description: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const keyMatch = line.match(/^(\s*)(name|description)\s*:(.*)$/)
    if (!keyMatch) continue
    const [, , key, rest] = keyMatch
    const restTrimmed = rest.trim()
    const keyIndent = indentOf(line)

    let value: string
    if (restTrimmed === '' || restTrimmed === '>-' || restTrimmed === '>' || restTrimmed === '|-' || restTrimmed === '|') {
      // Folded/literal block scalar: gather further-indented continuation lines.
      const parts: string[] = []
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== '' && indentOf(lines[j]) > keyIndent) {
        parts.push(lines[j].trim())
        j++
      }
      value = parts.join(' ')
    } else {
      value = unquote(restTrimmed)
    }

    if (key === 'name') name = value
    else description = value
  }

  return { name, description, body }
}

export function setSkillDisabled(text: string, disabled: boolean): string {
  const m = text.match(FRONTMATTER_RE)

  // No frontmatter block: only need to synthesize one when disabling.
  if (!m) {
    if (!disabled) return text
    const sep = text.startsWith('\n') ? '' : '\n'
    return `---\n${KEY}: true\n---\n${sep}${text}`
  }

  const body = m[2] ?? ''
  const lines = m[1].split(/\r?\n/)
  const idx = lines.findIndex((l) => KEY_LINE_RE.test(l))

  if (disabled) {
    if (idx >= 0) lines[idx] = `${KEY}: true`
    else lines.push(`${KEY}: true`)
  } else {
    if (idx < 0) return text // already enabled
    lines.splice(idx, 1)
  }
  return `---\n${lines.join('\n')}\n---\n${body}`
}

// ── Body / description editing (3a Skills detail) ──────────────────────────

/**
 * The block FRONTMATTER_RE finds (same opening fence, same first `\n---` close), with
 * the frontmatter lines captured together with their line breaks so an edit can swap
 * whole lines without changing a byte around them. m[0] ends right after the closing `---`.
 */
const BLOCK_RE = /^(---\r?\n)([\s\S]*?\r?\n)---/
const DESCRIPTION_KEY_RE = /^\s*description\s*:/
const NAME_KEY_RE = /^\s*name\s*:/
const BLOCK_SCALAR_RE = /^[|>][-+\d]*\s*(?:#.*)?$/

export interface SkillDocParts {
  /**
   * The frontmatter block verbatim: the opening `---` through the end of the closing
   * fence line, its line break included. Null when the file has no frontmatter.
   */
  frontmatter: string | null
  /** Everything after the block, verbatim (the whole text when there is no block). */
  body: string
}

/**
 * Split a SKILL.md / command file into its frontmatter block and its body. Nothing is
 * normalized (CRLF, blank lines and spacing stay put), so
 * `joinSkillDoc(parts.frontmatter, parts.body) === text` for every input. Finds the
 * block exactly where parseSkillMeta does; the body is parseSkillMeta's body, except
 * that stray characters after the closing `---` on its line stay with the block.
 */
export function splitSkillDoc(text: string): SkillDocParts {
  const m = BLOCK_RE.exec(text)
  if (!m) return { frontmatter: null, body: text }
  const nl = text.indexOf('\n', m[0].length)
  const end = nl === -1 ? text.length : nl + 1
  return { frontmatter: text.slice(0, end), body: text.slice(end) }
}

/**
 * Inverse of splitSkillDoc: the block followed by the body, unchanged. One addition:
 * when the closing fence ended the file with no line break, a non-empty body gets one
 * first, so text typed into a frontmatter-only file can't fuse onto the `---` line.
 * splitSkillDoc never returns that pair (such a block always comes with an empty
 * body), so its round trips stay byte-exact.
 */
export function joinSkillDoc(frontmatter: string | null, body: string): string {
  if (!frontmatter || !body || frontmatter.endsWith('\n')) return (frontmatter ?? '') + body
  const eol = frontmatter.endsWith('\r') ? '\n' : frontmatter.startsWith('---\r\n') ? '\r\n' : '\n'
  return frontmatter + eol + body
}

interface FrontmatterLines {
  /** `---` and its line break. */
  open: string
  /** Each frontmatter line with its own `\n` / `\r\n`. */
  lines: string[]
  /** The same lines without their line breaks. */
  texts: string[]
  /** Indentation of the top-level keys (the shallowest one in use). */
  pad: string
  /** The closing fence line and the body. Edits never touch it. */
  rest: string
}

function readFrontmatterLines(text: string): FrontmatterLines | null {
  const m = BLOCK_RE.exec(text)
  if (!m) return null
  const open = m[1]
  const yaml = m[2]
  const lines = yaml.match(/[^\n]*\n/g) ?? []
  const texts = lines.map((l) => l.replace(/\r?\n$/, ''))
  let pad: string | null = null
  for (const t of texts) {
    if (t.trim() === '' || t.trimStart().startsWith('#')) continue
    if (pad === null || indentOf(t) < pad.length) pad = t.slice(0, indentOf(t))
  }
  return { open, lines, texts, pad: pad ?? '', rest: text.slice(open.length + yaml.length) }
}

/**
 * Top-level `key:` entries, in file order, as [start, end) line ranges. An entry is
 * its key line plus every deeper-indented line after it (block scalars, folded or
 * quoted continuations), blank lines inside it included and blank lines after it
 * not. Keys nested under another map (e.g. `metadata:`) are never top level.
 */
function topLevelEntries(fm: FrontmatterLines, keyRe: RegExp): Array<{ start: number; end: number }> {
  const { texts } = fm
  const base = fm.pad.length
  const entries: Array<{ start: number; end: number }> = []
  for (let i = 0; i < texts.length; i++) {
    if (indentOf(texts[i]) !== base || !keyRe.test(texts[i])) continue
    let end = i + 1
    for (let j = end; j < texts.length; j++) {
      if (texts[j].trim() === '') continue
      if (indentOf(texts[j]) <= base) break
      end = j + 1
    }
    entries.push({ start: i, end })
    i = end - 1
  }
  return entries
}

function eolOf(line: string): string {
  return line.endsWith('\r\n') ? '\r\n' : '\n'
}

/** Values a plain scalar would turn into something else: empty, typed (bool/null/number/date), indicator-led, control chars. */
const YAML_TYPED_RE =
  /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[-+]?\d+)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|[-+]?\.(?:inf|nan)|\d{4}-\d\d?-\d\d?)$/i
const YAML_UNSAFE_RE = /^$|^[-?,[\]{}&*!|>'"%@`]|[\u0000-\u001f\u007f\u0085\u2028\u2029]/
const DQ_ESCAPE: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** A string as a one-line YAML scalar: plain when that reads back as the same string, else double-quoted. */
function yamlString(value: string): string {
  const quote = /[:#]|^\s|\s$/.test(value) || YAML_UNSAFE_RE.test(value) || YAML_TYPED_RE.test(value)
  if (!quote) return value
  const escaped = value.replace(
    /[\\"\u0000-\u001f\u007f\u0085\u2028\u2029]/g,
    (c) => DQ_ESCAPE[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  return `"${escaped}"`
}

/**
 * Return `text` with its top-level `description` set to `description`. Only that
 * entry changes: a multi-line value is replaced whole, and stray duplicate entries are
 * dropped so exactly one remains. Every other line keeps its bytes and its place, and
 * the body is never touched (`splitSkillDoc(result).body` equals the input's).
 * A missing key goes right after `name` (else after the last line); a file without
 * frontmatter gets a new block on top. The value is YAML double-quoted when it
 * contains `:` or `#`, has leading/trailing whitespace, or would otherwise not read
 * back as that exact string (empty, `true`, `42`, `[x]`, control characters).
 */
export function setSkillDescription(text: string, description: string): string {
  const entry = `description: ${yamlString(description)}`
  const fm = readFrontmatterLines(text)
  if (!fm) {
    const nl = text.indexOf('\n')
    const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n'
    return `---${eol}${entry}${eol}---${eol}${text}`
  }

  const { open, lines, texts, pad, rest } = fm
  const [first, ...dupes] = topLevelEntries(fm, DESCRIPTION_KEY_RE)
  if (first) {
    for (const d of dupes.reverse()) lines.splice(d.start, d.end - d.start)
    const keyLine = lines[first.start]
    lines.splice(first.start, first.end - first.start, keyLine.slice(0, indentOf(keyLine)) + entry + eolOf(keyLine))
  } else {
    const [name] = topLevelEntries(fm, NAME_KEY_RE)
    let at = name ? name.end : texts.length
    if (!name) while (at > 0 && texts[at - 1].trim() === '') at--
    lines.splice(at, 0, pad + entry + eolOf(at > 0 ? lines[at - 1] : open))
  }
  return open + lines.join('') + rest
}

const DQ_UNESCAPE: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
}

/** Decode a one-line YAML scalar: double-quoted (escapes), single-quoted (`''`), or plain (a ` #` comment dropped). */
function decodeYamlScalar(raw: string): string {
  const s = raw.trim()
  const dq = /^"((?:[^"\\]|\\[\s\S])*)"/.exec(s)
  if (dq) {
    return dq[1].replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[\s\S])/g, (esc, code: string) => {
      if (code.length === 1) return DQ_UNESCAPE[code] ?? esc
      const cp = parseInt(code.slice(1), 16)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : esc
    })
  }
  const sq = /^'((?:[^']|'')*)'/.exec(s)
  if (sq) return sq[1].replace(/''/g, "'")
  const comment = s.search(/(?:^|\s)#/)
  return comment === -1 ? s : s.slice(0, comment).trimEnd()
}

/**
 * The top-level description as plain text: the exact inverse of setSkillDescription
 * (quotes and escapes decoded, a plain value's `# comment` dropped, a multi-line value
 * folded onto one line). Bind the description field to this, not to
 * parseSkillMeta().description: that returns quoted text raw, so a value
 * setSkillDescription had to escape (`"`, `\`) would show its backslashes and get
 * escaped again on the next edit. Null when there is no description key or no frontmatter.
 */
export function readSkillDescription(text: string): string | null {
  const fm = readFrontmatterLines(text)
  const entry = fm ? topLevelEntries(fm, DESCRIPTION_KEY_RE)[0] : undefined
  if (!fm || !entry) return null
  const [head, ...more] = fm.texts.slice(entry.start, entry.end)
  const value = head.slice(head.indexOf(':') + 1).trim().replace(/^#.*/, '')
  const continuation = more.map((l) => l.trim()).filter(Boolean)
  if (BLOCK_SCALAR_RE.test(value)) return continuation.join(' ')
  return decodeYamlScalar([value, ...continuation].join(' '))
}
