#!/usr/bin/env node
'use strict'

// Read-only diagnostic: reports Epics whose claude transcript is `mislocated`
// (only under a worktree encoding) or `duplicated` (same session id under 2+
// project encodings — the unresumable state). Iterates every known project
// (activeSessions.allProjectCwds) and stats bounded candidate paths; never
// enumerates ~/.claude/projects for transcripts, writes nothing.
//
// Usage: node scripts/check-epic-transcripts.cjs [--json]
// Exit: 0 = no findings, 1 = findings. --json prints only the findings array.

const { allProjectCwds } = require('../src/main/lib/activeSessions.cjs')
const { scanEpicTranscripts } = require('../src/main/lib/epicTranscriptDiagnostic.cjs')

const json = process.argv.includes('--json')
// The resolver logs progress via console.log; keep stdout clean for --json.
console.log = (...a) => console.error(...a)
const findings = scanEpicTranscripts({ cwds: allProjectCwds() })

if (json) {
  process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`)
} else {
  for (const f of findings) {
    process.stdout.write(`${f.classification}\tsession=${f.sessionId}\tepic=${f.epicId}\tcwd=${f.cwd}\t${f.paths.join(' , ')}\n`)
  }
  if (findings.length === 0) process.stdout.write('clean: no mislocated or duplicated Epic transcripts\n')
}
process.exit(findings.length ? 1 : 0)
