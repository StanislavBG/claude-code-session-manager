/**
 * Resolve an installed plugin's real on-disk skills directory and enumerate
 * its skills. Modern plugin installs live under the versioned cache
 * (`~/.claude/plugins/cache/<marketplace>/<plugin-id>/<version>/skills/`),
 * recorded as `installPath` in `installed_plugins.json`; the row's own
 * `installPath` is the only input.
 */
import { parseSkillMeta } from './skillFrontmatter'
import { listSkillEntries } from './listSkills'

export interface PluginSkillEntry {
  id: string
  name: string | null
  description: string | null
  dir: string
  path: string
  body: string
}

/** The plugin's skills dir under its own `installPath` (the row's path), or null when it has none. */
export async function resolveInstalledPluginSkillsDir(installPath: string): Promise<string | null> {
  const skillsDir = `${installPath}/skills`
  return (await window.api.config.exists(skillsDir)) ? skillsDir : null
}

export async function listPluginSkills(skillsDir: string): Promise<PluginSkillEntry[]> {
  const { entries } = await listSkillEntries(skillsDir, { nested: false })
  return entries.map((e) => {
    const meta = parseSkillMeta(e.text)
    return {
      id: e.name,
      name: meta.name,
      description: meta.description,
      dir: e.dir,
      path: e.path,
      body: meta.body,
    }
  })
}

export interface SkillEdge {
  from: string
  to: string
}

/**
 * O(n·m) where n = skills.length and m = average body length: for each of the
 * n skills, every other skill's id is tested against its body with a regex
 * scan (O(m) per test), so total work is O(n^2 · m).
 */
export function detectSkillEdges(skills: PluginSkillEntry[]): SkillEdge[] {
  const edges: SkillEdge[] = []
  const seen = new Set<string>()
  for (const a of skills) {
    for (const b of skills) {
      if (a.id === b.id) continue
      const escaped = b.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const patterns = [`/${escaped}\\b`, `\`${escaped}\``]
      if (b.id.length >= 4) patterns.push(`\\b${escaped}\\b`)
      const matches = patterns.some((p) => new RegExp(p, 'i').test(a.body))
      if (!matches) continue
      const key = `${a.id}->${b.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: a.id, to: b.id })
    }
  }
  return edges
}
