#!/usr/bin/env node
'use strict'

// Read-only report: each ~/.claude/agents persona's loadout state (undecided / bare /
// equipped / unbound, plus declared mcpServers and packs) and the loose ~/.claude/skills
// that no context pack carries. Never writes or deletes. Complexity: O(personas + skills).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadoutState } = require('../src/main/lib/persona-macro/personaLoadout.cjs')
const { splitFrontmatter } = require('../src/main/lib/prd/prdFrontmatter.cjs')
const { listPacks, listUnpackedSkills } = require('../src/main/lib/packs/packCatalog.cjs')

const list = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)

/** @returns {{ name: string, state: string, mcpServers: string[], packs: string[] }[]} */
function personaRows(dir) {
  let names = []
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() } catch { return [] }
  return names.map((f) => {
    let fm = {}
    try { fm = splitFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8')).fm || {} } catch { /* unreadable: report as undecided */ }
    return { name: f.replace(/\.md$/, ''), state: loadoutState(fm), mcpServers: list(fm.mcpServers), packs: list(fm.packs) }
  })
}

function main() {
  const home = os.homedir()
  const rows = personaRows(path.join(home, '.claude', 'agents'))
  console.log('Personas (~/.claude/agents):')
  for (const r of rows) {
    const extra = [r.mcpServers.length ? `mcp=${r.mcpServers.join('+')}` : '', r.packs.length ? `packs=${r.packs.join('+')}` : ''].filter(Boolean).join(' ')
    console.log(`  ${r.state === 'undecided' ? '!' : ' '} ${r.name}: ${r.state}${extra ? ' ' + extra : ''}`)
  }
  const undecided = rows.filter((r) => r.state === 'undecided').length
  console.log(`${undecided} of ${rows.length} undecided`)
  let names = []
  try {
    const carried = new Set(listPacks({ home }).packs.flatMap((p) => p.skills.map((k) => String(k).split(':').pop())))
    names = listUnpackedSkills({ home }).filter((n) => !carried.has(n))
  } catch (e) { console.log(`(skills unreadable: ${e.message})`) }
  console.log(`Loose skills in no pack (~/.claude/skills): ${names.length}`)
  for (const n of names) console.log(`  ${n}`)
}

if (require.main === module) main()

module.exports = { personaRows }
