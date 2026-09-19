#!/usr/bin/env node
'use strict'

// Self-policing lint for the ops-root path invariant (PRD 1082): nothing under
// src/main/** or scripts/** may spell the quoted literal 'session-manager-operations'
// except src/main/lib/opsOwnership.cjs (the one resolver — opsPath()/resolveOpsRoot()).
// Files that legitimately can't route through it are allowlisted below with a reason
// (same convention as check-unregistered-tests.cjs). Dev-only: not in package.json `files`.
//
// scan(root) is also required by scripts/ops-sweep.cjs (OPS_PATH_LITERAL) with an
// explicit root so that skill still runs against any target project.
// Complexity: O(total bytes) — one pass over every scanned file.

const fs = require('fs')
const path = require('path')

const RESOLVER_REL = 'src/main/lib/opsOwnership.cjs'
const SELF_REL = 'scripts/check-ops-path-literals.cjs'
const SCAN_DIRS = ['src/main', 'scripts']
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist'])
const FILE_RE = /\.(?:cjs|mjs|js)$/
const LITERAL_RE = /(['"])session-manager-operations\1/

// repo-relative path -> reason this file may spell the literal. Whole-file entries.
const ALLOWLIST = new Map([
  ['src/main/lib/cwdClassify.cjs', 'pure cwd classifier: matches the dirname as a path segment, has no project root to resolve'],
  ['scripts/ops-sweep.cjs', "portable across target projects: builds the ops root of an arbitrary targetCwd, cannot import that project's resolver"],
  ['scripts/audit-ops-hygiene.cjs', 'standalone CLI audit script run against a project cwd; not part of the app runtime'],
  ['scripts/check-doc-hierarchy.cjs', 'standalone lint that walks the repo tree for ops docs; no runtime resolver needed'],
  ['scripts/cleanup-worktree-ops-stubs.cjs', 'one-shot cleanup that matches stray ops dirnames inside worktrees; must not normalize them away'],
  ['scripts/cleanup-nested-queue-stubs.cjs', 'one-shot cleanup that detects the doubled ops dirname; must not normalize it away'],
  ['scripts/hooks/guard-inline-implementation.cjs', 'installed to ~/.claude/session-manager/hooks via shim; runs outside the repo and cannot require opsOwnership'],
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
    if (rel === RESOLVER_REL || rel === SELF_REL || allowlist.has(rel)) continue
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (LITERAL_RE.test(line)) violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 140) })
    })
  }
  return violations
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const violations = scan(root)
  if (violations.length === 0) {
    console.log('check-ops-path-literals: clean')
    return
  }
  for (const v of violations) console.error(`${v.file}:${v.line}: ops-root literal outside ${RESOLVER_REL} — use opsPath(): ${v.text}`)
  console.error(`check-ops-path-literals: ${violations.length} violation(s)`)
  process.exit(1)
}

if (require.main === module) main()
module.exports = { scan, ALLOWLIST }
