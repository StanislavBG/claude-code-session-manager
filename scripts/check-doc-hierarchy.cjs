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
//     CLAUDE.md / AGENTS.md (tree-DAG), except files under EXEMPT_PREFIXES
//     (historical ones from .session-manager.json mdNetwork.history);
//  7. every row of architecture/model-mitigations.md (when present) names a
//     location file that exists and still contains the row's needle verbatim.
//
// The MAP is root AGENTS.md when it exists (so Codex and other CLIs read the
// same file), else root CLAUDE.md. A listed junction of the CLAUDE.md /
// AGENTS.md pair is met by either file in that folder (a folder not yet migrated
// keeps only its CLAUDE.md).
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

// Historical folders are declared once, in the tracked .session-manager.json's
// mdNetwork.history (the app's MD network scan reads the same list).
const CONFIG_FILE = '.session-manager.json'
function readHistoryPrefixes() {
  const bad = (why) => {
    console.error(`doc-hierarchy: FAIL ${CONFIG_FILE}: ${why} (it must declare mdNetwork.history as a string array)`)
    process.exit(1)
  }
  let text
  try { text = fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8') } catch (err) { return bad(`unreadable: ${err.code || err.message}`) }
  let parsed
  try { parsed = JSON.parse(text) } catch (err) { return bad(`invalid JSON: ${err.message}`) }
  const history = parsed && typeof parsed === 'object' && parsed.mdNetwork && typeof parsed.mdNetwork === 'object' ? parsed.mdNetwork.history : undefined
  if (!Array.isArray(history) || !history.every((p) => typeof p === 'string')) return bad('mdNetwork.history is not a string array')
  return history
}

// Markdown the reachability check (6) does not require a link to.
const EXEMPT_PREFIXES = [
  ...readHistoryPrefixes(), // historical
  'src/seed/', // seeded
  'plugins/session-manager-dev/skills/', // tool-loaded
  'plugins/packs/', // tool-loaded (context packs, --plugin-dir)
  '.claude/agents/', // tool-loaded
  'src/main/templates/', // seeded
  '.github/', // github
  'README.md', // github (repo landing page)
  'CODE_OF_CONDUCT.md', // github
  'CONTRIBUTING.md', // github
  'SECURITY.md', // github
]

const JUNCTIONS = [
  'AGENTS.md',
  'README.md',
  'src/AGENTS.md',
  'src/renderer/AGENTS.md',
  'scripts/README.md',
  'tests/README.md',
  'web/README.md',
  'web/remote-app/AGENTS.md',
  'web-remote/AGENTS.md',
  'plugins/AGENTS.md',
  `${OPS}/AGENTS.md`,
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

/** The other file of a folder's CLAUDE.md / AGENTS.md pair, else null. */
function pairSibling(f) {
  const base = path.posix.basename(f)
  const other = base === 'CLAUDE.md' ? 'AGENTS.md' : base === 'AGENTS.md' ? 'CLAUDE.md' : null
  return other ? path.posix.join(path.posix.dirname(f), other) : null
}

// (1) manifest
// A gitignored namespace folder with no tracked file exists only in the main checkout:
// it holds machine-local runtime state (agents/, events/) or a retired namespace's
// leftovers (feedback/). By design it has no README, so it is a note, not a failure.
// "Gitignored" covers both `ns/` (the folder) and `ns/*` (self-ignored contents:
// something on disk is ignored and nothing is untracked-but-unignored).
const gitLines = (args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').split('\n').filter(Boolean) : null
}
function hasTrackedFiles(relDir) {
  const out = gitLines(['ls-files', '--', relDir])
  return out === null || out.length > 0
}
function isIgnoredNamespace(relDir) {
  if (isGitIgnored(path.join(ROOT, relDir))) return true
  const ignored = gitLines(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', relDir])
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard', '--', relDir])
  return !!ignored && ignored.length > 0 && !!untracked && untracked.length === 0
}
const manifest = [...JUNCTIONS]
for (const ns of listDirs(path.join(ROOT, OPS)).sort()) {
  if (isIgnoredNamespace(`${OPS}/${ns}`) && !hasTrackedFiles(`${OPS}/${ns}`)) {
    console.log(`doc-hierarchy: note: ${OPS}/${ns}/: namespace folder is gitignored with no tracked files (excluded)`)
    continue
  }
  manifest.push(`${OPS}/${ns}/README.md`)
}
for (const f of manifest) {
  if (exists(f)) continue
  const sib = pairSibling(f)
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
  const sib = pairSibling(f)
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
    // A reached pair file reaches its sibling: CLAUDE.md imports AGENTS.md (@AGENTS.md
    // stub rule, check 2), and a linked AGENTS.md is loaded through its CLAUDE.md stub.
    const sib = pairSibling(f)
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

// (7) model-mitigations registry: a workaround whose quoted text moved or vanished is stale.
// Row shape: | MM-<n> | behavior | model | observed | `location` | `needle` |
const MITIGATIONS = `${OPS}/architecture/model-mitigations.md`
if (exists(MITIGATIONS)) {
  const unquote = (cell) => cell.trim().replace(/^`(.*)`$/, '$1')
  let rows = 0
  for (const line of fs.readFileSync(path.join(ROOT, MITIGATIONS), 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1)
    const id = (cells[0] || '').trim()
    if (!/^MM-\d+$/.test(id)) continue
    rows++
    if (cells.length !== 6) { fail(`${MITIGATIONS}: ${id}: row has ${cells.length} cells, expected 6 (id, behavior, model, observed, location, needle)`); continue }
    const location = unquote(cells[4])
    const needle = unquote(cells[5])
    if (!location || !needle) { fail(`${MITIGATIONS}: ${id}: empty location or needle`); continue }
    const abs = path.resolve(ROOT, location)
    if (!abs.startsWith(ROOT + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { fail(`${MITIGATIONS}: ${id}: location file missing: ${location}`); continue }
    if (!fs.readFileSync(abs, 'utf8').includes(needle)) fail(`${MITIGATIONS}: ${id}: needle not found in ${location}: ${needle}`)
  }
  if (!rows) fail(`${MITIGATIONS}: no mitigation rows found (expected | MM-<n> | ... | rows)`)
}

if (failures.length) {
  for (const f of failures) console.error(`doc-hierarchy: FAIL ${f}`)
  process.exit(1)
}
console.log(`doc-hierarchy: ok (${manifest.length} junctions, ${linted.size} files linted)`)
