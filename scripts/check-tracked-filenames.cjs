#!/usr/bin/env node
'use strict'

// Guards against committing junk or Windows-illegal filenames (a literal `<path>`
// file once got swept in by a broad `git add` and made the repo un-checkoutable
// on Windows). Fails on any tracked path with: an illegal char (< > : " | ? *
// or control chars), a segment with a trailing dot/space, or a reserved device
// name segment (CON, PRN, AUX, NUL, COM1-9, LPT1-9; case-insensitive, with or
// without extension). Complexity: O(total path length).

const { execFileSync } = require('child_process')
const path = require('path')

// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS_RE = /[<>:"|?*\x00-\x1f]/
const RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function check(paths) {
  const findings = []
  for (const p of paths) {
    if (!p) continue
    const bad = p.match(ILLEGAL_CHARS_RE)
    if (bad) {
      findings.push(`${JSON.stringify(p)}: contains Windows-illegal character ${JSON.stringify(bad[0])}`)
      continue
    }
    for (const seg of p.split('/')) {
      if (/[. ]$/.test(seg)) {
        findings.push(`${JSON.stringify(p)}: segment ${JSON.stringify(seg)} ends with a dot or space`)
        break
      }
      if (RESERVED_RE.test(seg.split('.')[0])) {
        findings.push(`${JSON.stringify(p)}: segment ${JSON.stringify(seg)} is a reserved Windows device name`)
        break
      }
    }
  }
  return findings
}

module.exports = { check }

if (require.main === module) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const findings = check(out.split('\0'))
  if (findings.length) {
    for (const f of findings) console.error(f)
    process.exit(1)
  }
  console.log('check-tracked-filenames: OK')
}
