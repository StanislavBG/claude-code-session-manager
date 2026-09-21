#!/usr/bin/env node
'use strict'

// Bans explicit `any` in src/renderer + src/preload. `tsc --strict` only blocks
// IMPLICIT any, so `: any` / `as any` would otherwise creep back unchecked.
// Flags `: any`, `as any`, `<any>` / `<..., any>` (incl. `Record<string, any>`),
// `any[]`, `@ts-ignore`, `@ts-nocheck`. Text inside comments/strings is ignored
// (except the @ts-* directives, which live in comments by nature).
// Escape hatch, per line: `// lint-allow-any: <non-empty reason>`.
// Excludes tests (*.test.* / *.spec.* / __tests__) and src/renderer/public/**.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SCAN_ROOTS = [path.join(ROOT, 'src', 'renderer'), path.join(ROOT, 'src', 'preload')]
const PUBLIC_DIR = path.join(ROOT, 'src', 'renderer', 'public')

const ANY_PATTERNS = [
  /:\s*any\b/,
  /\bas\s+any\b/,
  /[<,]\s*any\s*[>,]/,
  /\bany\s*\[\]/,
]
const DIRECTIVE_RE = /(?:\/\/|\/\*|^\s*\*)\s*@ts-(?:ignore|nocheck)\b/
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

// Blanks comments and string/template contents with spaces (newlines and
// length preserved so line numbers line up). O(n).
function stripCommentsAndStrings(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && c2 === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += '  '
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += ' '
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += ' '
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

function checkSource(file, src) {
  const violations = []
  const origLines = src.split('\n')
  const scanLines = stripCommentsAndStrings(src).split('\n')
  for (let idx = 0; idx < origLines.length; idx++) {
    const orig = origLines[idx]
    if (ALLOW_RE.test(orig)) continue
    const scan = scanLines[idx] || ''
    if (ANY_PATTERNS.some((re) => re.test(scan)) || DIRECTIVE_RE.test(orig)) {
      violations.push({ file, line: idx + 1, snippet: orig.trim().slice(0, 120) })
    }
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

module.exports = { checkSource, stripCommentsAndStrings }
