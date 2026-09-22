#!/usr/bin/env node
'use strict'

// Ratchet lint for the stateless-UI-review Epic: nothing under src/renderer/** may call
// `localStorage.`/`sessionStorage.` except the files listed below, each with a reason. New
// files must route persistence through disk-backed storage (session-manager-operations/) instead
// of browser storage. Sibling PRDs shrink this allowlist as each file migrates.
// Complexity: O(total bytes) — one pass over every scanned file.

const fs = require('fs')
const path = require('path')

const SCAN_DIRS = ['src/renderer']
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist'])
const FILE_RE = /\.tsx?$/
const STORAGE_RE = /localStorage\.|sessionStorage\./

// repo-relative path -> reason this file may still call localStorage/sessionStorage directly.
const ALLOWLIST = new Map([
  ['src/renderer/lib/rawSessionModel.ts', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/lib/terminalSettings.ts', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/state/editorPrefs.ts', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/components/layout/FileTree.tsx', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/components/tabs/ProjectsWorkspace.tsx', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/components/tabs/HistoryDashboard.tsx', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/components/tabs/history/analytics/BudgetStrip.tsx', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/components/tabs/Scheduler.tsx', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/components/SchedulePanel.tsx', 'pending migration, Epic stateless-ui-review'],
  ['src/renderer/components/tabs/Memory.tsx', 'pending migration, Epic stateless-ui-review'],
])

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

// Returns [{ file (root-relative, posix), line, text }]. `allowlist` is overridable for tests.
function scan(root, { allowlist = ALLOWLIST } = {}) {
  const violations = []
  const files = []
  for (const d of SCAN_DIRS) walk(path.join(root, d), files)
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    if (allowlist.has(rel)) continue
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (STORAGE_RE.test(line)) violations.push({ file: rel, line: i + 1, text: t.slice(0, 140) })
    })
  }
  return violations
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const violations = scan(root)
  if (violations.length === 0) {
    console.log('check-renderer-storage: clean')
    return
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}: localStorage/sessionStorage used outside ALLOWLIST — migrate to disk-backed storage: ${v.text}`)
  }
  console.error(`check-renderer-storage: ${violations.length} violation(s)`)
  process.exit(1)
}

if (require.main === module) main()
module.exports = { scan, ALLOWLIST }
