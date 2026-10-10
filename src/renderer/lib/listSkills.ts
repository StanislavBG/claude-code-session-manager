export interface SkillEntry {
  name: string
  path: string
  dir: string
  text: string
}

export interface SkillListError {
  path: string
  error: string
}

export interface SkillListResult {
  entries: SkillEntry[]
  errors: SkillListError[]
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Walks a skills root dir (e.g. ~/.claude/skills), returning every skill
 * found — either a direct subdir containing SKILL.md, or one level deeper
 * under a namespace dir (e.g. <root>/user/<name>/SKILL.md) unless
 * `nested: false` (default true). The only skills-folder walker. Shared by
 * Skills.tsx (full listing) and GlobalControlsSection.tsx (count only) so
 * skill-discovery rules can't silently diverge between the two.
 *
 * Failures (listDir `ok: false`, rejected readText) are returned in `errors`
 * alongside whatever did list; callers decide how to surface them.
 */
export async function listSkillEntries(
  base: string,
  opts: { nested?: boolean } = {},
): Promise<SkillListResult> {
  const nested = opts.nested ?? true
  const entries: SkillEntry[] = []
  const errors: SkillListError[] = []
  const list = async (path: string) => {
    try {
      const r = await window.api.config.listDir(path, { dirsOnly: true })
      if (!r.ok) {
        errors.push({ path, error: r.error ?? 'failed to list directory' })
        return []
      }
      return r.entries
    } catch (e) {
      errors.push({ path, error: msg(e) })
      return []
    }
  }
  const read = async (path: string) => {
    try {
      return await window.api.config.readText(path)
    } catch (e) {
      errors.push({ path, error: msg(e) })
      return null
    }
  }
  for (const e of await list(base)) {
    const skillPath = `${e.path}/SKILL.md`
    const directSkill = await read(skillPath)
    if (directSkill?.exists) {
      entries.push({ name: e.name, path: skillPath, dir: e.path, text: directSkill.text })
      continue
    }
    if (!nested) continue
    for (const ne of await list(e.path)) {
      const nestedPath = `${ne.path}/SKILL.md`
      const nestedSkill = await read(nestedPath)
      if (nestedSkill?.exists) {
        entries.push({ name: ne.name, path: nestedPath, dir: ne.path, text: nestedSkill.text })
      }
    }
  }
  return { entries, errors }
}
