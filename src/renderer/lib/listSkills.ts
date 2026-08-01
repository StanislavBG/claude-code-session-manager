export interface SkillEntry {
  name: string
  path: string
  dir: string
  text: string
}

/**
 * Walks a skills root dir (e.g. ~/.claude/skills), returning every skill
 * found — either a direct subdir containing SKILL.md, or one level deeper
 * under a namespace dir (e.g. <root>/user/<name>/SKILL.md). Shared by
 * Skills.tsx (full listing) and GlobalControlsSection.tsx (count only) so
 * skill-discovery rules can't silently diverge between the two.
 */
export async function listSkillEntries(base: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  const skillsDir = await window.api.config.listDir(base, { dirsOnly: true })
  for (const e of skillsDir.entries) {
    const directSkill = await window.api.config.readText(`${e.path}/SKILL.md`)
    if (directSkill.exists) {
      entries.push({ name: e.name, path: `${e.path}/SKILL.md`, dir: e.path, text: directSkill.text })
      continue
    }
    const nested = await window.api.config.listDir(e.path, { dirsOnly: true })
    for (const ne of nested.entries) {
      const nestedSkill = await window.api.config.readText(`${ne.path}/SKILL.md`)
      if (nestedSkill.exists) {
        entries.push({ name: ne.name, path: `${ne.path}/SKILL.md`, dir: ne.path, text: nestedSkill.text })
      }
    }
  }
  return entries
}
