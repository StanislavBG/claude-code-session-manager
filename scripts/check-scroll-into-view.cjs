#!/usr/bin/env node
'use strict'

// Bans `Element.scrollIntoView(` in non-test renderer source.
//
// scrollIntoView scrolls EVERY scrollable ancestor of the target — including
// the app's outer `overflow: hidden` layout frames, which the user then has no
// way to scroll back. That is the "browsing a sub-menu bugs out the main frame"
// incident (Settings, Doc-Editor outline). The shell stays un-buggable only if
// nobody can reach for it: use src/renderer/lib/scrollWithin.ts, which scrolls
// exactly one container you name.
//
// Matches `scrollIntoView(` and the optional-call form `scrollIntoView?.(`.
// Comment-only text (`// ...`, `/* ... */` lines, JSDoc `* ...` lines) is
// ignored so explanatory comments can still name the banned API.

const fs = require('fs')
const path = require('path')

const REPO = path.join(__dirname, '..')
const ROOT = path.join(REPO, 'src', 'renderer')
const CALL_RE = /\bscrollIntoView\s*(?:\?\.)?\s*\(/

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
  }
}

function codePart(line, state) {
  let s = line
  if (state.inBlock) {
    const end = s.indexOf('*/')
    if (end === -1) return ''
    s = s.slice(end + 2)
    state.inBlock = false
  }
  let out = ''
  for (;;) {
    const lc = s.indexOf('//')
    const bc = s.indexOf('/*')
    if (lc === -1 && bc === -1) return out + s
    if (bc === -1 || (lc !== -1 && lc < bc)) return out + s.slice(0, lc)
    out += s.slice(0, bc)
    const end = s.indexOf('*/', bc + 2)
    if (end === -1) { state.inBlock = true; return out }
    s = s.slice(end + 2)
  }
}

function checkFile(file) {
  const hits = []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const state = { inBlock: false }
  for (let i = 0; i < lines.length; i++) {
    if (CALL_RE.test(codePart(lines[i], state))) hits.push({ line: i + 1, text: lines[i].trim() })
  }
  return hits
}

function main() {
  const files = []
  walk(ROOT, files)
  let count = 0
  for (const file of files) {
    for (const h of checkFile(file)) {
      count++
      console.error(`${path.relative(REPO, file)}:${h.line}: ${h.text}`)
    }
  }
  if (count > 0) {
    console.error(
      `\n${count} scrollIntoView( call(s) in src/renderer. scrollIntoView scrolls every ` +
        `scrollable ancestor, including the app's overflow-hidden layout frames, and leaves ` +
        `the frame stuck. Use scrollWithin(container, target, { block }) from ` +
        `src/renderer/lib/scrollWithin.ts with the list's own scroll container instead.`,
    )
    process.exit(1)
  }
  console.log(`check-scroll-into-view: OK (${files.length} files scanned)`)
}

main()
