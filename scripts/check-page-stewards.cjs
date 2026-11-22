#!/usr/bin/env node
'use strict'

// Every nav page has a steward subagent `.claude/agents/page-<key>.md`; the charter is
// session-manager-operations/architecture/page-stewards.md. Ratchet: PENDING only excuses a
// MISSING persona (an existing one is always validated and its PENDING entry is a violation),
// so it may only shrink.
// Complexity: O(pages + agent files) — one stat/read per page, one directory listing.

const fs = require('fs')
const path = require('path')
const { listPages } = require('./page-surface.cjs')

const AGENTS_DIR = '.claude/agents'
const CHARTER = 'session-manager-operations/architecture/page-stewards.md'

// page key -> reason its steward persona may still be absent.
const PENDING = new Map(
  ['project-home', 'terminal', 'scheduler', 'memory'].map((k) => [k, 'project-face steward not yet created']),
)

// Returns { fm: {key: value}, body } or null when the --- fence is not opened and closed.
function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) return null
  const fm = {}
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(l)
    if (m) fm[m[1]] = m[2].trim()
  }
  return { fm, body: lines.slice(end + 1).join('\n') }
}

function validate(key, rel, text) {
  const out = []
  const bad = (msg) => out.push({ file: rel, message: `${key}: ${msg}` })
  const parsed = parseFrontmatter(text)
  if (!parsed) {
    bad('frontmatter must open and close with a --- fence')
    return out
  }
  const { fm, body } = parsed
  const want = `page-${key}`
  if (fm.name !== want) bad(`name must be "${want}" (got "${fm.name ?? ''}")`)
  if (!fm.description) bad('description must be non-empty')
  if (!('tools' in fm)) bad('tools is required')
  if (!fm.model || fm.model === 'inherit') bad('model must be set and not "inherit"')
  if (!body.includes(CHARTER)) bad(`body must reference ${CHARTER}`)
  if (!body.includes(`scripts/page-surface.cjs ${key}`)) bad(`body must reference "scripts/page-surface.cjs ${key}"`)
  return out
}

// Returns [{ file, message }]. `pages` and `pending` are overridable for tests.
function scan(root, { pages = listPages(root), pending = PENDING } = {}) {
  const violations = []
  const keys = new Set(pages.map((p) => p.key))
  for (const { key } of pages) {
    const rel = `${AGENTS_DIR}/page-${key}.md`
    let text
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      if (!pending.has(key)) violations.push({ file: rel, message: `${key}: missing steward persona ${rel}` })
      continue
    }
    if (pending.has(key)) violations.push({ file: rel, message: `${key}: in PENDING but ${rel} exists — remove it from PENDING` })
    violations.push(...validate(key, rel, text))
  }
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, AGENTS_DIR))
  } catch {
    entries = []
  }
  for (const name of entries) {
    const m = /^page-(.+)\.md$/.exec(name)
    if (m && !keys.has(m[1])) {
      violations.push({ file: `${AGENTS_DIR}/${name}`, message: `${m[1]}: orphan steward persona — no such page key` })
    }
  }
  return violations
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const violations = scan(root)
  if (violations.length === 0) {
    console.log('check-page-stewards: clean')
    return
  }
  for (const v of violations) console.error(`${v.file}: ${v.message}`)
  console.error(`check-page-stewards: ${violations.length} violation(s)`)
  process.exit(1)
}

if (require.main === module) main()
module.exports = { scan, PENDING }
