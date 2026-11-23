#!/usr/bin/env node
'use strict'

// Self-policing lint for the event log's single-writer law: src/main/lib/epic/epicEventLog.cjs
// is THE ONLY writer of a project's `events/` ops namespace (writer id 'event-log' in
// opsOwnership.cjs). Any other file under src/ or scripts/ that makes a write call targeting
// an 'events.jsonl' file or opsPath(..., 'events', ...) fails with file:line.
//
// Detection, per file, one pass:
//   - a write call (writeFile/appendFile/createWriteStream/atomicWrite*/rename/copyFile/...)
//     whose line also spells a target ('events.jsonl' literal or opsPath(..., 'events', ...)), or
//   - a write call whose line names a variable earlier assigned from a target expression
//     (`const f = opsPath(cwd, 'events', id, 'events.jsonl')` ... `fs.appendFile(f, ...)`).
// Comment lines are ignored. Exempt: the writer, its tests, this file, and this lint's test.
// Mirrors scripts/check-ops-path-literals.cjs. Dev-only: not in package.json `files`.
// Complexity: O(total bytes).

const fs = require('fs')
const path = require('path')

const WRITER_REL = 'src/main/lib/epic/epicEventLog.cjs'
const SCAN_DIRS = ['src', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist'])
const FILE_RE = /\.(?:cjs|mjs|js|ts|tsx)$/
const EXEMPT = new Set([
  WRITER_REL,
  'scripts/check-event-log-writers.cjs',
  'scripts/__tests__/check-event-log-writers.test.cjs',
])
// The writer's own tests: src/main/lib/epic/__tests__/epicEventLog*.test.cjs
const WRITER_TEST_RE = /^src\/main\/lib\/epic\/__tests__\/epicEventLog[\w.-]*\.test\.c?[jt]s$/

const TARGET_RE = /['"`]events\.jsonl['"`]|\bopsPath\s*\([^)]*['"`]events['"`]/
const WRITE_RE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|atomicWrite\w*|writeAtomic\w*|writeJson\w*|appendJsonl?\w*|rename|renameSync|copyFile|copyFileSync|truncate|truncateSync)\s*\(/
const ASSIGN_RE = /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?!=)/

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out)
    } else if (e.isFile() && FILE_RE.test(e.name)) out.push(full)
  }
}

function isComment(t) {
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

// One file's text -> [{ line, text }] of write calls targeting the event log.
function scanText(text) {
  const hits = []
  const tainted = new Set()
  text.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t || isComment(t)) return
    const targets = TARGET_RE.test(line)
    if (targets) {
      const m = ASSIGN_RE.exec(line)
      if (m && line.indexOf(m[0]) < line.search(TARGET_RE)) tainted.add(m[1])
    }
    if (!WRITE_RE.test(line)) return
    let hit = targets
    if (!hit) for (const v of tainted) if (new RegExp(`(?<![\\w$.])${v.replace(/\$/g, '\\$')}(?![\\w$])`).test(line)) { hit = true; break }
    if (hit) hits.push({ line: i + 1, text: t.slice(0, 140) })
  })
  return hits
}

// Returns [{ file (root-relative, posix), line, text }].
function scan(root) {
  const violations = []
  const files = []
  for (const d of SCAN_DIRS) walk(path.join(root, d), files)
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    if (EXEMPT.has(rel) || WRITER_TEST_RE.test(rel)) continue
    for (const h of scanText(fs.readFileSync(f, 'utf8'))) violations.push({ file: rel, ...h })
  }
  return violations
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const v = scan(root)
  if (v.length === 0) {
    console.log('check-event-log-writers: clean')
    return
  }
  for (const x of v) console.error(`${x.file}:${x.line}: event-log write outside ${WRITER_REL} — append via epicEventLog: ${x.text}`)
  console.error(`check-event-log-writers: ${v.length} violation(s)`)
  process.exit(1)
}

if (require.main === module) main()
module.exports = { scan, scanText, WRITER_REL }
