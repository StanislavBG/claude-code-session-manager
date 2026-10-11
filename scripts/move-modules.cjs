#!/usr/bin/env node
'use strict'

// Partition codemod for src/main/lib. Usage:
//   node scripts/move-modules.cjs <mapping.json> [root] [--dry-run]
// mapping.json = {"<moduleBasename>": "<subfolder>"}. For each entry it git-mvs
// src/main/lib/<m>.cjs -> lib/<sub>/<m>.cjs (and lib/__tests__/<m>.test.cjs ->
// lib/<sub>/__tests__/<m>.test.cjs), then rewrites in every tracked
// .cjs/.ts/.tsx/.mjs/.json/.md/.yml file:
//   - relative specifiers in require()/import()/from/vi.mock (recomputed from
//     each file's NEW location, so requires FROM moved files stay correct);
//   - literal `src/main/lib/<m>.cjs` / `lib/<m>.cjs` (and __tests__) strings.
// Idempotent: an entry whose source is gone and target present is already
// moved. Exit 1 (nothing touched) on a missing module or an existing target.
// Not rewritten: __dirname-relative path.join(...) arithmetic in moved files.
// Root: second positional arg (default repo) so tests can use a scratch repo.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const EXTS = new Set(['.cjs', '.ts', '.tsx', '.mjs', '.json', '.md', '.yml'])
const CODE_EXTS = new Set(['.cjs', '.ts', '.tsx', '.mjs'])
const LIB = 'src/main/lib'
const SPEC_RE = /(\b(?:require|require\.resolve|import|vi\.mock|vi\.doMock|vi\.importActual|vi\.importMock)\s*\(\s*|\bfrom\s+)(['"`])(\.{1,2}(?:\/[^'"`\n]*)?)\2/g
const STR_RE = /(?<![\w.-])((?:src\/main\/)?lib\/)(?:(__tests__\/)([\w.-]+)\.test|([\w.-]+))\.cjs(?![\w-])/g

const posix = (p) => p.split(path.sep).join('/')

function main(argv) {
  const dry = argv.includes('--dry-run')
  const [mapFile, rootArg] = argv.filter((a) => !a.startsWith('--'))
  if (!mapFile) {
    console.error('usage: node scripts/move-modules.cjs <mapping.json> [root] [--dry-run]')
    return 1
  }
  const root = path.resolve(rootArg || path.join(__dirname, '..'))
  const mapping = JSON.parse(fs.readFileSync(path.resolve(mapFile), 'utf8'))
  const libDir = path.join(root, LIB)

  const errors = []
  const moves = new Map() // old abs -> new abs
  const subOf = new Map() // module basename -> subfolder
  const testSubOf = new Map()
  for (const [m, sub] of Object.entries(mapping)) {
    const from = path.join(libDir, `${m}.cjs`)
    const to = path.join(libDir, sub, `${m}.cjs`)
    if (fs.existsSync(from)) {
      if (fs.existsSync(to)) errors.push(`target already exists: ${posix(path.relative(root, to))}`)
      else { moves.set(from, to); subOf.set(m, sub) }
    } else if (!fs.existsSync(to)) {
      errors.push(`mapped module does not exist: ${m} (${posix(path.relative(root, from))})`)
    }
    const tFrom = path.join(libDir, '__tests__', `${m}.test.cjs`)
    const tTo = path.join(libDir, sub, '__tests__', `${m}.test.cjs`)
    if (fs.existsSync(tFrom)) {
      if (fs.existsSync(tTo)) errors.push(`target already exists: ${posix(path.relative(root, tTo))}`)
      else { moves.set(tFrom, tTo); testSubOf.set(m, sub) }
    }
  }
  if (errors.length) {
    for (const e of errors) console.error(`move-modules: ${e}`)
    return 1
  }

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString().split('\0').filter((f) => f && EXTS.has(path.extname(f)))

  const edits = [] // { oldAbs, newAbs, content, count }
  for (const rel of tracked) {
    const oldAbs = path.join(root, rel)
    let src
    try { src = fs.readFileSync(oldAbs, 'utf8') } catch { continue }
    const newAbs = moves.get(oldAbs) || oldAbs
    const oldDir = path.dirname(oldAbs)
    const newDir = path.dirname(newAbs)
    let count = 0
    let out = src
    if (CODE_EXTS.has(path.extname(rel))) {
      out = out.replace(SPEC_RE, (all, pre, q, spec) => {
        const abs = path.resolve(oldDir, spec)
        const hasExt = moves.has(abs)
        const target = hasExt ? abs : moves.has(`${abs}.cjs`) ? `${abs}.cjs` : abs
        const dest = moves.get(target) || target
        if (newDir === oldDir && dest === target) return all
        let next = posix(path.relative(newDir, dest))
        if (!hasExt && dest !== target) next = next.replace(/\.cjs$/, '')
        if (!next.startsWith('.')) next = `./${next}`
        if (next === spec) return all
        count++
        return `${pre}${q}${next}${q}`
      })
    }
    out = out.replace(STR_RE, (all, prefix, tests, tName, name) => {
      const sub = tests ? testSubOf.get(tName) : subOf.get(name)
      if (!sub) return all
      count++
      return tests ? `${prefix}${sub}/__tests__/${tName}.test.cjs` : `${prefix}${sub}/${name}.cjs`
    })
    if (count) edits.push({ oldAbs, newAbs, content: out, count })
  }

  const total = edits.reduce((n, e) => n + e.count, 0)
  for (const [from, to] of moves) console.log(`${dry ? 'would move' : 'move'} ${posix(path.relative(root, from))} -> ${posix(path.relative(root, to))}`)
  if (dry) {
    for (const e of edits) console.log(`  ${e.count} edit(s) in ${posix(path.relative(root, e.oldAbs))}`)
  } else {
    for (const [from, to] of moves) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      execFileSync('git', ['mv', from, to], { cwd: root })
    }
    for (const e of edits) fs.writeFileSync(e.newAbs, e.content)
  }
  console.log(`move-modules: ${moves.size} move(s), ${total} edit(s) in ${edits.length} file(s)${dry ? ' (dry run)' : ''}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
