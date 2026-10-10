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

const READ_CONCURRENCY = 6

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
  // At most READ_CONCURRENCY readText calls in flight across the whole walk.
  let active = 0
  const waiting: Array<() => void> = []
  const read = async (path: string) => {
    if (active >= READ_CONCURRENCY) await new Promise<void>((r) => waiting.push(r))
    active++
    try {
      return await window.api.config.readText(path)
    } catch (e) {
      errors.push({ path, error: msg(e) })
      return null
    } finally {
      active--
      waiting.shift()?.()
    }
  }
  const perEntry = await Promise.all(
    (await list(base)).map(async (e): Promise<SkillEntry[]> => {
      const skillPath = `${e.path}/SKILL.md`
      const directSkill = await read(skillPath)
      if (directSkill?.exists) return [{ name: e.name, path: skillPath, dir: e.path, text: directSkill.text }]
      if (!nested) return []
      const found = await Promise.all(
        (await list(e.path)).map(async (ne): Promise<SkillEntry | null> => {
          const nestedPath = `${ne.path}/SKILL.md`
          const nestedSkill = await read(nestedPath)
          return nestedSkill?.exists
            ? { name: ne.name, path: nestedPath, dir: ne.path, text: nestedSkill.text }
            : null
        }),
      )
      return found.filter((x): x is SkillEntry => x !== null)
    }),
  )
  return { entries: perEntry.flat(), errors }
}
