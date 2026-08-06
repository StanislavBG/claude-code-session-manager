#!/usr/bin/env node
'use strict'

// Guards against the "a hook is declared BELOW a top-level early return" bug:
// React counts hooks per render, so a component that bails out early on one
// render and falls through on the next runs a different number of hooks ->
// React error #300 ("Rendered fewer hooks than expected") / #310 ("Rendered
// more hooks than during the previous render") -> the pane crashes into its
// error boundary ("something broke in this panel").
//
// Sibling of check-unstable-selectors.cjs, which guards the other recurring
// React crash class in this codebase (#185). Hit at least once: SchedulePanel's
// `holdBySlug` useMemo sat below three early returns (`!snap`, the supervisor
// sub-panel, and FirstRunGuide), so the whole Scheduler tab threw #300 as soon
// as the scoped queue drained to zero jobs or the user switched projects.
//
// Heuristic, deliberately narrow to stay false-positive-free without a real
// parser: it only looks at TOP-LEVEL statements of an exported/`const`
// component function (indent exactly 2 spaces), so returns inside nested
// callbacks, `.map()` bodies, and helper closures are correctly ignored.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'src', 'renderer')

const HOOK_RE = /\buse(?:State|Effect|LayoutEffect|Memo|Callback|Ref|Reducer|Context|SyncExternalStore|ImperativeHandle|DeferredValue|Transition|Id)\s*\(/

// A component/hook declaration at column 0. Components are PascalCase;
// custom hooks are `useXxx` and are subject to the exact same rule.
const FN_START_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Z]\w*|use[A-Z]\w*)\s*[(<]|^(?:export\s+)?const\s+([A-Z]\w*|use[A-Z]\w*)\s*(?::[^=]*)?=\s*(?:React\.memo\()?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/

// A top-level `return` inside that function body: exactly 2 spaces of indent.
// Covers `return null`, `if (x) return null`, and a multi-line `return (`.
const TOP_LEVEL_RETURN_RE = /^ {2}(?:if\s*\(.*\)\s*)?return\b/

// A top-level hook assignment: exactly 2 spaces of indent.
const TOP_LEVEL_HOOK_DECL_RE = /^ {2}(?:const|let|var)\s+[^=]*=\s*.*$/

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry.name)) out.push(full)
  }
}

function checkFile(file, src) {
  const violations = []
  const lines = src.split('\n')

  let fnName = null
  let sawReturn = false
  let returnLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // A column-0 `}` closes the current function body.
    if (fnName && /^\}/.test(line)) {
      fnName = null
      sawReturn = false
      continue
    }

    const start = FN_START_RE.exec(line)
    if (start) {
      fnName = start[1] || start[2]
      sawReturn = false
      continue
    }
    if (!fnName) continue

    if (TOP_LEVEL_RETURN_RE.test(line)) {
      if (!sawReturn) {
        sawReturn = true
        returnLine = i + 1
      }
      continue
    }

    if (sawReturn && TOP_LEVEL_HOOK_DECL_RE.test(line) && HOOK_RE.test(line)) {
      violations.push({
        file,
        line: i + 1,
        fn: fnName,
        returnLine,
        snippet: line.trim().slice(0, 100),
      })
    }
  }

  return violations
}

function main() {
  const files = []
  walk(ROOT, files)

  const all = []
  for (const file of files) {
    all.push(...checkFile(file, fs.readFileSync(file, 'utf8')))
  }

  if (all.length > 0) {
    console.error('Conditional hook(s) found — hook declared below a top-level early return (React #300/#310):\n')
    for (const v of all) {
      console.error(
        `  ${path.relative(process.cwd(), v.file)}:${v.line}  ${v.fn}() — early return at line ${v.returnLine}\n` +
          `      ${v.snippet}`
      )
    }
    console.error('\nHoist the hook above every early return; guard its BODY on the nullable value instead.')
    process.exit(1)
  }

  console.log(`check-conditional-hooks: OK (${files.length} files scanned)`)
}

main()
