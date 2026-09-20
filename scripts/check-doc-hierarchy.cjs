#!/usr/bin/env node
'use strict'

// Keeps the markdown hierarchy honest (nothing else lints .md outside
// session-manager-operations/). Checks, one diagnostic line per failure:
//  1. every JUNCTIONS file (+ every ops <namespace>/README.md on disk) exists;
//  2. every nested CLAUDE.md <= 4000 bytes; root CLAUDE.md within its own
//     SIZE BUDGET (health.cjs's parseClaudeMdBudget/evaluateClaudeMdBudget);
//  3. every relative markdown link in the junctions + architecture/*.md resolves;
//  4. no file:// link in those files;
//  5. every path in the root CLAUDE.md "Scoped MDs" table resolves.
//
// Root dir: first CLI argument or SM_DOC_ROOT (tests point it at a scratch
// tree); defaults to the repo. Complexity: O(files x links), all small.

const fs = require('fs')
const { spawnSync } = require('child_process')
const path = require('path')
const { parseClaudeMdBudget, evaluateClaudeMdBudget } = require('../src/main/health.cjs')

const ROOT = path.resolve(process.argv[2] || process.env.SM_DOC_ROOT || path.join(__dirname, '..'))
const OPS = 'session-manager-operations'
const NESTED_CLAUDE_MD_MAX_BYTES = 4000

const JUNCTIONS = [
  'CLAUDE.md',
  'README.md',
  'src/CLAUDE.md',
  'src/renderer/CLAUDE.md',
  'scripts/README.md',
  'tests/README.md',
  'web/README.md',
  'web/remote-app/CLAUDE.md',
  'web-remote/CLAUDE.md',
  'plugins/CLAUDE.md',
  'docs/README.md',
  `${OPS}/CLAUDE.md`,
  `${OPS}/architecture/README.md`,
]

// Junctions whose authoring PRD has not landed yet. Kept in JUNCTIONS (the
// lint is meant to fail until they exist) but excluded from the gate.
// TODO(docs-readme-junction PRD, unqueued): docs/README.md does not exist yet.
const PENDING = new Set(['docs/README.md'])

const failures = []
const fail = (msg) => failures.push(msg)
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/')

// A link target that is absent but gitignored (a build output such as
// web/project-pages/, present in the main checkout, absent in a fresh job
// worktree) is a note, not a failure. Exit 0 = ignored; 1 or 128 (not a repo) = not.
function isGitIgnored(absPath) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', absPath], { cwd: ROOT, stdio: 'ignore' })
  return r.status === 0
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch { return [] }
}

function findNestedClaudeMds(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findNestedClaudeMds(p, out)
    else if (e.name === 'CLAUDE.md' && dir !== ROOT) out.push(p)
  }
  return out
}

// (1) manifest
const manifest = [...JUNCTIONS]
for (const ns of listDirs(path.join(ROOT, OPS)).sort()) manifest.push(`${OPS}/${ns}/README.md`)
for (const f of manifest) {
  if (exists(f)) continue
  if (PENDING.has(f)) { console.log(`doc-hierarchy: note: pending junction not yet landed (excluded): ${f}`); continue }
  fail(`missing junction: ${f}`)
}

// (2) budgets
for (const abs of findNestedClaudeMds(ROOT, [])) {
  const bytes = fs.statSync(abs).size
  if (bytes > NESTED_CLAUDE_MD_MAX_BYTES) fail(`${rel(abs)} is ${bytes} bytes, over the ${NESTED_CLAUDE_MD_MAX_BYTES}-byte nested CLAUDE.md limit`)
}
if (exists('CLAUDE.md')) {
  const text = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8')
  const res = evaluateClaudeMdBudget(Buffer.byteLength(text), parseClaudeMdBudget(text))
  if (!res.ok) fail(`CLAUDE.md: ${res.message}`)
}

// (3)+(4) links
const linted = new Set(manifest.filter((f) => exists(f)))
const archDir = path.join(ROOT, OPS, 'architecture')
try {
  for (const f of fs.readdirSync(archDir)) if (f.endsWith('.md')) linted.add(`${OPS}/architecture/${f}`)
} catch { /* no architecture dir: already reported as missing junction */ }

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

for (const f of [...linted].sort()) {
  const abs = path.join(ROOT, f)
  const text = stripCode(fs.readFileSync(abs, 'utf8'))
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) {
    const target = m[1]
    if (/^file:\/\//i.test(target)) { fail(`${f}: file:// link: ${target}`); continue }
    if (/^(https?:|mailto:|#)/i.test(target)) continue
    const p = target.split('#')[0]
    if (!p) continue
    const resolved = path.resolve(path.dirname(abs), p)
    if (fs.existsSync(resolved)) continue
    if (isGitIgnored(resolved)) { console.log(`doc-hierarchy: note: ${f}: link target is gitignored and absent (excluded): ${target}`); continue }
    fail(`${f}: broken relative link: ${target}`)
  }
  for (const m of text.matchAll(/file:\/\/[^\s)>\]]*/gi)) {
    if (!failures.includes(`${f}: file:// link: ${m[0]}`)) fail(`${f}: file:// link: ${m[0]}`)
  }
}

// (5) scoped-MD table rows in root CLAUDE.md
if (exists('CLAUDE.md')) {
  const lines = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').split('\n')
  const start = lines.findIndex((l) => /^##\s+Scoped MDs/.test(l))
  if (start === -1) fail('CLAUDE.md: no "Scoped MDs" table found')
  else {
    for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
      if (!lines[i].startsWith('|')) continue
      const firstCell = lines[i].split('|')[1] || ''
      // Link targets win; backticked text is a path only where the cell has no links.
      const links = [...firstCell.matchAll(/\]\(([^)\s#]+)/g)].map((m) => m[1])
      const paths = links.length ? links : [...firstCell.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1])
      for (const p of paths) {
        if (/^(https?:|mailto:|file:)/i.test(p) || PENDING.has(p)) continue
        if (!exists(p)) fail(`CLAUDE.md: scoped-MD row does not resolve: ${p}`)
      }
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`doc-hierarchy: FAIL ${f}`)
  process.exit(1)
}
console.log(`doc-hierarchy: ok (${manifest.length} junctions, ${linted.size} files linted)`)
