#!/usr/bin/env node
'use strict'

// Keeps the markdown hierarchy honest (nothing else lints .md outside
// session-manager-operations/). Checks, one diagnostic line per failure:
//  1. every JUNCTIONS file (+ every ops <namespace>/README.md on disk) exists;
//  2. every nested folder's CLAUDE.md + AGENTS.md <= 4000 bytes together; the
//     root pair within the map's SIZE BUDGET (health.cjs's
//     evaluateRootClaudeMdBudget); a CLAUDE.md beside an AGENTS.md must be a
//     stub whose first non-blank line is @AGENTS.md;
//  3. every relative markdown link in the junctions + architecture/*.md resolves;
//  4. no file:// link in those files;
//  5. every path in the map's "Scoped MDs" table resolves;
//  6. every tracked *.md is reachable by relative links from the root
//     CLAUDE.md / AGENTS.md (tree-DAG), except files under EXEMPT_PREFIXES.
//
// The MAP is root AGENTS.md when it exists (so Codex and other CLIs read the
// same file), else root CLAUDE.md. A listed CLAUDE.md junction is also met by
// an AGENTS.md in the same folder.
//
// Root dir: first CLI argument or SM_DOC_ROOT (tests point it at a scratch
// tree); defaults to the repo. Complexity: O(files x links), all small.

const fs = require('fs')
const { spawnSync, execFileSync } = require('child_process')
const path = require('path')
const { evaluateRootClaudeMdBudget } = require('../src/main/health.cjs')
// The link convention (what counts as a link, outside code fences, inline code and comments) is written once here.
const { linksOf, rawLinksOf, followLink, visibleText } = require('../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdLinks.cjs')

const ROOT = path.resolve(process.argv[2] || process.env.SM_DOC_ROOT || path.join(__dirname, '..'))
const OPS = 'session-manager-operations'
const NESTED_CLAUDE_MD_MAX_BYTES = 4000

// Markdown the reachability check (6) does not require a link to.
const EXEMPT_PREFIXES = [
  'session-manager-operations/reviews/', // historical
  'session-manager-operations/design-mocks/', // historical
  'session-manager-operations/HUMAN_LEARN/', // historical
  'src/seed/', // seeded
  'plugins/session-manager-dev/skills/', // tool-loaded
  'plugins/packs/', // tool-loaded (context packs, --plugin-dir)
  '.claude/agents/', // tool-loaded
  'web/promo-video/', // historical
  'src/main/templates/', // seeded
  '.github/', // github
  'README.md', // github (repo landing page)
  'CODE_OF_CONDUCT.md', // github
  'CONTRIBUTING.md', // github
  'SECURITY.md', // github
]

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
  `${OPS}/CLAUDE.md`,
  `${OPS}/architecture/README.md`,
]

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

/** Every folder (abs path) holding a CLAUDE.md or AGENTS.md, ROOT included. */
function findMapFolders(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findMapFolders(p, out)
    else if ((e.name === 'CLAUDE.md' || e.name === 'AGENTS.md') && !out.includes(dir)) out.push(dir)
  }
  return out
}

/** The entry map: root AGENTS.md when present, else root CLAUDE.md. */
function mapFile() {
  return exists('AGENTS.md') ? 'AGENTS.md' : 'CLAUDE.md'
}

/** A listed CLAUDE.md junction's sibling AGENTS.md, else null. */
function agentsSibling(f) {
  return path.posix.basename(f) === 'CLAUDE.md' ? path.posix.join(path.posix.dirname(f), 'AGENTS.md') : null
}

// (1) manifest
const manifest = [...JUNCTIONS]
for (const ns of listDirs(path.join(ROOT, OPS)).sort()) manifest.push(`${OPS}/${ns}/README.md`)
for (const f of manifest) {
  if (exists(f)) continue
  const sib = agentsSibling(f)
  if (sib && exists(sib)) continue
  fail(`missing junction: ${f}`)
}

// (2) budgets + stub rule
for (const dir of findMapFolders(ROOT, []).sort()) {
  const claude = path.join(dir, 'CLAUDE.md')
  const agents = path.join(dir, 'AGENTS.md')
  const present = [claude, agents].filter((p) => fs.existsSync(p))
  if (fs.existsSync(claude) && fs.existsSync(agents)) {
    const first = fs.readFileSync(claude, 'utf8').split(/\r?\n/).find((l) => l.trim() !== '')
    if ((first || '').trim() !== '@AGENTS.md') fail(`${rel(claude)}: has an AGENTS.md beside it, so its first non-blank line must be @AGENTS.md`)
  }
  if (dir === ROOT) continue
  const bytes = present.reduce((n, p) => n + fs.statSync(p).size, 0)
  if (bytes > NESTED_CLAUDE_MD_MAX_BYTES) fail(`${present.map(rel).join(' + ')} is ${bytes} bytes, over the ${NESTED_CLAUDE_MD_MAX_BYTES}-byte nested CLAUDE.md limit`)
}
{
  const res = evaluateRootClaudeMdBudget(ROOT)
  if (!res.ok) fail(`${mapFile()}: ${res.message}`)
}

// (3)+(4) links
const linted = new Set(manifest.filter((f) => exists(f)))
for (const f of manifest) {
  const sib = agentsSibling(f)
  if (sib && exists(sib)) linted.add(sib)
}
const archDir = path.join(ROOT, OPS, 'architecture')
try {
  for (const f of fs.readdirSync(archDir)) if (f.endsWith('.md')) linted.add(`${OPS}/architecture/${f}`)
} catch { /* no architecture dir: already reported as missing junction */ }

/** A doc's text with code fences, inline code and HTML comments blanked (mdLinks.visibleText). */
function visibleDoc(text) {
  const state = { fence: '', inComment: false }
  return text.split(/\r?\n/).map((line) => visibleText(line, state)).join('\n')
}

for (const f of [...linted].sort()) {
  const abs = path.join(ROOT, f)
  const source = fs.readFileSync(abs, 'utf8')
  for (const { line, raw } of rawLinksOf(source)) {
    const target = raw.trim()
    if (/^file:\/\//i.test(target)) { fail(`${f}: file:// link: ${target}`); continue }
    const link = followLink(f, target, line)
    if (!link) continue // URL, #anchor or /rooted target
    const resolved = path.resolve(ROOT, link.to)
    if (fs.existsSync(resolved)) continue
    if (isGitIgnored(resolved)) { console.log(`doc-hierarchy: note: ${f}: link target is gitignored and absent (excluded): ${target}`); continue }
    fail(`${f}: broken relative link: ${target}`)
  }
  for (const m of visibleDoc(source).matchAll(/file:\/\/[^\s)>\]]*/gi)) {
    if (!failures.includes(`${f}: file:// link: ${m[0]}`)) fail(`${f}: file:// link: ${m[0]}`)
  }
}

// (5) scoped-MD table rows in the map
const MAP = mapFile()
if (exists(MAP)) {
  const lines = fs.readFileSync(path.join(ROOT, MAP), 'utf8').split('\n')
  const start = lines.findIndex((l) => /^##\s+Scoped MDs/.test(l))
  if (start === -1) fail(`${MAP}: no "Scoped MDs" table found`)
  else {
    for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
      if (!lines[i].startsWith('|')) continue
      const firstCell = lines[i].split('|')[1] || ''
      // Link targets win; backticked text is a path only where the cell has no links.
      const links = linksOf({ path: MAP, text: firstCell }).map((l) => l.to)
      const paths = links.length ? links : [...firstCell.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1])
      for (const p of paths) {
        if (/^(https?:|mailto:|file:)/i.test(p)) continue
        if (!exists(p)) fail(`${MAP}: scoped-MD row does not resolve: ${p}`)
      }
    }
  }
}

// (6) reachability from root CLAUDE.md + AGENTS.md
function listMarkdown() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\0').filter(Boolean)
  } catch { /* not a git repo: walk */ }
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) out.push(rel(p))
    }
  }
  walk(ROOT)
  return out
}

const roots = ['CLAUDE.md', 'AGENTS.md'].filter((f) => exists(f))
if (roots.length) {
  const reached = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    const f = queue.shift()
    // A reached CLAUDE.md imports its sibling AGENTS.md (@AGENTS.md stub rule, check 2).
    const sib = agentsSibling(f)
    if (sib && exists(sib) && !reached.has(sib)) { reached.add(sib); queue.push(sib) }
    const abs = path.join(ROOT, f)
    for (const link of linksOf({ path: f, text: fs.readFileSync(abs, 'utf8') })) {
      if (link.escapes || !link.to.toLowerCase().endsWith('.md')) continue
      const target = path.resolve(ROOT, link.to)
      if (!target.startsWith(ROOT + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) continue
      const r = rel(target)
      if (!reached.has(r)) { reached.add(r); queue.push(r) }
    }
  }
  for (const f of listMarkdown().sort()) {
    if (reached.has(f) || EXEMPT_PREFIXES.some((x) => f.startsWith(x))) continue
    fail(`${f}: orphan markdown, not reachable by links from ${roots.join(' / ')}`)
  }
}

if (failures.length) {
  for (const f of failures) console.error(`doc-hierarchy: FAIL ${f}`)
  process.exit(1)
}
console.log(`doc-hierarchy: ok (${manifest.length} junctions, ${linted.size} files linted)`)
