#!/usr/bin/env node
'use strict'

// Bans explicit `any` in src/renderer + src/preload. `tsc --strict` only blocks
// IMPLICIT any, so `: any` / `as any` would otherwise creep back unchecked.
// Walks the TypeScript AST for `AnyKeyword` (exact for every type position, immune
// to comments/strings/JSX text) and scans real comments for `@ts-ignore` /
// `@ts-nocheck`. Complexity: O(n) in source size per file.
// Escape hatch, per line: `// lint-allow-any: <non-empty reason>`.
// Excludes tests (*.test.* / *.spec.* / __tests__) and src/renderer/public/**.

const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..')
const SCAN_ROOTS = [path.join(ROOT, 'src', 'renderer'), path.join(ROOT, 'src', 'preload')]
const PUBLIC_DIR = path.join(ROOT, 'src', 'renderer', 'public')

const DIRECTIVE_RE = /@ts-(?:ignore|nocheck)\b/
const ALLOW_RE = /\/\/\s*lint-allow-any:\s*\S/

function isTestPath(p) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || p.split(path.sep).includes('__tests__')
}

function walk(dir, out) {
  if (dir === PUBLIC_DIR) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !isTestPath(full)) {
      out.push(full)
    }
  }
}

function checkSource(file, src) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line
  const hits = new Set() // 0-based line indexes

  // Comments are collected from AST-anchored trivia (leading of every node incl. the
  // EOF token, trailing after each node), so string/JSX text is never mistaken for one.
  const seen = new Set()
  const checkComments = (ranges) => {
    for (const r of ranges || []) {
      if (seen.has(r.pos)) continue
      seen.add(r.pos)
      const m = DIRECTIVE_RE.exec(src.slice(r.pos, r.end))
      if (m) hits.add(lineOf(r.pos + m.index))
    }
  }

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) hits.add(lineOf(node.getStart(sf)))
    checkComments(ts.getLeadingCommentRanges(src, node.getFullStart()))
    checkComments(ts.getTrailingCommentRanges(src, node.getEnd()))
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const origLines = src.split('\n')
  const violations = []
  for (const idx of [...hits].sort((a, b) => a - b)) {
    const orig = origLines[idx] || ''
    if (ALLOW_RE.test(orig)) continue
    violations.push({ file, line: idx + 1, snippet: orig.trim().slice(0, 120) })
  }
  return violations
}

function main() {
  const files = []
  for (const root of SCAN_ROOTS) walk(root, files)
  const all = []
  for (const file of files) all.push(...checkSource(file, fs.readFileSync(file, 'utf8')))

  if (all.length > 0) {
    console.error('Explicit `any` / @ts-ignore found in renderer/preload:\n')
    for (const v of all) console.error(`  ${path.relative(process.cwd(), v.file)}:${v.line}  ${v.snippet}`)
    console.error('\nUse a real type or `unknown`; if truly unavoidable add `// lint-allow-any: <reason>` on that line.')
    process.exit(1)
  }
  console.log(`check-explicit-any: OK (${files.length} files scanned)`)
}

if (require.main === module) main()

module.exports = { checkSource }
