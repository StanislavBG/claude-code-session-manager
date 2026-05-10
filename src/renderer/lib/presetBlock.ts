/**
 * Managed-block installer for prompt presets inside CLAUDE.md.
 *
 * The file has a single delimited block that this module owns:
 *
 *   <!-- claude-presets:start id=preset-a,preset-b,preset-c -->
 *   # Communication style
 *   - ...merged bullet...
 *   - ...
 *
 *   # Working style
 *   - ...merged bullet...
 *   <!-- claude-presets:end -->
 *
 * Everything OUTSIDE the block is the user's own content and is preserved
 * byte-for-byte. The block's `id=` attribute is the source of truth for which
 * presets are currently active. Install/uninstall rewrites the block; all
 * bullets from presets that share a `section` are merged under one H1.
 */

import type { CatalogPromptPreset } from '../data/catalog'

const START_RE = /<!--\s*claude-presets:start(?:\s+id=([^>]*?))?\s*-->/
const END_MARK = '<!-- claude-presets:end -->'

/** Extract the active preset IDs from CLAUDE.md's managed block, if any. */
export function readActivePresetIds(claudeMd: string): string[] {
  const m = claudeMd.match(START_RE)
  if (!m) return []
  const attr = (m[1] ?? '').trim()
  if (!attr) return []
  return attr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Render the managed block from an ordered list of active presets.
 * Presets are grouped by `section` in the order they first appear, and
 * each section's bullets are concatenated.
 */
export function renderPresetBlock(active: CatalogPromptPreset[]): string {
  if (active.length === 0) {
    return `<!-- claude-presets:start -->\n<!-- claude-presets:end -->`
  }
  // Group by section, preserving first-seen order.
  const sections: Array<{ section: string; bullets: string[] }> = []
  const seen = new Map<string, number>()
  for (const p of active) {
    const key = p.section.trim().toLowerCase()
    let idx = seen.get(key)
    if (idx === undefined) {
      idx = sections.length
      seen.set(key, idx)
      sections.push({ section: p.section.trim(), bullets: [] })
    }
    sections[idx].bullets.push(...p.bullets)
  }
  const body = sections
    .map(
      (s) =>
        `# ${s.section}\n\n${s.bullets.map((b) => `- ${b.trim()}`).join('\n')}`
    )
    .join('\n\n')
  const ids = active.map((p) => p.id).join(',')
  return `<!-- claude-presets:start id=${ids} -->\n${body}\n<!-- claude-presets:end -->`
}

/**
 * Rewrite CLAUDE.md so that its managed block contains exactly the given
 * active presets. Creates the block at the top of the file if none exists.
 * User content outside the block is preserved.
 */
export function writeManagedBlock(
  existing: string,
  active: CatalogPromptPreset[]
): string {
  const block = renderPresetBlock(active)
  const startMatch = existing.match(START_RE)
  if (startMatch && startMatch.index !== undefined) {
    const startIdx = startMatch.index
    const endIdx = existing.indexOf(END_MARK, startIdx)
    if (endIdx >= 0) {
      const before = existing.slice(0, startIdx)
      const after = existing.slice(endIdx + END_MARK.length)
      // Trim excess newlines around the block for clean output.
      const leading = before.replace(/\s*$/, '')
      const trailing = after.replace(/^\s*/, '')
      const sep1 = leading ? '\n\n' : ''
      const sep2 = trailing ? '\n\n' : '\n'
      return `${leading}${sep1}${block}${sep2}${trailing}`
    }
  }
  // No block yet — prepend one.
  if (!existing.trim()) return block + '\n'
  return `${block}\n\n${existing.replace(/^\s+/, '')}`
}

/** Toggle one preset on/off against the given catalog. Returns new CLAUDE.md. */
export function togglePreset(
  existing: string,
  presetId: string,
  catalog: CatalogPromptPreset[]
): string {
  const activeIds = readActivePresetIds(existing)
  const nextIds = activeIds.includes(presetId)
    ? activeIds.filter((id) => id !== presetId)
    : [...activeIds, presetId]
  const byId = new Map(catalog.map((p) => [p.id, p]))
  const active = nextIds
    .map((id) => byId.get(id))
    .filter((p): p is CatalogPromptPreset => p !== undefined)
  return writeManagedBlock(existing, active)
}

/**
 * Detect H1 sections OUTSIDE the managed block whose header matches a
 * preset's section. These were likely created by the old append-based
 * install flow and will collide with managed-block content. Returns the
 * distinct list of conflicting H1 headers found outside.
 */
export function findUnmanagedConflicts(
  claudeMd: string,
  catalog: CatalogPromptPreset[]
): string[] {
  // Strip the managed block so we only look outside.
  let outside = claudeMd
  const startMatch = outside.match(START_RE)
  if (startMatch && startMatch.index !== undefined) {
    const endIdx = outside.indexOf(END_MARK, startMatch.index)
    if (endIdx >= 0) {
      outside =
        outside.slice(0, startMatch.index) +
        outside.slice(endIdx + END_MARK.length)
    }
  }
  const knownSections = new Set(
    catalog.map((p) => p.section.trim().toLowerCase())
  )
  const found = new Set<string>()
  for (const line of outside.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*$/)
    if (!m) continue
    const header = m[1].trim()
    if (knownSections.has(header.toLowerCase())) found.add(header)
  }
  return Array.from(found)
}

/**
 * Remove H1 sections (and their bodies) from CLAUDE.md content outside the
 * managed block when their header matches one of `headers`. A section runs
 * from its `# Header` line until the next top-level heading or EOF.
 */
export function stripUnmanagedSections(
  claudeMd: string,
  headers: string[]
): string {
  if (headers.length === 0) return claudeMd
  const targets = new Set(headers.map((h) => h.trim().toLowerCase()))
  // Protect the managed block by splitting the file around it.
  const startMatch = claudeMd.match(START_RE)
  let before = claudeMd
  let block = ''
  let after = ''
  if (startMatch && startMatch.index !== undefined) {
    const endIdx = claudeMd.indexOf(END_MARK, startMatch.index)
    if (endIdx >= 0) {
      before = claudeMd.slice(0, startMatch.index)
      block = claudeMd.slice(startMatch.index, endIdx + END_MARK.length)
      after = claudeMd.slice(endIdx + END_MARK.length)
    }
  }
  const strip = (text: string): string => {
    const lines = text.split('\n')
    const out: string[] = []
    let skipping = false
    for (const line of lines) {
      const h1 = line.match(/^#\s+(.+?)\s*$/)
      if (h1) {
        skipping = targets.has(h1[1].trim().toLowerCase())
        if (skipping) continue
      } else if (skipping) {
        continue
      }
      out.push(line)
    }
    // Collapse runs of blank lines.
    return out.join('\n').replace(/\n{3,}/g, '\n\n')
  }
  const result = (block
    ? strip(before).replace(/\s*$/, '') + (before.trim() ? '\n\n' : '') + block + (after.trim() ? '\n\n' : '\n') + strip(after).replace(/^\s*/, '')
    : strip(before)
  ).replace(/^\s*\n+/, '').replace(/\n{3,}/g, '\n\n')
  return result.endsWith('\n') ? result : result + '\n'
}

/** Count how many active presets share a section with the given preset. */
export function conflictingSectionCount(
  existing: string,
  preset: CatalogPromptPreset,
  catalog: CatalogPromptPreset[]
): number {
  const activeIds = readActivePresetIds(existing)
  if (activeIds.includes(preset.id)) return 0
  const byId = new Map(catalog.map((p) => [p.id, p]))
  const key = preset.section.trim().toLowerCase()
  return activeIds
    .map((id) => byId.get(id))
    .filter((p): p is CatalogPromptPreset => !!p)
    .filter((p) => p.section.trim().toLowerCase() === key).length
}
