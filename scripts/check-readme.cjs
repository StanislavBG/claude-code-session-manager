#!/usr/bin/env node
'use strict'

// Fills README.md's generated regions from the code, so the npm page's
// agent-facing facts (MCP tool table, recipes, counts, Node floor) can't go
// stale. One diagnostic line per failure.
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

const fs = require('fs')
const path = require('path')

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
    const args = req.length ? req.map(code).join(', ') : '—'
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

function applyRegions(text, rendered) {
  const errors = []
  const stale = []
  const seen = new Set()
  const markers = [...text.matchAll(MARKER_RE)].map((m) => ({
    close: m[1] === '/', name: m[2], from: m.index, to: m.index + m[0].length,
  }))
  const edits = [] // { from, to, value }
  for (let i = 0; i < markers.length; i++) {
    const open = markers[i]
    if (open.close) { errors.push(`README.md: closing marker for region ${open.name} has no matching opening marker`); continue }
    const close = markers[i + 1]
    if (!close || !close.close || close.name !== open.name) {
      errors.push(`README.md: unclosed region ${open.name} (no <!-- /gen:${open.name} --> before the next marker)`)
      continue
    }
    i++
    if (seen.has(open.name)) { errors.push(`README.md: duplicate region ${open.name}`); continue }
    seen.add(open.name)
    if (!Object.prototype.hasOwnProperty.call(rendered, open.name)) {
      errors.push(`README.md: unknown region ${open.name}`)
      continue
    }
    const sameLine = lineBounds(text, open.from).start === lineBounds(text, close.from).start
    if (sameLine) {
      const value = rendered[open.name]
      if (value.includes('\n')) { errors.push(`README.md: region ${open.name} is multi-line; use block markers on their own lines`); continue }
      if (text.slice(open.to, close.from) !== value) { stale.push(open.name); edits.push({ from: open.to, to: close.from, value }) }
      continue
    }
    if (!aloneOnLine(text, open.from, open.to) || !aloneOnLine(text, close.from, close.to)) {
      errors.push(`README.md: region ${open.name} spans lines, so both markers must be on their own lines`)
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
function run(text, rendered, write) {
  const res = applyRegions(text, rendered)
  if (res.errors.length) return { code: 1, messages: res.errors, text }
  if (write) return { code: 0, messages: [], text: res.text, changed: res.text !== text }
  const messages = res.stale.map((n) => `README.md region ${n} is out of date. Run: npm run readme:build, then commit README.md.`)
  return { code: messages.length ? 1 : 0, messages, text }
}

function main() {
  const repoRoot = path.join(__dirname, '..')
  const readmePath = path.join(repoRoot, 'README.md')
  const write = process.argv.includes('--write')
  const text = fs.readFileSync(readmePath, 'utf8')
  const res = run(text, renderRegions(loadSources(repoRoot)), write)
  for (const m of res.messages) console.error(m)
  if (write && res.code === 0 && res.changed) fs.writeFileSync(readmePath, res.text)
  process.exit(res.code)
}

module.exports = { loadSources, renderRegions, applyRegions, run }

if (require.main === module) main()
