#!/usr/bin/env node
'use strict'

// Persona gear drift: a persona that lists an mcp__<server>__<tool> tool must also name that
// server in `mcpServers:`. savePersona derives the line; this catches hand-edited files.
// src/seed/agents/*.md fail the lint; ~/.claude/agents/*.md only warn.
// Complexity: O(files x tools).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { mcpServersFromTools } = require('../src/main/lib/claude/agentSnapshot.cjs')

const list = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)

/** Servers named by mcp__ tools but missing from mcpServers, for one persona file's text. */
function driftOf(text) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return []
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) return []
  const fm = {}
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(l)
    if (m) fm[m[1]] = m[2].trim()
  }
  const declared = new Set(list(fm.mcpServers))
  return mcpServersFromTools(list(fm.tools)).filter((s) => !declared.has(s))
}

function scanDir(dir) {
  const out = []
  let names = []
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() } catch { return out }
  for (const f of names) {
    const missing = driftOf(fs.readFileSync(path.join(dir, f), 'utf8'))
    if (missing.length) out.push({ file: path.join(dir, f), message: `mcp__ tools name server(s) missing from mcpServers: ${missing.join(', ')}` })
  }
  return out
}

/** @returns {{ failures: object[], warnings: object[] }} */
function run({ seedDir = path.join(__dirname, '..', 'src', 'seed', 'agents'), homeDir = path.join(os.homedir(), '.claude', 'agents') } = {}) {
  return { failures: scanDir(seedDir), warnings: scanDir(homeDir) }
}

if (require.main === module) {
  const { failures, warnings } = run()
  for (const w of warnings) console.warn(`warn: ${w.file}: ${w.message}`)
  for (const f of failures) console.error(`${f.file}: ${f.message}`)
  if (failures.length) process.exit(1)
  console.log('lint:persona-gear OK')
}

module.exports = { driftOf, scanDir, run }
