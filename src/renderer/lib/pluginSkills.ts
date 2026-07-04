/**
 * Resolve an installed plugin's real on-disk skills directory and enumerate
 * its skills. Modern plugin installs live under the versioned cache
 * (`~/.claude/plugins/cache/<marketplace>/<plugin-id>/<version>/skills/`),
 * resolved via `installed_plugins.json`'s `installPath` — not the flat
 * `~/.claude/plugins/<name>/skills/` layout, which is a legacy fallback.
 */
import { parseSkillMeta } from './skillFrontmatter'

export interface PluginSkillEntry {
  id: string
  name: string | null
  description: string | null
  dir: string
  path: string
  body: string
}

interface InstalledPluginsFile {
  plugins?: Record<string, Array<{ installPath?: string }>>
}

export async function resolveInstalledPluginSkillsDir(
  pluginName: string,
  pluginDirPath: string,
  home: string,
): Promise<string | null> {
  const flatSkillsDir = `${pluginDirPath}/skills`
  try {
    const flat = await window.api.config.listDir(flatSkillsDir, { dirsOnly: true })
    if (flat.ok && flat.entries.length > 0) return flatSkillsDir
  } catch {
    // fall through to cache-based resolution
  }

  let data: InstalledPluginsFile | null = null
  try {
    const r = await window.api.config.readJson(`${home}/.claude/plugins/installed_plugins.json`)
    if (r.exists && !r.parseError && r.data && typeof r.data === 'object') {
      data = r.data as InstalledPluginsFile
    }
  } catch {
    return null
  }
  if (!data?.plugins) return null

  const key = Object.keys(data.plugins).find(
    (k) => k === pluginName || k.startsWith(`${pluginName}@`),
  )
  if (!key) return null
  const installPath = data.plugins[key]?.[0]?.installPath
  if (!installPath) return null

  const cacheSkillsDir = `${installPath}/skills`
  const exists = await window.api.config.exists(cacheSkillsDir)
  return exists ? cacheSkillsDir : null
}

export async function listPluginSkills(skillsDir: string): Promise<PluginSkillEntry[]> {
  const listed = await window.api.config.listDir(skillsDir, { dirsOnly: true })
  const entries: PluginSkillEntry[] = []
  for (const e of listed.entries) {
    const skillMdPath = `${e.path}/SKILL.md`
    const r = await window.api.config.readText(skillMdPath)
    if (!r.exists) continue
    const meta = parseSkillMeta(r.text)
    entries.push({
      id: e.name,
      name: meta.name,
      description: meta.description,
      dir: e.path,
      path: skillMdPath,
      body: meta.body,
    })
  }
  return entries
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
