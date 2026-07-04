/**
 * Skill enable/disable via the canonical Claude Code frontmatter flag.
 *
 * Turning a skill "off" means setting `disable-model-invocation: true` in its
 * SKILL.md frontmatter — the field the CLI actually reads to stop auto-invoking
 * a skill. (Our old per-project `project-skills.json` toggle wrote a sidecar the
 * CLI never read, so it disabled nothing.) Edits are surgical: only the one key
 * line is added/updated/removed; every other frontmatter line round-trips
 * verbatim. No YAML library — a single-key mutation doesn't need one.
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
