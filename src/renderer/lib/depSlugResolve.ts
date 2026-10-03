/**
 * depSlugResolve — renderer-side port of src/main/lib/depSlugResolve.cjs's
 * `dependsOn` slug-resolution rule, so the Scheduler UI can match a
 * bare-authored dependsOn entry (e.g. `web-export-preset-and-git`) to the
 * real, NN-prefixed job slug the allocator handed its sibling PRD (e.g.
 * `1-web-export-preset-and-git`). Renderer has zero production imports from
 * src/main, so the rule is mirrored here rather than imported.
 *
 * Resolution rule: exact slug match first; else bare-name match after
 * stripping one leading `NN-` prefix.
 */

/** Strip one leading `NN-` prefix, if present. */
export function bareSlug(slug: string): string {
  return String(slug ?? '').replace(/^\d+-/, '')
}

/**
 * Resolve `dep` against `candidateSlugs`: exact match wins outright;
 * otherwise every candidate whose bare name matches. Returns a (possibly
 * empty) array of matching candidate slugs.
 */
export function resolveDepSlug(dep: string, candidateSlugs: string[]): string[] {
  if (candidateSlugs.includes(dep)) return [dep]
  const bare = bareSlug(dep)
  return candidateSlugs.filter((slug) => bareSlug(slug) === bare)
}

/**
 * Rewrites each job's dependsOn entries to their single resolved slug, when
 * resolveDepSlug finds exactly one match. Entries with zero or multiple
 * matches are left as-authored. Never mutates its input; a job whose
 * dependsOn needed no rewrite is returned by the same object identity.
 */
export function canonicalizeDependsOn<J extends { slug: string; dependsOn?: string[] | null }>(
  jobs: J[],
): J[] {
  const allSlugs = new Set<string>()
  const byBare = new Map<string, string[]>()
  for (const job of jobs) {
    allSlugs.add(job.slug)
    const bare = bareSlug(job.slug)
    const list = byBare.get(bare)
    if (list) list.push(job.slug)
    else byBare.set(bare, [job.slug])
  }

  return jobs.map((job) => {
    const deps = job.dependsOn
    if (!deps || deps.length === 0) return job

    let changed = false
    const next = deps.map((dep) => {
      if (allSlugs.has(dep)) return dep
      const matches = byBare.get(bareSlug(dep))
      if (matches && matches.length === 1) {
        changed = true
        return matches[0]
      }
      return dep
    })

    return changed ? { ...job, dependsOn: next } : job
  })
}
