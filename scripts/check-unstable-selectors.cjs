#!/usr/bin/env node
'use strict'

// Guards against the "selector mints a fresh array/object on every
// getSnapshot call" bug: zustand v5's useSyncExternalStore compares
// selector output by reference, so a selector body containing `?? []`,
// `?? {}`, `.filter(`, `.map(`, or `Object.values(` (and not wrapped in
// useShallow) returns a new reference every render -> infinite re-render
// -> React error #185 -> blank app. Hit three times already (TabBar, an
// e2e blank-app incident, the v0.39.0 boot blank-screen in 4ab267b).

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'src', 'renderer')
// Only literal `?? []` / `?? {}` are unstable — `?? null` and `?? SOME_CONSTANT`
// (a module-level stable fallback, the documented fix) are fine.
const FORBIDDEN_LITERALS = [/\?\?\s*\[\]/, /\?\?\s*\{\}/]
const FORBIDDEN_CALLS = [/\.filter\(/, /\.map\(/, /Object\.values\(/]

// If the forbidden expression is IMMEDIATELY chained into one of these, its
// output is reduced to a primitive (or an already-stable element reference)
// before the selector returns — e.g. `(s.jobs ?? []).some(...)` returns a
// boolean, not the fresh array. That's reference-stable output, so it's not
// an instance of this bug class. Scoped to the same chain only (the next
// `.method(` right after the forbidden expression closes) — an unrelated
// safe call elsewhere in the selector body must NOT suppress a real hit.
const SAFE_TERMINAL_NAMES = new Set(['some', 'every', 'includes', 'length', 'find', 'indexOf'])

// Zustand store hooks, i.e. hooks created via `create(...)` in
// src/renderer/state/*.ts. Keep in sync with that directory — this is
// deliberately NOT `use[A-Za-z]*` because that also matches React's own
// hooks (useEffect, useMemo, useState, useCallback, ...) which have
// nothing to do with getSnapshot reference stability.
const STORE_HOOK_NAMES = [
  'useEditorPrefs',
  'useBilling',
  'useProvenance',
  'useConfig',
  'useLayout',
  'useChat',
  'useAgentMemory',
  'useEditor',
  'useTeams',
  'useToast',
  'useSessions',
  'useWatchers',
  'useProjectsPrefs',
  'useLive',
  'useVoice',
  'useScheduleState',
  'usePromptSessions',
  'useTour',
]

// Matches `<storeHook>(<selector arg>)`, e.g. `useScheduleState((s) => ...)`
// or `useVoice(s => ...)`.
const HOOK_CALL_RE = new RegExp(
  `\\b(?:${STORE_HOOK_NAMES.join('|')})\\s*\\(\\s*(\\([^)]*\\)|[A-Za-z_$][A-Za-z0-9_$]*)\\s*=>`,
  'g'
)

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
}

// Blanks out comments and string/template-literal contents (replacing with
// spaces, preserving newlines and overall length so line numbers and byte
// offsets still line up with the original source). This keeps stray `(`/`)`
// or pattern-shaped text inside comments and string literals from confusing
// the paren-matcher or triggering false positives.
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

function findMatchingParen(src, openIdx) {
  let depth = 1
  for (let i = openIdx + 1; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// Given the index right after a forbidden expression closes, checks whether
// it is immediately chained into a safe terminal call, e.g. `).some(`.
function isImmediatelyReducedToPrimitive(text, afterIdx) {
  let i = afterIdx
  while (i < text.length && /[\s)\]}]/.test(text[i])) i++
  if (text[i] !== '.') return false
  const m = /^\.(\w+)\(/.exec(text.slice(i))
  return !!m && SAFE_TERMINAL_NAMES.has(m[1])
}

function checkFile(file, src) {
  const violations = []
  const scanSrc = stripCommentsAndStrings(src)
  HOOK_CALL_RE.lastIndex = 0
  let match
  while ((match = HOOK_CALL_RE.exec(scanSrc))) {
    // Find the opening paren of the *hook call* (not the arrow-param paren).
    const hookNameEnd = match.index + match[0].match(/^\s*use[A-Za-z0-9_]*/)[0].length
    const openIdx = scanSrc.indexOf('(', hookNameEnd)
    if (openIdx === -1) continue
    const closeIdx = findMatchingParen(scanSrc, openIdx)
    if (closeIdx === -1) continue
    const argText = scanSrc.slice(openIdx + 1, closeIdx)

    if (/\buseShallow\s*\(/.test(argText)) continue

    let hit = null

    for (const pattern of FORBIDDEN_LITERALS) {
      const m = pattern.exec(argText)
      pattern.lastIndex = 0
      if (m && !isImmediatelyReducedToPrimitive(argText, m.index + m[0].length)) {
        hit = m
        break
      }
    }

    if (!hit) {
      for (const pattern of FORBIDDEN_CALLS) {
        const m = pattern.exec(argText)
        pattern.lastIndex = 0
        if (!m) continue
        const callOpenIdx = m.index + m[0].length - 1 // index of the call's own '('
        const callCloseIdx = findMatchingParen(argText, callOpenIdx)
        const afterIdx = callCloseIdx === -1 ? m.index + m[0].length : callCloseIdx + 1
        if (!isImmediatelyReducedToPrimitive(argText, afterIdx)) {
          hit = m
          break
        }
      }
    }

    if (!hit) continue

    const line = scanSrc.slice(0, match.index).split('\n').length
    const originalArgText = src.slice(openIdx + 1, closeIdx)
    violations.push({ file, line, snippet: originalArgText.trim().slice(0, 120) })
  }
  return violations
}

function main() {
  const files = []
  walk(ROOT, files)

  const allViolations = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const violations = checkFile(file, src)
    allViolations.push(...violations)
  }

  if (allViolations.length > 0) {
    console.error('Unstable zustand selector(s) found (fresh array/object per render -> React #185):\n')
    for (const v of allViolations) {
      console.error(`  ${path.relative(process.cwd(), v.file)}:${v.line}  ${v.snippet}`)
    }
    console.error(
      '\nWrap the selector in useShallow() from zustand/react/shallow, or select the raw slice and derive after.'
    )
    process.exit(1)
  }

  console.log(`check-unstable-selectors: OK (${files.length} files scanned)`)
}

main()
