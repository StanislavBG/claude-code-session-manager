#!/usr/bin/env node
'use strict'

// Lint: no direct `.status =` write under src/main outside the lifecycle chokepoints
// (scheduleJobTransitions.cjs for jobs, epicTransitions.cjs + epicMint.cjs for Epics,
// taskLedger.cjs for Tasks). A bare write skips the legality check, statusHistory and
// audit trail those modules own. Proven non-lifecycle writes (display rows, inbox items,
// error kinds) are listed in scripts/status-write-allowlist.json with a reason each,
// matched by file + trimmed-line substring so the entry survives line drift.
// Mirrors scripts/check-ops-path-literals.cjs. Dev-only: not in package.json `files`.
// Complexity: O(total bytes) — one pass over every scanned file.

const fs = require('fs')
const path = require('path')

const OWNERS = new Set([
  'src/main/lib/scheduler/scheduleJobTransitions.cjs',
  'src/main/lib/epic/epicTransitions.cjs',
  'src/main/lib/epic/epicMint.cjs',
  'src/main/lib/tasks/taskLedger.cjs',
])
const SCAN_DIR = 'src/main'
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist'])
const FILE_RE = /\.(?:cjs|mjs|js|ts)$/
// `.status =` / `?.status =` but not `==`, `===`, `=>`.
const WRITE_RE = /\??\.status\s*=(?![=>])/
const ALLOWLIST_PATH = path.join(__dirname, 'status-write-allowlist.json')

function loadAllowlist(file = ALLOWLIST_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entries = Array.isArray(raw.entries) ? raw.entries : []
  for (const e of entries) {
    if (!e || typeof e.file !== 'string' || typeof e.match !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) {
      throw new Error(`status-write-allowlist: every entry needs file, match and a non-empty reason: ${JSON.stringify(e)}`)
    }
  }
  return entries
}

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

// Returns { violations: [{ file, line, text }], unused: [entry] }. `allowlist` overridable for tests.
function scan(root, { allowlist = loadAllowlist() } = {}) {
  const violations = []
  const used = new Set()
  const files = []
  walk(path.join(root, SCAN_DIR), files)
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    if (OWNERS.has(rel)) continue
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (!WRITE_RE.test(line)) return
      const hit = allowlist.find((e) => e.file === rel && t.includes(e.match))
      if (hit) { used.add(hit); return }
      violations.push({ file: rel, line: i + 1, text: t.slice(0, 140) })
    })
  }
  return { violations, unused: allowlist.filter((e) => !used.has(e)) }
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const allowlistArg = process.argv[3]
  const { violations, unused } = scan(root, { allowlist: loadAllowlist(allowlistArg ? path.resolve(allowlistArg) : ALLOWLIST_PATH) })
  for (const e of unused) console.warn(`check-status-writes: stale allowlist entry (no match): ${e.file}: ${e.match}`)
  if (violations.length === 0) {
    console.log('check-status-writes: clean')
    return
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}: direct .status write outside the lifecycle modules — use transitionJob/epicTransitions/taskLedger, or allowlist a non-lifecycle use in scripts/status-write-allowlist.json: ${v.text}`)
  }
  console.error(`check-status-writes: ${violations.length} violation(s)`)
  process.exit(1)
}

if (require.main === module) main()
module.exports = { scan, loadAllowlist, OWNERS, WRITE_RE }
