#!/usr/bin/env node
'use strict'

// Guards the main-process typecheck ratchet (tsconfig.main.json): with
// `checkJs: false` a file is only type-checked if it is in `include` AND starts
// with `// @ts-check`. Nothing else pairs the two, so an allowlisted file
// without the directive would be silently unchecked while `npm run typecheck`
// stays green. Checks both directions:
//   1. every `include` entry exists, is explicit (no glob), starts with the directive;
//   2. every src/main/**/*.cjs (excluding __tests__) starting with the directive is in `include`.
// Complexity: O(files in src/main) reads of one line each.

const fs = require('fs')
const path = require('path')

const DIRECTIVE = '// @ts-check'
const GLOB_RE = /[*?[\]{}!]/

function firstNonEmptyLine(file) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() !== '') return line
  }
  return ''
}

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      walk(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.cjs')) {
      out.push(full)
    }
  }
}

const toPosix = (p) => p.split(path.sep).join('/')

/** @param {string} rootDir @returns {string[]} `file: reason` findings */
function check(rootDir) {
  const findings = []
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'tsconfig.main.json'), 'utf8'))
  } catch (err) {
    return [`tsconfig.main.json: cannot read/parse (${err.message})`]
  }
  if (!cfg.compilerOptions || cfg.compilerOptions.checkJs !== false) {
    findings.push('tsconfig.main.json: compilerOptions.checkJs must be false (the ratchet relies on per-file // @ts-check)')
  }
  const include = Array.isArray(cfg.include) ? cfg.include : []
  const listed = new Set()
  for (const entry of include) {
    if (GLOB_RE.test(entry)) {
      findings.push(`${entry}: glob in include — the allowlist must stay explicit`)
      continue
    }
    const rel = toPosix(path.normalize(entry))
    listed.add(rel)
    const abs = path.join(rootDir, entry)
    if (!fs.existsSync(abs)) {
      findings.push(`${entry}: listed in tsconfig.main.json include but file does not exist`)
    } else if (firstNonEmptyLine(abs).trim() !== DIRECTIVE) {
      findings.push(`${entry}: in include but first non-empty line is not exactly "${DIRECTIVE}" (file would be silently unchecked)`)
    }
  }
  const files = []
  walk(path.join(rootDir, 'src', 'main'), files)
  for (const abs of files) {
    const rel = toPosix(path.relative(rootDir, abs))
    if (!listed.has(rel) && firstNonEmptyLine(abs).trim() === DIRECTIVE) {
      findings.push(`${rel}: starts with "${DIRECTIVE}" but is missing from tsconfig.main.json include`)
    }
  }
  return findings
}

module.exports = { check }

if (require.main === module) {
  const findings = check(path.join(__dirname, '..'))
  if (findings.length) {
    for (const f of findings) console.error(f)
    process.exit(1)
  }
  console.log('check-main-ts-check: OK')
}
