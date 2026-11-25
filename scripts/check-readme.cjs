#!/usr/bin/env node
'use strict'

// Fills generated regions from the code, so agent-facing facts can't go
// stale. One diagnostic line per failure. Two target files (TARGETS):
// README.md holds the recipes, counts and Node floor; the MCP tool table lives
// in session-manager-operations/architecture/mcp-tools.md (README.md has a
// 24000-byte budget, so the table was split out rather than raising it).
//
//   node scripts/check-readme.cjs          check; exit 1 if any region is stale
//   node scripts/check-readme.cjs --write  rewrite regions in place (idempotent)
//
// Block region:  <!-- gen:NAME -->            (own line)
//                ...generated...
//                <!-- /gen:NAME -->           (own line)
// Inline region: <!-- gen:NAME -->value<!-- /gen:NAME -->   (one line)
//
// Only text between markers is ever rewritten; everything else stays
// byte-identical. Unknown names, unclosed or duplicated regions exit 1.
//
// Check mode also proves the README is agent-friendly (one diagnostic line
// per failure): prose Flesch-Kincaid grade <= MAX_GRADE, only https:// or
// #anchor links, repo blob/tree links name tracked or untracked-not-ignored paths, every gen/list
// region exists, each ## section scores <= MAX_SECTION_GRADE, size <= MAX_BYTES,
// and <!-- list:NAME --> regions name exactly the skills / packs / personas.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { pathToFileURL } = require('url')

const MAX_GRADE = 8.0
const MAX_SECTION_GRADE = 8.0
const MAX_BYTES = 24000
const REPO_URL = 'https://github.com/StanislavBG/claude-code-session-manager'

const MCP_TOOLS_DOC = 'session-manager-operations/architecture/mcp-tools.md'
// Each file and the gen regions it must hold. renderRegions renders them all.
const TARGETS = [
  { file: 'README.md', regions: ['mcp-recipes', 'mcp-tool-count', 'skill-count', 'node-floor'] },
  { file: MCP_TOOLS_DOC, regions: ['mcp-tools'] },
]
const README_REGIONS = TARGETS[0].regions
const MARKER_RE = /<!-- (\/?)gen:([A-Za-z0-9_-]+) -->/g

function loadSources(repoRoot) {
  const { MCP_TOOL_CATALOG, MCP_RECIPES } = require(path.join(repoRoot, 'src', 'main', 'lib', 'mcpToolCatalog.cjs'))
  const { TOOLS } = require(path.join(repoRoot, 'scripts', 'scheduler-mcp-server.cjs'))
  const skillsDir = path.join(repoRoot, 'plugins', 'session-manager-dev', 'skills')
  const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort()
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const nodeFloor = String((pkg.engines && pkg.engines.node) || '').trim().replace(/^>=\s*/, '')
  return { catalog: MCP_TOOL_CATALOG, recipes: MCP_RECIPES, tools: TOOLS, skills, nodeFloor }
}

const cell = (s) => String(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
const code = (s) => '`' + cell(s) + '`'

function renderRegions(sources) {
  const byName = new Map((sources.tools || []).map((t) => [t.name, t]))
  const rows = sources.catalog.map((entry) => {
    const tool = byName.get(entry.name)
    const req = (tool && tool.inputSchema && tool.inputSchema.required) || []
    const oneOf = (entry.requiredOneOf || []).map((g) => 'one of ' + g.map(code).join(' / '))
    const parts = [...req.map(code), ...oneOf]
    const args = parts.length ? parts.join(', ') : '—'
    return `| ${code(entry.name)} | ${cell(entry.group)} | ${args} | ${cell(entry.summary)} |`
  })
  return {
    'mcp-tools': ['| Tool | Group | Required args | What it does |', '| --- | --- | --- | --- |', ...rows].join('\n'),
    'mcp-recipes': sources.recipes.map((r) => `- ${code(r.id)} — ${r.title}`).join('\n'),
    'mcp-tool-count': String(sources.catalog.length),
    'skill-count': String(sources.skills.length),
    'node-floor': String(sources.nodeFloor),
  }
}

function lineBounds(text, idx) {
  const start = text.lastIndexOf('\n', idx - 1) + 1
  let end = text.indexOf('\n', idx)
  if (end === -1) end = text.length
  return { start, end }
}

// True when the marker [from, to) is the only non-whitespace on its line.
function aloneOnLine(text, from, to) {
  const { start, end } = lineBounds(text, from)
  return text.slice(start, from).trim() === '' && text.slice(to, end).trim() === ''
}

function applyRegions(text, rendered, file = 'README.md') {
  const errors = []
  const stale = []
  const seen = new Set()
  const markers = [...text.matchAll(MARKER_RE)].map((m) => ({
    close: m[1] === '/', name: m[2], from: m.index, to: m.index + m[0].length,
  }))
  const edits = [] // { from, to, value }
  for (let i = 0; i < markers.length; i++) {
    const open = markers[i]
    if (open.close) { errors.push(`${file}: closing marker for region ${open.name} has no matching opening marker`); continue }
    const close = markers[i + 1]
    if (!close || !close.close || close.name !== open.name) {
      errors.push(`${file}: unclosed region ${open.name} (no <!-- /gen:${open.name} --> before the next marker)`)
      continue
    }
    i++
    if (seen.has(open.name)) { errors.push(`${file}: duplicate region ${open.name}`); continue }
    seen.add(open.name)
    if (!Object.prototype.hasOwnProperty.call(rendered, open.name)) {
      errors.push(`${file}: unknown region ${open.name}`)
      continue
    }
    const sameLine = lineBounds(text, open.from).start === lineBounds(text, close.from).start
    if (sameLine) {
      const value = rendered[open.name]
      if (value.includes('\n')) { errors.push(`${file}: region ${open.name} is multi-line; use block markers on their own lines`); continue }
      if (text.slice(open.to, close.from) !== value) { stale.push(open.name); edits.push({ from: open.to, to: close.from, value }) }
      continue
    }
    if (!aloneOnLine(text, open.from, open.to) || !aloneOnLine(text, close.from, close.to)) {
      errors.push(`${file}: region ${open.name} spans lines, so both markers must be on their own lines`)
      continue
    }
    const openEnd = lineBounds(text, open.from).end // index of '\n' after the opening marker
    const eol = text[openEnd - 1] === '\r' ? '\r\n' : '\n'
    const from = openEnd + 1
    const to = lineBounds(text, close.from).start
    const value = rendered[open.name].split('\n').join(eol) + eol
    if (text.slice(from, to) !== value) { stale.push(open.name); edits.push({ from, to, value }) }
  }
  if (errors.length) return { text, stale, errors }
  let out = text
  for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.value + out.slice(e.to)
  return { text: out, stale, errors }
}

// Pure decision for main(): what to print, what to write, which exit code.
function run(text, rendered, write, file = 'README.md') {
  const res = applyRegions(text, rendered, file)
  if (res.errors.length) return { code: 1, messages: res.errors, text }
  if (write) return { code: 0, messages: [], text: res.text, changed: res.text !== text }
  const messages = res.stale.map((n) => `${file} region ${n} is out of date. Run: npm run readme:build, then commit ${file}.`)
  return { code: messages.length ? 1 : 0, messages, text }
}

const pick = (obj, names) => Object.fromEntries(names.filter((n) => n in obj).map((n) => [n, obj[n]]))

// run() per TARGETS file: texts = { [file]: text | null }; a file only gets
// its own regions (a region in the wrong file is an unknown region). A
// missing required region is one line naming the file (null = file absent).
// README.md's own required-region check stays in runRules (check mode).
function runTargets(texts, rendered, write, targets = TARGETS) {
  const messages = []
  const files = []
  let code = 0
  for (const t of targets) {
    const text = texts[t.file] == null ? '' : texts[t.file]
    const res = run(text, pick(rendered, t.regions), write, t.file)
    const missing = t.file === 'README.md' ? [] : checkRequiredRegions(text, t.regions, [], t.file)
    messages.push(...res.messages, ...missing)
    if (res.code || missing.length) code = 1
    files.push({ file: t.file, text: res.text, changed: !!res.changed })
  }
  return { code, messages, files }
}

// ── Agent-friendly rules: pure, (text, injected inputs) → diagnostic lines ──

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

// Blank out fenced code blocks and inline code spans (newlines kept, so line
// numbers stay true): a link written inside code is an example, not a link.
function maskCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const lines = text.split('\n')
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      lines[i] = blank(lines[i])
    } else if (m) {
      fence = m[1]
      lines[i] = blank(lines[i])
    }
  }
  return lines.join('\n').replace(/(`+)[^\n]*?\1/g, blank)
}

const MIN_SECTION_WORDS = 40

// Split on lines starting with `## ` (outside fenced code). The part before
// the first heading is the preamble.
function splitSections(text) {
  const lines = text.split(/\r?\n/)
  const masked = maskCode(text).split(/\r?\n/)
  const sections = []
  let cur = { title: '(before first ## section)', lines: [] }
  for (let i = 0; i < lines.length; i++) {
    if (masked[i].startsWith('## ')) { sections.push(cur); cur = { title: lines[i].trim(), lines: [] } }
    cur.lines.push(lines[i])
  }
  sections.push(cur)
  return sections.map((s) => ({ title: s.title, text: s.lines.join('\n') }))
}

// The whole page must score <= MAX_GRADE, and so must the preamble and every
// `## ` section with at least MIN_SECTION_WORDS prose words: a page average
// can hide one dense section.
function checkGrade(text, { markdownToProse, fleschKincaidGrade }) {
  const overall = fleschKincaidGrade(markdownToProse(text))
  const graded = splitSections(text).map((s) => {
    const prose = markdownToProse(s.text)
    return { title: s.title, words: (prose.match(/\S+/g) || []).length, g: fleschKincaidGrade(prose) }
  })
  const failing = graded.filter((s) => s.words >= MIN_SECTION_WORDS && s.g > MAX_SECTION_GRADE)
  const out = []
  if (overall > MAX_GRADE) {
    out.push(`README.md: prose reading grade ${overall.toFixed(1)} is above the max of ${MAX_GRADE.toFixed(1)}. Section grades, highest first:`)
    out.push(...[...graded].sort((a, b) => b.g - a.g).map((s) => `  ${s.g.toFixed(1)}  ${s.title}`))
  }
  for (const s of failing.sort((a, b) => b.g - a.g)) {
    out.push(`README.md: section ${s.title} has reading grade ${s.g.toFixed(1)}, above the max of ${MAX_SECTION_GRADE.toFixed(1)}`)
  }
  return out
}

function linkTargets(text) {
  const masked = maskCode(text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')))
  const out = []
  // Inline Markdown links and images: [text](target "title") / ![alt](<target>)
  for (const m of masked.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^\s)]+)/g)) {
    out.push({ target: m[1].replace(/^<|>$/g, ''), idx: m.index })
  }
  // Reference definitions: [ref]: target
  for (const m of masked.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm)) {
    out.push({ target: m[1].replace(/^<|>$/g, ''), idx: m.index })
  }
  // HTML href / src attributes
  for (const m of masked.matchAll(/<[A-Za-z][^>]*>/g)) {
    for (const a of m[0].matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      out.push({ target: a[1] ?? a[2] ?? a[3], idx: m.index + a.index })
    }
  }
  return out.sort((a, b) => a.idx - b.idx)
}

function checkLinks(text) {
  return linkTargets(text)
    .filter(({ target }) => !target.startsWith('https://') && !target.startsWith('#'))
    .map(({ target, idx }) => `README.md:${lineOf(text, idx)}: link target ${target} must be an absolute https:// URL or a #anchor`)
}

function checkRepoLinks(text, trackedFiles) {
  const tracked = new Set(trackedFiles)
  const esc = REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(esc + '/(blob|tree)/main/([^\\s)"\'<>`\\]]+)', 'g')
  const out = []
  for (const m of text.matchAll(re)) {
    let p = m[2].split('#')[0].split('?')[0].replace(/[.,;:!]+$/, '').replace(/\/+$/, '')
    try { p = decodeURIComponent(p) } catch { /* keep raw */ }
    const ok = m[1] === 'blob'
      ? tracked.has(p)
      : p === '' || tracked.has(p) || trackedFiles.some((f) => f.startsWith(p + '/'))
    if (!ok) out.push(`README.md:${lineOf(text, m.index)}: ${m[1]} link names ${p}, which is not a known repo path (git ls-files --cached --others --exclude-standard)`)
  }
  return out
}

// Tracked plus untracked-not-ignored paths (as check-doc-hierarchy.cjs), so a
// new file linked before its first commit counts. No shell.
// A tracked file deleted from the working tree is not known: the link is dead.
function listKnownPaths(repoRoot) {
  const ls = (...args) => execFileSync('git', ['ls-files', '-z', ...args], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean)
  const deleted = new Set(ls('--deleted'))
  return ls('--cached', '--others', '--exclude-standard').filter((f) => !deleted.has(f))
}

function checkSize(text) {
  const bytes = Buffer.byteLength(text, 'utf8')
  return bytes > MAX_BYTES ? [`README.md is ${bytes} bytes, over the max of ${MAX_BYTES} bytes`] : []
}

const LIST_NAMES = ['skills', 'packs', 'personas']

// Deleting a region must not pass silently: every gen and list region must exist.
function checkRequiredRegions(text, genNames = README_REGIONS, listNames = LIST_NAMES, file = 'README.md') {
  const out = []
  for (const name of genNames) {
    if (!text.includes(`<!-- gen:${name} -->`)) out.push(`${file}: required gen region ${name} is missing (<!-- gen:${name} -->)`)
  }
  for (const name of listNames) {
    if (!text.includes(`<!-- list:${name} -->`)) out.push(`${file}: required list region ${name} is missing (<!-- list:${name} -->)`)
  }
  return out
}

function checkLists(text, expected) {
  const out = []
  for (const name of LIST_NAMES) {
    const open = `<!-- list:${name} -->`
    const close = `<!-- /list:${name} -->`
    const start = text.indexOf(open)
    if (start === -1) continue
    const end = text.indexOf(close, start + open.length)
    if (end === -1) { out.push(`README.md:${lineOf(text, start)}: unclosed list region ${name} (no ${close})`); continue }
    const listed = new Set()
    for (const line of text.slice(start + open.length, end).split(/\r?\n/)) {
      const t = line.trim()
      if (!/^(\||[-*+]\s|\d+[.)]\s)/.test(t)) continue
      const m = t.match(/`([^`]+)`/)
      if (m) listed.add(m[1].trim().replace(/^\//, ''))
    }
    const want = new Set(expected[name] || [])
    const missing = [...want].filter((n) => !listed.has(n)).sort()
    const extra = [...listed].filter((n) => !want.has(n)).sort()
    if (missing.length) out.push(`README.md: list ${name} is missing: ${missing.join(', ')}`)
    if (extra.length) out.push(`README.md: list ${name} has extra names not on disk: ${extra.join(', ')}`)
  }
  return out
}

// Packs come from the validated catalog; a pack it rejects is a diagnostic.
// Personas stay a folder listing (seedAgentPersonas.cjs pulls in electron);
// seedAgentPersonas.test.cjs proves the folder equals its PERSONAS.
function loadListNames(repoRoot) {
  const skillsDir = path.join(repoRoot, 'plugins', 'session-manager-dev', 'skills')
  const { listPacks } = require(path.join(repoRoot, 'src', 'main', 'lib', 'packs', 'packCatalog.cjs'))
  const catalog = listPacks({ packsDir: path.join(repoRoot, 'plugins', 'packs') })
  return {
    skills: fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
      .map((d) => d.name).sort(),
    packs: catalog.packs.map((p) => p.id).sort(),
    errors: catalog.errors.map((e) => `${path.relative(repoRoot, e.dir) || e.dir}: ${e.error}`),
    personas: fs.readdirSync(path.join(repoRoot, 'src', 'seed', 'agents'))
      .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(),
  }
}

function runRules(text, inputs) {
  return [
    ...checkGrade(text, inputs.readability),
    ...checkRequiredRegions(text),
    ...checkLinks(text),
    ...checkRepoLinks(text, inputs.trackedFiles),
    ...checkSize(text),
    ...checkLists(text, inputs.listNames),
    ...(inputs.listNames.errors || []),
  ]
}

async function main() {
  const repoRoot = path.join(__dirname, '..')
  const write = process.argv.includes('--write')
  const texts = {}
  for (const t of TARGETS) {
    const p = path.join(repoRoot, t.file)
    texts[t.file] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
  const text = texts['README.md'] || ''
  const res = runTargets(texts, renderRegions(loadSources(repoRoot)), write)
  for (const m of res.messages) console.error(m)
  if (write) {
    if (res.code === 0) {
      for (const f of res.files) if (f.changed) fs.writeFileSync(path.join(repoRoot, f.file), f.text)
    }
    process.exit(res.code)
  }
  const trackedFiles = listKnownPaths(repoRoot)
  const readability = await import(pathToFileURL(path.join(repoRoot, 'web', 'manual', 'readability.mjs')).href)
  const diags = runRules(text, { readability, trackedFiles, listNames: loadListNames(repoRoot) })
  for (const d of diags) console.error(d)
  process.exit(res.code || (diags.length ? 1 : 0))
}

module.exports = {
  loadSources, renderRegions, applyRegions, run, runTargets, TARGETS, MCP_TOOLS_DOC,
  checkGrade, checkLinks, checkRepoLinks, checkSize, checkLists, checkRequiredRegions, loadListNames, runRules,
  listKnownPaths, MAX_GRADE, MAX_SECTION_GRADE, MAX_BYTES,
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1) })
